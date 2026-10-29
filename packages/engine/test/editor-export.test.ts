/**
 * The engine with the editor wired in, on the model lab's real recipes (mock GPU): shot sizes per aspect, what a
 * same-take final is given, who owns the timeline, upload roles, exports that respect edits, cancelling an export.
 * Every step request is recorded, so the tests see exactly what each workflow would receive.
 */
import { JobSchema, ProjectSchema, type Aspect, type Project, type Timeline, type WorkflowRef } from "@nightshift/contract";
import { checkTools } from "@nightshift/editor";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { bindWorkflow, type Graph } from "../src/comfy/bind.js";
import { startEngine, type EngineHandle } from "../src/engine.js";
import { findFfmpeg, probeMedia } from "../src/media/ffmpeg.js";
import { placeholderMusic } from "../src/media/wav.js";
import { encodePng } from "../src/media/png.js";
import { defaultRecipesDir, defaultWorkflowsDir } from "../src/paths.js";
import { REMASTER_REFERENCE } from "../src/projects/service.js";
import { MockStepRunner } from "../src/runner/mock.js";
import type { StepRequest, StepRunner } from "../src/runner/types.js";
import { sleep } from "../src/util.js";
import { Api } from "./flow.js";

const tools = checkTools();
const canRender = !!(await findFfmpeg()) && !!tools.chrome;
const dataDir = mkdtempSync(join(tmpdir(), "ns-editor-"));
const calls: StepRequest[] = [];
const mock = new MockStepRunner(0);
const runner: StepRunner = { run: (req, ctx) => (calls.push(structuredClone(req)), mock.run(req, ctx)) };

let engine: EngineHandle;
let api: Api;

beforeAll(async () => {
  engine = await startEngine({ port: 0, dataDir, mock: true, mockSpeed: 0, recipesDir: defaultRecipesDir(), runner, log: () => undefined });
  api = new Api(engine.url);
});
afterAll(() => engine?.stop());

const recipe = (tier: string) => JSON.parse(readFileSync(join(defaultRecipesDir(), `${tier}.json`), "utf8")) as { steps: Record<string, WorkflowRef> };
const graph = (ref: WorkflowRef) => JSON.parse(readFileSync(join(defaultWorkflowsDir(), ref.workflow), "utf8")) as Graph;
/** Project of each job run through `run`, and the newest step request of a kind for a project. */
const jobsOf = new Map<string, string>();
const last = (step: string, projectId: string) => [...calls].reverse().find((c) => c.step === step && jobsOf.get(c.jobId) === projectId)!;
const size = (c: StepRequest) => [c.values.width, c.values.height];

async function project(template: Project["template"], aspect: Aspect, brief: Record<string, unknown>): Promise<Project> {
  const p = await api.call("POST", "/api/projects", ProjectSchema, { name: `${template} ${aspect}`, template, aspect, brief });
  await api.run(`/api/projects/${p.id}/storyboard`);
  await api.settle(p.id);
  return api.project(p.id);
}

/** Run a job and remember which project its step requests belong to. */
async function run(path: string, body: unknown = {}) {
  const queued = await api.job(path, body);
  jobsOf.set(queued.id, queued.projectId);
  const job = await api.wait(queued.id);
  expect(job.status, job.error).toBe("done");
  return job;
}

