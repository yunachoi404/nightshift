/**
 * The engine on the model lab's real recipes (mock GPU), before its first runs on real models: long shots against the
 * measured frame limits, same-take finals that refuse to become a different take, song analysis as a queued job, and a
 * PATCH that crosses an engine re-cut. Every step request is recorded, so the tests see what each workflow would get.
 */
import { ErrorResponseSchema, JobSchema, ProjectSchema, SettingsSchema, type Aspect, type Job, type Project, type Recipe } from "@nightshift/contract";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { startEngine, type EngineHandle } from "../src/engine.js";
import { findFfmpeg } from "../src/media/ffmpeg.js";
import { placeholderMusic } from "../src/media/wav.js";
import { defaultRecipesDir } from "../src/paths.js";
import { MockStepRunner } from "../src/runner/mock.js";
import type { StepRequest, StepRunner } from "../src/runner/types.js";
import { sleep } from "../src/util.js";
import { Api } from "./flow.js";
import { EditorBridge } from "../src/projects/editor.js";

const hasFfmpeg = !!(await findFfmpeg());
const calls: StepRequest[] = [];
const mock = new MockStepRunner(0);
const runner: StepRunner = { run: (req, ctx) => (calls.push(structuredClone(req)), mock.run(req, ctx)) };
const jobsOf = new Map<string, string>();
const last = (step: string, projectId: string) => [...calls].reverse().find((c) => c.step === step && jobsOf.get(c.jobId) === projectId)!;

