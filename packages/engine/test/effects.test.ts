import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { quickEffects, type Asset, type Project, type Job } from "@nightshift/contract";
import { bindWorkflow } from "../src/comfy/bind.js";
import { effectPhoto, effectPrompts, runEffect, runEffectFrame } from "../src/projects/effects.js";
import type { ProjectStore } from "../src/projects/store.js";
import type { ExecContext } from "../src/queue/queue.js";
import type { JobPayload } from "../src/queue/store.js";

const project = (): Project => ({ id: "p", name: "Bottle", template: "vfx_effect", aspect: "9:16", brief: { photoAssetId: "photo", effect: "freeze" }, assets: [{ id: "photo", path: "photo.png", kind: "image", createdAt: "now" }], shots: [{ id: "s", index: 0, prompt: "Bottle", durationSec: 4, locked: false }], takes: [], timeline: null, createdAt: "now", updatedAt: "now" });

describe("effect pipeline", () => {
  it("uploads the last image as an SDK file, rather than a local path string", () => {
    const result = bindWorkflow({ "1": { inputs: { image: "" } } }, { workflow: "effect", inputs: { lastImage: { node: "1", field: "image" } }, params: {}, outputNodes: ["1"] }, { lastImage: "/tmp/after.png" });
    expect(result.files).toEqual([{ name: "lastImage", node: "1", field: "image", path: "/tmp/after.png" }]);
  });
  it("has motion and valid end states for every visible preset, and rejects unknown ids", () => {
    for (const preset of quickEffects) {
      const prompts = effectPrompts({ effect: preset.id }, "the bottle");
      if (prompts.end !== null) expect(prompts.end).toContain("the bottle");
      expect(prompts.video).toContain("the bottle");
      expect(prompts.video).toContain("continuous");
    }
    const earth = effectPrompts({ effect: "earth_zoom" }, "the bottle");
    expect(earth.end).toBeNull();
    expect(earth.video).not.toContain("Locked-off");
    expect(() => effectPrompts({ effect: "typo" }, "")).toThrow("gallery");
    expect(() => effectPhoto({ ...project(), assets: [] })).toThrow("photo");
    const p = project(); p.assets[0]!.kind = "video";
    expect(() => effectPhoto(p)).toThrow("photo");
  });
  it("can render a queued end frame without replacing the source photo", async () => {
    const p = project();
    p.shots[0]!.stillAssetId = "photo";
    const store = {
      assetPath: () => "/input/photo.png",
      importFile: async () => ({ id: "after", kind: "image", path: "after.png", createdAt: "now" }),
      mutate: async (_: string, fn: (p: Project) => void) => { fn(p); return p; },
    } as unknown as ProjectStore;
    const result = await runEffectFrame({ store, run: async (step, values) => {
      expect(step).toBe("effect_end_frame");
      expect(values.image).toBe("/input/photo.png");
      return { outputs: [{ kind: "image", path: "/output/after.png", nodeId: "40" }], peakGb: 18.8 };
    } }, p, { seed: 42 }, { signal: new AbortController().signal, progress: () => undefined, remember: () => undefined }, { width: 384, height: 640 });
    expect(result).toMatchObject({ outputAssetIds: ["after"], peakGb: 18.8 });
    expect(p.shots[0]!.stillAssetId).toBe("photo");
  });
  it("animates levitation directly from the photo without an end-frame job", async () => {
    const p = project(); p.brief.effect = "levitate";
    const store = {
      assetPath: (_: Project, asset: Asset) => `/fixture/${asset.path}`,
      importFile: async (_: string, path: string, kind: Asset["kind"]) => ({ id: kind, kind, path, createdAt: "now" }),
      mutate: async (_: string, fn: (p: Project) => void) => { fn(p); return p; },
    } as unknown as ProjectStore;
    const steps: string[] = [];
    const result = await runEffect({ store, run: async (step, values) => {
      steps.push(step);
      expect(values.lastImage).toBeUndefined();
      expect(values.image).toBe("/fixture/photo.png");
      expect(values.prompt).toContain("levitates");
      return { outputs: [{ kind: "video", path: "take.mp4", nodeId: "25" }, { kind: "latent", path: "take.latent", nodeId: "20" }] };
    } }, p, p.shots[0]!, { id: "levitation" } as Job, { seed: 73 }, {
      signal: new AbortController().signal, progress: () => undefined, remember: () => undefined,
    }, { width: 384, height: 640 }, "no cuts");
    expect(steps).toEqual(["video_draft"]);
    expect(result.outputAssetIds).toEqual(["video", "latent"]);
    expect(p.takes[0]).toMatchObject({ rung: "draft", imageAssetId: "photo", latentAssetId: "latent" });
  });
  it("resumes the video after a failure without rendering the end frame again", async () => {
    const root = await mkdtemp(join(tmpdir(), "effect-resume-"));
    for (const file of ["photo.png", "end.png", "video.mp4", "draft.latent"]) await writeFile(join(root, file), "fixture");
    const p = project();
    const payload: JobPayload = { seed: 42 };
    const store = {
      assetPath: (_: Project, a: Asset) => join(root, a.path),
      findAsset: (_: Project, id: string) => p.assets.find((a) => a.id === id),
      importFile: async (_: string, path: string, kind: Asset["kind"]) => ({ id: kind, kind, path: path.split("/").at(-1)!, createdAt: "now" }),
      mutate: async (_: string, fn: (p: Project) => void) => { fn(p); return p; },
    } as unknown as ProjectStore;
    const ctx: ExecContext = { signal: new AbortController().signal, progress: () => undefined, remember: (key, value) => { payload[key] = value; } };
    const steps: string[] = [];
    let fail = true;
    const deps = { store, run: async (step: "effect_end_frame" | "video_effect" | "video_draft", values: Record<string, unknown>, _hints: unknown, checkpoint: JobPayload, stepCtx: ExecContext) => {
      steps.push(step);
      if (step === "effect_end_frame") {
        stepCtx.remember("_comfyJobId", "end-job");
        return { outputs: [{ path: join(root, "end.png"), kind: "image" as const, nodeId: "40" }] };
      }
      expect(values.lastImage).toBe(join(root, "end.png"));
      expect(checkpoint._comfyJobId).not.toBe("end-job");
      if (fail) { stepCtx.remember("_comfyJobId", "video-job"); throw new Error("connection lost"); }
      expect(checkpoint._comfyJobId).toBe("video-job");
      return { outputs: [{ path: join(root, "video.mp4"), kind: "video" as const, nodeId: "25" }, { path: join(root, "draft.latent"), kind: "latent" as const, nodeId: "20" }] };
    } };
    const job = { id: "job", projectId: "p", shotId: "s" } as Job;
    const invoke = () => runEffect(deps, p, p.shots[0]!, job, payload, ctx, { width: 384, height: 640 }, "no cuts");
    await expect(invoke()).rejects.toThrow("connection lost");
    fail = false;
    await invoke();
    expect(steps).toEqual(["effect_end_frame", "video_effect", "video_effect"]);
    expect(p.takes).toHaveLength(1);
    expect(p.takes[0]).toMatchObject({ imageAssetId: "photo", negative: "no cuts", latentAssetId: "latent", seed: 42 });
  });
});
