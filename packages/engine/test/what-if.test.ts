import { fallbackWhatIf, ProjectSchema, ShotSchema, StillRequestSchema, TakeSchema, whatIfExamples, WHAT_IF_FRAMES, WHAT_IF_INTERVAL, type Shot } from "@nightshift/contract";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bindWorkflow } from "../src/comfy/bind.js";
import { EventBus } from "../src/events.js";
import { placeholderScene } from "../src/media/png.js";
import { ProjectStore } from "../src/projects/store.js";
import { drawWhatIf, parseWhatIf, renderWhatIf, validateWhatIfProject, whatIfDraftSnapshot, writeWhatIf } from "../src/projects/what-if.js";
import type { JobPayload } from "../src/queue/store.js";
import type { ExecContext } from "../src/queue/queue.js";

const brief = { question: whatIfExamples[0], look: "cinematic" };

describe("What-if contract and story", () => {
  it("adds keyframes without changing old shot or take records", () => {
    expect(ShotSchema.parse({ id: "s", index: 0, prompt: "A room", durationSec: 4, locked: false }).keyframes).toBeUndefined();
    expect(TakeSchema.parse({ id: "t", shotId: "s", rung: "draft", seed: 1, jobId: "j" }).guideAssetIds).toBeUndefined();
    expect(StillRequestSchema.parse({ keyframeIndex: 3 })).toEqual({ keyframeIndex: 3 });
    expect(StillRequestSchema.safeParse({ keyframeIndex: 4 }).success).toBe(false);
  });

  it("has four beats and 35 to 50 words for all example fallbacks and a new question", () => {
    for (const question of [...whatIfExamples, "Thunderstorms", "Gravity!", "Forest!!", "What if every street turned into a river?", "What if " + "something ".repeat(30)]) {
      const story = fallbackWhatIf({ question });
      expect(story.keyframes).toHaveLength(4);
      expect(story.line.split(/\s+/).length).toBeGreaterThanOrEqual(35);
      expect(story.line.split(/\s+/).length).toBeLessThanOrEqual(50);
      expect(new Set(story.keyframes.map(frame => frame.id)).size).toBe(4);
      expect(story.durationSec).toBe(15);
      expect(parseWhatIf(JSON.stringify(story))).toEqual(story);
    }
  });

  it("rejects unusable writer answers instead of shipping an empty or overlong story", () => {
    const story = fallbackWhatIf(brief);
    expect(parseWhatIf("not JSON")).toBeUndefined();
    expect(parseWhatIf(JSON.stringify({ ...story, keyframes: story.keyframes.slice(0, 3) }))).toBeUndefined();
    expect(parseWhatIf(JSON.stringify({ ...story, keyframes: story.keyframes.map(frame => ({ ...frame, line: "Hi." })) }))).toBeUndefined();
    expect(parseWhatIf(JSON.stringify({ ...story, keyframes: story.keyframes.map(frame => ({ ...frame, line: "word ".repeat(20) })) }))).toBeUndefined();
  });

  it("binds four different images to ordered guides and saves the joint latent", async () => {
    const root = join(import.meta.dirname, "../../..");
    const graph = JSON.parse(await readFile(join(root, "workflows/ltx25_what_if.api.json"), "utf8"));
    const ref = JSON.parse(await readFile(join(root, "workflows/ltx25_what_if.api.ref.json"), "utf8"));
    const bound = bindWorkflow(graph, ref, { image: "/a.png", image2: "/b.png", image3: "/c.png", lastImage: "/d.png", frames: 361 });
    expect(bound.files.map(file => file.path)).toEqual(["/a.png", "/b.png", "/c.png", "/d.png"]);
    expect(["12", "107", "111", "33"].map(id => bound.graph[id]!.inputs.frame_idx)).toEqual([0, WHAT_IF_INTERVAL, WHAT_IF_INTERVAL * 2, -1]);
    expect(bound.graph["28"]!.inputs.value).toBe(WHAT_IF_FRAMES);
    expect(bound.graph["20"]!.class_type).toBe("NightshiftSaveAVLatent");
    expect(bound.graph["20"]!.inputs.samples).toEqual(["35", 0]);
  });

  it("raises the writer limit only when requested", async () => {
    const root = join(import.meta.dirname, "../../..");
    const graph = JSON.parse(await readFile(join(root, "workflows/text_shot_list.api.json"), "utf8"));
    const ref = JSON.parse(await readFile(join(root, "workflows/text_shot_list.api.ref.json"), "utf8"));
    expect(bindWorkflow(graph, ref, {}).graph["2"]!.inputs.max_length).toBe(384);
    expect(bindWorkflow(graph, ref, { maxTokens: 1024 }).graph["2"]!.inputs.max_length).toBe(1024);
  });
});