async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last value ${JSON.stringify(v)}`);
    await sleep(10);
  }
}

/** One engine on a recipes folder, in mock mode, recording every step request. */
function harness(recipesDir: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "ns-hard-"));
  const h = {
    dataDir,
    engine: undefined as EngineHandle | undefined,
    api: undefined as unknown as Api,
    async start() {
      h.engine = await startEngine({ port: 0, dataDir, mock: true, mockSpeed: 0, recipesDir, runner, log: () => undefined });
      h.api = new Api(h.engine.url);
    },
    async project(template: Project["template"], aspect: Aspect, brief: Record<string, unknown>): Promise<Project> {
      const p = await h.api.call("POST", "/api/projects", ProjectSchema, { name: `${template} ${aspect}`, template, aspect, brief });
      await h.api.run(`/api/projects/${p.id}/storyboard`);
      await h.api.settle(p.id);
      return h.api.project(p.id);
    },
    async run(path: string, body: unknown = {}): Promise<Job> {
      const queued = await h.api.job(path, body);
      jobsOf.set(queued.id, queued.projectId);
      const job = await h.api.wait(queued.id);
      expect(job.status, job.error).toBe("done");
      return job;
    },
    jobs: (projectId: string) => h.api.call("GET", `/api/jobs?projectId=${projectId}`, z.array(JobSchema)),
    file: (p: Project, assetId: string) => join(dataDir, "projects", p.id, p.assets.find((a) => a.id === assetId)!.path),
    /** Send a request that must fail with `status`; returns its error message. */
    async refused(path: string, body: unknown, status: number): Promise<string> {
      const res = await fetch(h.engine!.url + path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
      expect(res.status).toBe(status);
      return ErrorResponseSchema.parse(await res.json()).error;
    },
  };
  return h;
}

const main = harness(defaultRecipesDir());
beforeAll(async () => {
  await main.start();
  await main.api.install("unified-128-cuda");
});
afterAll(() => main.engine?.stop());

describe.skipIf(!hasFfmpeg)("long shots and the measured frame limits", { timeout: 120_000 }, () => {
  it("a shot longer than LTX's 97 frames is clamped to the clip, and the job says so; the remaster covers it on H3's grid", async () => {
    let p = await main.project("cinematic_shot", "16:9", { idea: "a lighthouse in a storm", sequence: "three" });
    const base = `/api/projects/${p.id}`;
    p = await main.api.call("PATCH", base, ProjectSchema, { shots: [{ ...p.shots[0]!, durationSec: 6 }, ...p.shots.slice(1)] });
    const draftJob = await main.run(`${base}/shots/${p.shots[0]!.id}/draft`, { seed: 3 });
    expect(draftJob.message).toBe("Draft ready. This model makes clips of at most 4.04 s, so the shot is 4.04 s now (it was 6 s).");
    expect(last("video_draft", p.id).values).toMatchObject({ frames: 97, durationSec: 4.04 });
    p = await main.api.project(p.id);
    expect(p.shots[0]!.durationSec).toBe(4.04);
    expect(p.assets.find((a) => a.id === draftJob.outputAssetIds[0])!.durationSec).toBeCloseTo(97 / 24, 1);

    const draft = p.takes.find((t) => t.rung === "draft")!;
    const remaster = await main.run(`${base}/shots/${p.shots[0]!.id}/final`, { draftId: draft.id, kind: "remaster", mode: "now" });
    expect(remaster.message).toBe("Remaster ready");
    // The first 17k+5 that covers 4.04 s at 24 fps, within H3's measured 124.
    expect(last("video_final_remaster", p.id).values.frames).toBe(107);
    // A shot within the limit keeps its length.
    const second = await main.run(`${base}/shots/${p.shots[2]!.id}/draft`, { seed: 4 });
    expect(second.message).toBe("Draft ready");
    expect((await main.api.project(p.id)).shots[2]!.durationSec).toBe(p.shots[2]!.durationSec);
  });

  it("a recipe's maxFrames replaces the measured limit, for drafts and for remasters", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-recipes-"));
    const recipe = JSON.parse(readFileSync(join(defaultRecipesDir(), "unified-128-cuda.json"), "utf8")) as Recipe;
    recipe.steps.video_draft!.params = { ...recipe.steps.video_draft!.params, maxFrames: 50 }; // snaps down to 49 on LTX's grid
    recipe.steps.video_final_remaster!.params = { ...recipe.steps.video_final_remaster!.params, maxFrames: 39 }; // 17 * 2 + 5
    writeFileSync(join(dir, "unified-128-cuda.json"), JSON.stringify(recipe));
    const h = harness(dir);
    await h.start();
    try {
      await h.api.install("unified-128-cuda");
      // The storyboard already plans every shot within the draft model's longest clip, and says so.
      let p = await h.project("cinematic_shot", "16:9", { idea: "a pier at night", sequence: "three" });
      expect(p.shots.map((x) => x.durationSec)).toEqual([2.04, 2.04, 2.04]);
      const storyboard = (await h.jobs(p.id)).find((j) => j.step === "text")!;
      expect(storyboard.message).toMatch(/Shots are at most 2.04 s, the longest clip this video model makes\.$/);
      const shot = p.shots[0]!;
      const draftJob = await h.run(`/api/projects/${p.id}/shots/${shot.id}/draft`, { seed: 1 });
      expect(last("video_draft", p.id).values.frames).toBe(49);
      expect(draftJob.message).toBe("Draft ready");
      p = await h.api.project(p.id);
      const draft = p.takes.find((t) => t.rung === "draft")!;
      // H3 at 39 frames is shorter still: the remaster clamps the shot again.
      const remaster = await h.run(`/api/projects/${p.id}/shots/${shot.id}/final`, { draftId: draft.id, kind: "remaster", mode: "now" });
      expect(last("video_final_remaster", p.id).values.frames).toBe(39);
      expect(remaster.message).toBe("Remaster ready. This model makes clips of at most 1.62 s, so the shot is 1.62 s now (it was 2.04 s).");
      expect((await h.api.project(p.id)).shots[0]!.durationSec).toBe(1.62);
    } finally {
      await h.engine?.stop();
    }
  });
});

describe.skipIf(!hasFfmpeg)("a same-take final is the same take, or it does not run", { timeout: 120_000 }, () => {
  it("is refused at once when the draft's latent or still is gone from the project", async () => {
    let p = await main.project("cinematic_shot", "16:9", { idea: "a harbor at dawn", sequence: "three" });
    const base = `/api/projects/${p.id}`;
    await main.run(`${base}/shots/${p.shots[0]!.id}/draft`, { seed: 1 });
    await main.run(`${base}/shots/${p.shots[1]!.id}/draft`, { seed: 2 });
    p = await main.api.project(p.id);
    const [d0, d1] = [p.shots[0]!, p.shots[1]!].map((s) => p.takes.find((t) => t.shotId === s.id && t.rung === "draft")!);

    rmSync(main.file(p, d0!.latentAssetId!));
    expect(await main.refused(`${base}/shots/${p.shots[0]!.id}/final`, { draftId: d0!.id, kind: "same_take", mode: "now" }, 409)).toBe(
      "This draft's saved latent is missing from the project folder, so it cannot be finished as the same take. Make a new draft, or finish this one as a remaster.",
    );
    // A remaster re-renders from the draft's video, so it is still possible.
    await main.run(`${base}/shots/${p.shots[0]!.id}/final`, { draftId: d0!.id, kind: "remaster", mode: "now" });

    rmSync(main.file(p, d1!.imageAssetId!));
    expect(await main.refused(`${base}/shots/${p.shots[1]!.id}/final`, { draftId: d1!.id, kind: "same_take", mode: "now" }, 409)).toMatch(
      /^The still this draft was made from is missing from the project folder, so it cannot be finished as the same take/,
    );
    expect((await main.api.project(p.id)).takes.filter((t) => t.finalKind === "same_take")).toEqual([]);
  });

  it("a queued one fails with the reason, rather than making a different take, when the latent is gone by the time it runs", async () => {
    let p = await main.project("cinematic_shot", "9:16", { idea: "a train at night" });
    const base = `/api/projects/${p.id}`;
    await main.run(`${base}/shots/${p.shots[0]!.id}/draft`, { seed: 5 });
    p = await main.api.project(p.id);
    const draft = p.takes.find((t) => t.rung === "draft")!;
    const queued = await main.api.job(`${base}/shots/${p.shots[0]!.id}/final`, { draftId: draft.id, kind: "same_take", mode: "overnight" });
    rmSync(main.file(p, draft.latentAssetId!));
    // Overnight mode on, all day: the final runs now.
    await main.api.call("PATCH", "/api/settings", SettingsSchema, { overnight: { enabled: true, startAt: "00:00", endAt: "00:00" } });
    try {
      const job = await main.api.wait(queued.id);
      expect(job).toMatchObject({ status: "failed", error: expect.stringMatching(/^This draft's saved latent is missing from the project folder/) });
      expect(calls.some((c) => c.jobId === queued.id)).toBe(false); // nothing went to the GPU
      expect((await main.api.project(p.id)).takes.some((t) => t.rung === "final")).toBe(false);
    } finally {
      await main.api.call("PATCH", "/api/settings", SettingsSchema, { overnight: { enabled: false, startAt: "23:00", endAt: "07:00" } });
    }
  });

  it("a draft that does not record the prompt it was made with cannot be finished as the same take", async () => {
    let p = await main.project("cinematic_shot", "1:1", { idea: "a lamp in the rain" });
    const base = `/api/projects/${p.id}`;
    await main.run(`${base}/shots/${p.shots[0]!.id}/draft`, { seed: 6 });
    // A draft from an engine that did not keep this record yet.
    await main.engine!.stop();
    const file = join(main.dataDir, "projects", p.id, "project.json");
    const stored = JSON.parse(readFileSync(file, "utf8")) as Project;
    for (const t of stored.takes) delete t.prompt;
    writeFileSync(file, JSON.stringify(stored));
    await main.start();
    p = await main.api.project(p.id);
    const draft = p.takes.find((t) => t.rung === "draft")!;
    expect(await main.refused(`${base}/shots/${p.shots[0]!.id}/final`, { draftId: draft.id, kind: "same_take", mode: "now" }, 409)).toMatch(
      /^This draft does not record the prompt it was made with, so it cannot be finished as the same take/,
    );
  });
});

describe.skipIf(!hasFfmpeg)("song analysis is a queued job", { timeout: 120_000 }, () => {
  it("shows in the queue on the CPU worker, can be cancelled running or queued, and measures the song when it runs", async () => {
    const p = await main.project("music_video", "9:16", { subject: "a night drive", genre: "synth", length: "30" });
    const analyses = async () => (await main.jobs(p.id)).filter((j) => j.analysis && j.step === "music");
    const analysisAfter = async (count: number) => (await until(analyses, (a) => a.length > count)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[count]!;
    const status = async (id: string) => (await main.jobs(p.id)).find((j) => j.id === id)!.status;

    await main.api.upload(p.id, placeholderMusic(240, "a long song"), "long.wav", "audio/wav");
    const first = await analysisAfter(0);
    await until(() => status(first.id), (s) => s === "running");
    // A second song while the first is measured: its analysis waits its turn on the CPU worker.
    await main.api.upload(p.id, placeholderMusic(16, "a short song"), "short.wav", "audio/wav");
    const second = await analysisAfter(1);
    expect(second).toMatchObject({ step: "music", analysis: true, status: "queued" });
    expect((await main.api.call("POST", `/api/jobs/${second.id}/cancel`, JobSchema)).status).toBe("cancelled");
    expect((await main.api.call("POST", `/api/jobs/${first.id}/cancel`, JobSchema)).status).toBe("cancelled");
    await sleep(100);
    expect((await main.api.project(p.id)).timeline?.markers ?? []).toEqual([]);

    const song = await main.api.upload(p.id, placeholderMusic(16, "the song"), "song.wav", "audio/wav");
    const job = await main.api.wait((await analysisAfter(2)).id);
    expect(job).toMatchObject({ status: "done", message: expect.stringMatching(/^Song measured: \d+ beats/) });
    const project = await main.api.project(p.id);
    expect(project.timeline!.audio).toEqual([expect.objectContaining({ assetId: song.id, role: "music" })]);
    expect(project.timeline!.markers!.filter((m) => m.kind === "beat").length).toBeGreaterThan(8);
  });
});

describe.skipIf(!hasFfmpeg)("a cut measured while drafts land", { timeout: 180_000 }, () => {
  it("keeps the drafts that landed while the song was measured", async () => {
    let p = await main.project("music_video", "16:9", { subject: "a night drive", genre: "synth", length: "30" });
    // Hold the old project snapshot explicitly. A long song only made the overlap likely,
    // and its real transcription could exceed the test timeout on a busy machine.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const captured = new Promise<void>((resolve) => { entered = resolve; });
    let intercepted = false;
    const assemble = EditorBridge.prototype.assemble;
    const gate = vi.spyOn(EditorBridge.prototype, "assemble").mockImplementation(async function (this: EditorBridge, project, options) {
      if (project.id === p.id && options.analyze && !intercepted) {
        intercepted = true;
        entered();
        await held;
      }
      return assemble.call(this, project, options);
    });
    try {
      await main.api.upload(p.id, placeholderMusic(8, "a song to measure"), "song.wav", "audio/wav");
      await captured;
      const analysis = await until(async () => (await main.jobs(p.id)).find((j) => j.analysis), (j) => j?.status === "running");
      const draft = await main.run(`/api/projects/${p.id}/shots/${p.shots[0]!.id}/draft`, { seed: 9 });
      release();
      expect((await main.api.wait(analysis!.id)).status).toBe("done");
      await main.api.settle(p.id);
      p = await main.api.project(p.id);
      const shot0 = p.timeline!.clips.filter((c) => c.shotId === p.shots[0]!.id);
      expect(shot0.length).toBeGreaterThan(0);
      expect(shot0.every((c) => c.assetId === draft.outputAssetIds[0])).toBe(true);
      expect(p.timeline!.markers!.some((m) => m.kind === "beat")).toBe(true);
    } finally {
      release();
      gate.mockRestore();
    }
  });
});

describe.skipIf(!hasFfmpeg)("a PATCH that crosses an engine re-cut", { timeout: 120_000 }, () => {
  it("keeps a caption style saved while a quick cut is being assembled", async () => {
    const p = await main.project("cinematic_shot", "9:16", { idea: "a quiet harbor" });
    const base = `/api/projects/${p.id}`;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const captured = new Promise<void>(resolve => { entered = resolve; });
    let intercepted = false;
    const assemble = EditorBridge.prototype.assemble;
    const gate = vi.spyOn(EditorBridge.prototype, "assemble").mockImplementation(async function (this: EditorBridge, project, options) {
      if (project.id === p.id && !options.analyze && !intercepted) {
        intercepted = true;
        entered();
        await held;
      }
      return assemble.call(this, project, options);
    });
    try {
      const pending = main.run(`${base}/shots/${p.shots[0]!.id}/draft`, { seed: 12 });
      await captured;
      const current = await main.api.project(p.id);
      await main.api.call("PATCH", base, ProjectSchema, { timeline: { ...current.timeline!, style: { ...current.timeline!.style, captionSize: 1.6 } } });
      release();
      await pending;
      expect((await main.api.project(p.id)).timeline!.style.captionSize).toBe(1.6);
    } finally {
      release();
      gate.mockRestore();
    }
  });

  it("is not taken for a hand edit: the newer cut stays and the style change lands", async () => {
    let p = await main.project("talking_intro", "16:9", { script: "We make time for small things. Each week, one slow idea." });
    const base = `/api/projects/${p.id}`;
    const read = p.timeline!; // what the UI holds
    expect(read.revision).toBeGreaterThan(0);
    // The engine cuts again: a draft lands for the first shot.
    await main.run(`${base}/shots/${p.shots[0]!.id}/draft`, { seed: 1 });
    p = await main.api.project(p.id);
    const recut = p.timeline!;
    expect(recut.revision).toBeGreaterThan(read.revision!);
    expect(recut.clips).not.toEqual(read.clips);

    // The UI saves a caption style on its old copy, spreading the timeline it holds.
    p = await main.api.call("PATCH", base, ProjectSchema, { timeline: { ...read, style: { ...read.style, captionLook: "boxed" } } });
    expect(p.timeline!.edited).toBeUndefined();
    expect(p.timeline!.clips).toEqual(recut.clips);
    expect(p.timeline!.style.captionLook).toBe("boxed");
    expect(p.timeline!.revision).toBe(recut.revision! + 1);

    // A real trim on the old copy is an edit, and it wins.
    p = await main.api.call("PATCH", base, ProjectSchema, { timeline: { ...read, clips: [{ ...read.clips[0]!, out: 1 }] } });
    expect(p.timeline).toMatchObject({ edited: true, clips: [{ ...read.clips[0]!, out: 1 }] });
  });
});