describe.skipIf(!(await findFfmpeg()))("native aspect shots from the real recipes", { timeout: 120_000 }, () => {
  it("passes the chosen voice design to Breeze instead of always using its default", async () => {
    await api.install("unified-128-cuda");
    const p = await project("talking_intro", "16:9", { script: "Welcome to the workshop." });
    await run(`/api/projects/${p.id}/audio`, { role: "voice", text: "Welcome to the workshop.", voice: "theo" });
    const request = last("voice", p.id);
    const bound = bindWorkflow(graph(request.ref), request.ref, request.values);
    expect(bound.graph["2"]!.inputs.instruction).toBe("A bright clear adult male voice speaking natural American English. Upbeat, lively and friendly.");
  });
  it("honors an explicit voice instruction over the named voice's default", async () => {
    await api.install("unified-128-cuda");
    const p = await project("talking_intro", "16:9", { script: "Welcome to the workshop." });
    const instruction = "A calm adult male voice. Speak slowly and leave a pause between sentences.";
    await run(`/api/projects/${p.id}/audio`, { role: "voice", text: "Welcome to the workshop.", voice: "theo", prompt: instruction });
    const request = last("voice", p.id);
    const bound = bindWorkflow(graph(request.ref), request.ref, request.values);
    expect(bound.graph["2"]!.inputs.instruction).toBe(instruction);
  });
  it("routes an uploaded product photo to a workflow that actually consumes it", async () => {
    await api.install("unified-128-cuda");
    let p = await project("cinematic_shot", "16:9", { idea: "A red mug" });
    const photo = await api.upload(p.id, encodePng(16, 16, new Uint8Array(16 * 16 * 4).fill(255)), "mug.png", "image/png", "reference");
    p = await api.call("PATCH", `/api/projects/${p.id}`, ProjectSchema, { brief: { ...p.brief, referenceAssetId: photo.id } });
    await run(`/api/projects/${p.id}/shots/${p.shots[0]!.id}/still`);
    const request = last("still", p.id);
    expect(request.ref.workflow).toBe("references_klein4b.api.json");
    expect(request.values.image).toContain(photo.id);
    const bound = bindWorkflow(graph(request.ref), request.ref, request.values);
    expect(bound.files).toEqual([{ name: "image", node: "10", field: "image", path: request.values.image }]);
    expect(bound.graph["21"]!.inputs.latent).toEqual(["13", 0]);
  });
  // LTX 2.5's draft is 640x384 (its graph's Primitive nodes), the same take upscales the latent 2x, H3 renders at about the final's size.
  // Krea's 768x768 still takes the draft's shape. All LTX sizes sit on the 64 px grid.
  const expected: Record<Aspect, { still: number[]; draft: number[]; final: number[]; remaster: number[] }> = {
    "16:9": { still: [960, 576], draft: [640, 384], final: [1280, 768], remaster: [1280, 768] },
    "9:16": { still: [576, 960], draft: [384, 640], final: [768, 1280], remaster: [768, 1280] },
    "1:1": { still: [768, 768], draft: [512, 512], final: [1024, 1024], remaster: [960, 960] },
  };

  for (const aspect of ["16:9", "9:16", "1:1"] as const) {
    it(`unified-128-cuda, ${aspect}: stills, drafts and finals are made in the project's shape`, async () => {
      await api.install("unified-128-cuda");
      let p = await project("cinematic_shot", aspect, { idea: "a lighthouse in a storm" });
      const shot = p.shots[0]!;
      const still = await run(`/api/projects/${p.id}/shots/${shot.id}/still`, { seed: 3 });
      const draft = await run(`/api/projects/${p.id}/shots/${shot.id}/draft`, { seed: 5 });
      p = await api.project(p.id);
      const take = p.takes.find((t) => t.rung === "draft")!;
      const same = await run(`/api/projects/${p.id}/shots/${shot.id}/final`, { draftId: take.id, kind: "same_take", mode: "now" });
      const remaster = await run(`/api/projects/${p.id}/shots/${shot.id}/final`, { draftId: take.id, kind: "remaster", mode: "now" });
      p = await api.project(p.id);
      const dims = (assetId: string) => {
        const a = p.assets.find((x) => x.id === assetId)!;
        return [a.width, a.height];
      };
      const e = expected[aspect];
      expect(size(last("still", p.id))).toEqual(e.still);
      expect(size(last("video_draft", p.id))).toEqual(e.draft);
      expect(size(last("video_final_remaster", p.id))).toEqual(e.remaster);
      for (const v of [...e.draft, ...e.still]) expect(v % 64).toBe(0);
      // The mock renders what it is asked for, so the assets show the sizes too.
      expect(dims(still.outputAssetIds[0]!)).toEqual(e.still);
      expect(dims(draft.outputAssetIds[0]!)).toEqual(e.draft);
      expect(dims(same.outputAssetIds[0]!)).toEqual(e.final);
      expect(dims(remaster.outputAssetIds[0]!)).toEqual(e.remaster);
    });
  }

  it("apple-64 (LTX bf16, Krea on MPS) and nvidia-8 (Kandinsky 6 Lite, MOSS) use their own workflows' sizes", async () => {
    await api.install("apple-64");
    let p = await project("cinematic_shot", "9:16", { idea: "a pier at night" });
    await run(`/api/projects/${p.id}/shots/${p.shots[0]!.id}/still`, { seed: 1 });
    await run(`/api/projects/${p.id}/shots/${p.shots[0]!.id}/draft`, { seed: 1 });
    expect([size(last("still", p.id)), size(last("video_draft", p.id))]).toEqual([
      [576, 960],
      [384, 640],
    ]);

    await api.install("nvidia-8");
    for (const [aspect, still, draft] of [
      ["16:9", [960, 640], [384, 256]],
      ["9:16", [640, 960], [256, 384]],
      ["1:1", [768, 768], [320, 320]],
    ] as const) {
      p = await project("cinematic_shot", aspect, { idea: "a pier at night" });
      await run(`/api/projects/${p.id}/shots/${p.shots[0]!.id}/still`, { seed: 1 });
      await run(`/api/projects/${p.id}/shots/${p.shots[0]!.id}/draft`, { seed: 1 });
      expect([size(last("still", p.id)), size(last("video_draft", p.id))]).toEqual([still, draft]);
    }
    await api.install("unified-128-cuda");
  });
});