describe("What-if stage recovery", () => {
  it("writes a complete fallback when the writer fails, then resumes without replacing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "ns-what-if-writer-"));
    const store = new ProjectStore(join(root, "projects"), new EventBus(), () => undefined);
    await store.load();
    const project = await store.create({ name: "Gravity", template: "what_if", aspect: "9:16", brief });
    const payload: JobPayload = {};
    const ctx: ExecContext = { signal: new AbortController().signal, progress: () => undefined, remember: (key, value) => { payload[key] = value; } };
    let attempts = 0;
    const deps: Parameters<typeof writeWhatIf>[0] = { store, run: async () => { attempts++; throw new Error("writer offline"); } };
    const result = await writeWhatIf(deps, project, payload, ctx, true);
    expect(result.message).toContain("starter story");
    const saved = store.require(project.id);
    expect(saved.shots[0]!.keyframes).toHaveLength(4);
    expect(saved.shots[0]!.line!.split(/\s+/)).toHaveLength(40);
    await writeWhatIf(deps, saved, payload, ctx, true);
    expect(attempts).toBe(1);
    expect(store.require(project.id).shots[0]!.id).toBe(saved.shots[0]!.id);
  });

  it("reattaches to the interrupted edit and does not repeat completed images", async () => {
    const root = await mkdtemp(join(tmpdir(), "ns-what-if-"));
    const store = new ProjectStore(join(root, "projects"), new EventBus(), () => undefined);
    await store.load();
    const project = await store.create({ name: "Gravity", template: "what_if", aspect: "9:16", brief });
    const shot: Shot = { ...fallbackWhatIf(brief), id: "shot", index: 0, locked: false };
    await store.mutate(project.id, p => { p.shots = [shot]; });
    const payload: JobPayload = { whatIfFrames: shot.keyframes, seed: 12 };
    const ctx: ExecContext = { signal: new AbortController().signal, progress: () => undefined, remember: (key, value) => { payload[key] = value; } };
    const calls: { seed: number; resume: unknown; images: unknown[] }[] = [];
    let interrupted = false;
    const deps: Parameters<typeof drawWhatIf>[0] = { store, run: async (_step, values, _hints, request, context) => {
      const seed = Number(values.seed);
      calls.push({ seed, resume: request._comfyJobId, images: [values.image, values.image2] });
      context.remember("_comfyJobId", `remote-${seed}`);
      if (seed === 13 && !interrupted) { interrupted = true; throw new Error("connection lost"); }
      const path = join(root, `frame-${seed}.png`);
      await writeFile(path, placeholderScene(64, 64, String(seed)).toPng());
      return { outputs: [{ path, kind: "image", nodeId: "40" }] };
    } };
    await expect(drawWhatIf(deps, store.require(project.id), shot, payload, ctx)).rejects.toThrow("connection lost");
    const original = store.require(project.id).shots[0]!.keyframes![0]!.stillAssetId;
    expect(original).toBeTruthy();
    await drawWhatIf(deps, store.require(project.id), shot, payload, ctx);
    expect(calls.map(call => call.seed)).toEqual([12, 13, 13, 14, 15]);
    expect(calls[2]!.resume).toBe("remote-13");
    expect(store.require(project.id).assets).toHaveLength(4);
    const complete = store.require(project.id);
    expect(complete.shots[0]!.stillAssetId).toBe(original);
    expect(calls[3]!.images[1]).toBe(store.assetPath(complete, complete.assets[0]!));
    expect(() => validateWhatIfProject(complete)).not.toThrow();

    const snapshot = whatIfDraftSnapshot(complete, complete.shots[0]!);
    const oldPrompt = complete.shots[0]!.prompt;
    const oldIds = [...snapshot.whatIfGuideIds as string[]];
    const edited = ProjectSchema.parse(structuredClone(complete));
    edited.shots[0]!.prompt = "A different film.";
    edited.brief.look = "miniature";
    edited.aspect = "16:9";
    edited.shots[0]!.keyframes![0]!.stillAssetId = "missing";
    const inspect: Parameters<typeof drawWhatIf>[0] = { store, run: async (_step, values, hints) => {
      expect(String(values.prompt)).toContain(oldPrompt);
      expect(String(values.prompt)).not.toContain("A different film.");
      expect(values.image).toBe(store.assetPath(complete, complete.assets.find(asset => asset.id === oldIds[0])!));
      expect(hints.aspect).toBe("9:16");
      throw new Error("snapshot inspected");
    } };
    await expect(renderWhatIf(inspect, edited, edited.shots[0]!, { id: "j", projectId: edited.id, step: "video_what_if", mode: "now", status: "running", progress: 0, outputAssetIds: [], createdAt: "now" }, snapshot, ctx, "negative")).rejects.toThrow("snapshot inspected");
    expect(snapshot.whatIfGuideIds).toEqual(oldIds);
  });
});