describe.skipIf(!(await findFfmpeg()))("a same-take final gets exactly what its draft was made from", { timeout: 120_000 }, () => {
  it("prompt, negative prompt, still and seed come from the draft even after the shot changed", async () => {
    await api.install("unified-128-cuda");
    let p = await project("cinematic_shot", "16:9", { idea: "a lighthouse in a storm", look: "noir" });
    const shot = p.shots[0]!;
    await run(`/api/projects/${p.id}/shots/${shot.id}/draft`, { seed: 1234 });
    p = await api.project(p.id);
    const draft = p.takes.find((t) => t.rung === "draft")!;
    const draftCall = last("video_draft", p.id);
    const firstStill = p.shots[0]!.stillAssetId!;
    expect(draft).toMatchObject({ seed: 1234, prompt: draftCall.values.prompt, negative: "cartoon, video game, text, cuts, black frames", imageAssetId: firstStill });

    // The user rewrites the shot and makes a new still after approving the draft.
    await api.call("PATCH", `/api/projects/${p.id}`, ProjectSchema, { shots: [{ ...p.shots[0]!, prompt: "Something else entirely" }, ...p.shots.slice(1)] });
    await run(`/api/projects/${p.id}/shots/${shot.id}/still`, { seed: 99 });
    p = await api.project(p.id);
    expect(p.shots[0]!.stillAssetId).not.toBe(firstStill);

    await run(`/api/projects/${p.id}/shots/${shot.id}/final`, { draftId: draft.id, kind: "same_take", mode: "now" });
    const call = last("video_final_same_take", p.id);
    p = await api.project(p.id);
    const path = (assetId: string) => join(dataDir, "projects", p.id, p.assets.find((a) => a.id === assetId)!.path);
    expect(call.values).toMatchObject({ prompt: draft.prompt, negative: draft.negative, seed: 1234, image: path(firstStill), latent: path(draft.latentAssetId!), video: path(draft.videoAssetId!) });
    const final = p.takes.find((t) => t.rung === "final")!;
    expect(final).toMatchObject({ parentTakeId: draft.id, seed: 1234, prompt: draft.prompt, negative: draft.negative, imageAssetId: firstStill });

    // Bound into the recipe's own workflow, those land in the nodes the model lab named (LTX same take).
    const ref = recipe("unified-128-cuda").steps.video_final_same_take!;
    const bound = bindWorkflow(graph(ref), ref, call.values);
    expect(bound.graph["7"]!.inputs.text).toBe(draft.prompt);
    expect(bound.graph["8"]!.inputs.text).toBe(draft.negative);
    expect(bound.graph["15"]!.inputs.noise_seed).toBe(1234);
    expect(bound.files.map((f) => [f.name, `${f.node}.${f.field}`, f.path])).toEqual(
      expect.arrayContaining([
        ["image", "5.image", path(firstStill)],
        ["latent", "30.latent", path(draft.latentAssetId!)],
      ]),
    );
    // The draft's own graph used the same negative, so passing it explicitly changes nothing.
    const draftRef = recipe("unified-128-cuda").steps.video_draft!;
    expect(bindWorkflow(graph(draftRef), draftRef, draftCall.values).graph["8"]!.inputs.text).toBe(draft.negative);
  });

  it("a remaster points H3 at the draft with its reference tag, then gives the draft's prompt", async () => {
    let p = await project("cinematic_shot", "16:9", { idea: "a harbor at dawn" });
    await run(`/api/projects/${p.id}/shots/${p.shots[0]!.id}/draft`, { seed: 8 });
    p = await api.project(p.id);
    const draft = p.takes.find((t) => t.rung === "draft")!;
    await run(`/api/projects/${p.id}/shots/${p.shots[0]!.id}/final`, { draftId: draft.id, kind: "remaster", mode: "now" });
    const call = last("video_final_remaster", p.id);
    expect(call.values.prompt).toBe(`${REMASTER_REFERENCE} ${draft.prompt}`);
    const ref = recipe("unified-128-cuda").steps.video_final_remaster!;
    expect(bindWorkflow(graph(ref), ref, call.values).graph["8"]!.inputs.prompt).toMatch(/^Use <Video 1> as the exact composition/);
  });
});

describe.skipIf(!(await findFfmpeg()))("who owns the timeline", { timeout: 120_000 }, () => {
  it("the editor cuts it until it is edited; mirroring the plain cut is not an edit; new audio fits into an edit", async () => {
    await api.install("unified-128-cuda");
    const base = (p: Project) => `/api/projects/${p.id}`;
    let p = await project("talking_intro", "16:9", { script: "We make time for small things. Each week, one slow idea." });
    expect(p.timeline?.clips.map((c) => c.shotId)).toEqual(p.shots.map((s) => s.id));
    expect(p.timeline?.edited).toBeUndefined();

    // A UI that writes back the plain back-to-back cut (as the current one does) leaves it with the editor.
    let t = 0;
    const plain = p.shots.map((s) => {
      const clip = { shotId: s.id, assetId: s.stillAssetId!, start: t, in: 0, out: s.durationSec };
      t += s.durationSec;
      return clip;
    });
    p = await api.call("PATCH", base(p), ProjectSchema, { timeline: { ...p.timeline!, clips: plain } });
    expect(p.timeline!.edited).toBeUndefined();
    expect(p.timeline!.clips).toEqual(plain);
    // ... and a style change is not an edit either.
    p = await api.call("PATCH", base(p), ProjectSchema, { timeline: { ...p.timeline!, style: { ...p.timeline!.style, captionLook: "boxed" } } });
    expect(p.timeline!.edited).toBeUndefined();

    // Trimming a clip is an edit. A new voiceover then takes the voice track's place and brings its captions.
    const edited: Timeline = { ...p.timeline!, clips: [{ ...p.timeline!.clips[0]!, out: 1.5 }] };
    p = await api.call("PATCH", base(p), ProjectSchema, { timeline: edited });
    expect(p.timeline!.edited).toBe(true);
    await run(`${base(p)}/audio`, { role: "voice", text: "We make time for small things. Each week, one slow idea." });
    // The voice job makes the file; the analysis job after it times the words and puts it on the cut.
    const analysis = (await api.call("GET", `/api/jobs?projectId=${p.id}`, z.array(JobSchema))).find((j) => j.analysis && j.step === "voice")!;
    expect(analysis).toMatchObject({ step: "voice", analysis: true });
    expect((await api.wait(analysis.id)).status).toBe("done");
    p = await api.project(p.id);
    expect(p.timeline!.clips).toEqual(edited.clips);
    expect(p.timeline!.audio.map((a) => a.role)).toEqual(["voice"]);
    // The edit runs 1.5 s, so its captions stop there too: the words the cut has room for, in order.
    const said = p.timeline!.captions.map((c) => c.text).join(" ");
    expect(said.length).toBeGreaterThan(5);
    expect("We make time for small things. Each week, one slow idea.".startsWith(said)).toBe(true);
    for (const c of p.timeline!.captions) expect(c.end).toBeLessThanOrEqual(1.5 + 1e-6);
    expect(p.timeline!.style.captionLook).toBe("boxed");

    // Handing it back re-cuts around the voice: one shot per script line, the voice under them.
    p = await api.call("PATCH", base(p), ProjectSchema, { timeline: { ...p.timeline!, edited: false } });
    expect(p.timeline!.edited).toBeUndefined();
    expect(p.timeline!.clips.length).toBeGreaterThanOrEqual(2);
    expect(p.timeline!.audio.map((a) => a.role)).toEqual(["voice"]);
    expect(p.timeline!.style.captionLook).toBe("boxed");
  });

  it("an audio upload in a music video becomes the music track and the cut follows its beat", async () => {
    let p = await project("music_video", "9:16", { subject: "a night drive", genre: "synth", length: "30" });
    const song = await api.upload(p.id, placeholderMusic(16, "uploaded song"), "my-song.wav", "audio/wav");
    expect(song).toMatchObject({ kind: "audio", role: "music" });
    // Measured in the background: beats appear as markers, the song goes under the cut.
    for (let i = 0; i < 400 && !(await api.project(p.id)).timeline?.markers?.length; i++) await sleep(25);
    p = await api.project(p.id);
    expect(p.timeline!.audio).toEqual([expect.objectContaining({ assetId: song.id, role: "music" })]);
    expect(p.timeline!.markers!.filter((m) => m.kind === "beat").length).toBeGreaterThan(8);
    // Cuts land on beats.
    const beats = p.timeline!.markers!.map((m) => m.t);
    for (const c of p.timeline!.clips.slice(1)) expect(beats.some((b) => Math.abs(b - c.start) < 0.02)).toBe(true);
    // ?role= still wins over the default.
    const other = await api.upload(p.id, placeholderMusic(2, "x"), "voice-sample.wav", "audio/wav", "reference");
    expect(other.role).toBe("reference");
  });
});

describe.skipIf(!canRender)("exports", () => {
  it("respect a hand edit, rebuild on request, and stop cleanly when cancelled", async () => {
    await api.install("unified-128-cuda");
    let p = await project("cinematic_shot", "16:9", { idea: "a lighthouse in a storm", sequence: "three" });
    const base = `/api/projects/${p.id}`;
    // Keep only the first shot, two seconds of it.
    p = await api.call("PATCH", base, ProjectSchema, { timeline: { ...p.timeline!, clips: [{ ...p.timeline!.clips[0]!, start: 0, in: 0, out: 2 }], overlays: [] } });
    const edited = await run(`${base}/export`, { aspect: "1:1", quality: "preview" });
    p = await api.project(p.id);
    const file = (id: string) => join(dataDir, "projects", p.id, p.assets.find((a) => a.id === id)!.path);
    const short = await probeMedia(file(edited.outputAssetIds[0]!));
    expect(short).toMatchObject({ width: 540, height: 540 });
    expect(short.durationSec).toBeCloseTo(2, 0);
    expect(p.timeline!.edited).toBe(true);

    const rebuilt = await run(`${base}/export`, { aspect: "16:9", quality: "preview", rebuild: true });
    p = await api.project(p.id);
    expect(p.timeline!.edited).toBeUndefined();
    expect(p.timeline!.clips).toHaveLength(3);
    const full = await probeMedia(file(rebuilt.outputAssetIds[0]!));
    expect(full).toMatchObject({ width: 960, height: 540 });
    // Three shots of 4, 4 and 3.5 s, overlapped by two 0.5 s dissolves.
    expect(full.durationSec!).toBeCloseTo(4 + 4 + 3.5 - 1.0, 1);
    expect(rebuilt.message).toMatch(/^Exported 960x540, [\d.]+ s, \d+\.\d MB, /);

    // Cancel mid-render: the job ends cancelled, no export asset, no scratch left.
    const job = await api.job(`${base}/export`, { aspect: "9:16", quality: "standard" });
    for (let i = 0; i < 2000; i++) {
      const j = (await api.call("GET", `/api/jobs?projectId=${p.id}`, z.array(JobSchema))).find((x) => x.id === job.id)!;
      if (j.status === "running" && j.progress > 0.2) break;
      await sleep(25);
    }
    expect((await api.call("POST", `/api/jobs/${job.id}/cancel`, JobSchema)).status).toBe("cancelled");
    const exports = (await api.project(p.id)).assets.filter((a) => a.role === "export");
    expect(exports).toHaveLength(2);
    expect(existsSync(join(dataDir, "work", job.id))).toBe(false);
  }, 300_000);
});
