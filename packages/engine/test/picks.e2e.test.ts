/**
 * Picking takes through the engine API (mock GPU), the way the Takes page does it: a shot shows the final of the draft
 * it has picked. Switching picks never loses a final, and picking a draft again brings its final back, so the editor,
 * the Finals page, export and the reveal all use it again.
 */
import { checkTools } from "@nightshift/editor";
import { JobSchema, ProjectSchema, type FinalKind, type Job, type Project, type Take } from "@nightshift/contract";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { startEngine, type EngineHandle } from "../src/engine.js";
import { findFfmpeg } from "../src/media/ffmpeg.js";
import { defaultRecipesDir } from "../src/paths.js";
import { MockStepRunner } from "../src/runner/mock.js";
import type { StepContext, StepRequest, StepRunner } from "../src/runner/types.js";
import { sleep } from "../src/util.js";
import { Api } from "./flow.js";

const hasFfmpeg = !!(await findFfmpeg());
const canRender = hasFfmpeg && !!checkTools().chrome;

/** The instant mock GPU, except that finals wait at a gate while it is closed, so a test can pick during a render. */
class GatedRunner implements StepRunner {
  private readonly mock = new MockStepRunner(0);
  private gate: Promise<void> | undefined;

  /** Holds every final that starts from now on until the returned function is called. */
  hold(): () => void {
    let open!: () => void;
    this.gate = new Promise((resolve) => (open = resolve));
    return () => {
      this.gate = undefined;
      open();
    };
  }

  async run(req: StepRequest, ctx: StepContext) {
    if (req.step.startsWith("video_final_")) await this.gate;
    return this.mock.run(req, ctx);
  }
}

const runner = new GatedRunner();
let engine: EngineHandle;
let api: Api;

beforeAll(async () => {
  engine = await startEngine({ port: 0, dataDir: mkdtempSync(join(tmpdir(), "ns-picks-")), mock: true, mockSpeed: 0, runner, recipesDir: defaultRecipesDir(), log: () => undefined });
  api = new Api(engine.url);
  await api.install("unified-128-cuda");
});
afterAll(() => engine?.stop());

/** A one-shot project with two drafts. The first is picked, as the engine does for a shot's first draft. */
async function twoTakes(name: string): Promise<{ pid: string; shotId: string; take1: Take; take2: Take }> {
  const created = await api.call("POST", "/api/projects", ProjectSchema, { name, template: "cinematic_shot", aspect: "16:9", brief: { prompt: "A ferry leaves the pier at dusk" } });
  await api.run(`/api/projects/${created.id}/storyboard`);
  await api.settle(created.id);
  const shotId = (await api.project(created.id)).shots[0]!.id;
  await api.run(`/api/projects/${created.id}/shots/${shotId}/draft`, { seed: 1 });
  await api.run(`/api/projects/${created.id}/shots/${shotId}/draft`, { seed: 2 });
  const p = await api.project(created.id);
  const [take1, take2] = p.takes.filter((t) => t.shotId === shotId && t.rung === "draft");
  expect(p.shots[0]!.chosenDraftId).toBe(take1!.id);
  return { pid: p.id, shotId, take1: take1!, take2: take2! };
}

/**
 * Picks a draft the way the Takes page does: the whole shot list as the UI holds it, with the new pick. "stale" sends
 * the copy as it was, still naming the old final; "lean" leaves chosenFinalId out for the engine to decide.
 */
async function pick(pid: string, shotId: string, draftId: string, copy: "stale" | "lean" = "lean"): Promise<Project> {
  const p = await api.project(pid);
  const shots = p.shots.map((s) => {
    if (s.id !== shotId) return s;
    const { chosenFinalId, ...rest } = s;
    return { ...(copy === "stale" && chosenFinalId ? { ...rest, chosenFinalId } : rest), chosenDraftId: draftId };
  });
  return api.call("PATCH", `/api/projects/${pid}`, ProjectSchema, { shots });
}

async function finish(pid: string, shotId: string, draftId: string, kind: FinalKind): Promise<Take> {
  const job = await api.run(`/api/projects/${pid}/shots/${shotId}/final`, { draftId, kind, mode: "now" });
  return (await api.project(pid)).takes.find((t) => t.jobId === job.id)!;
}

/** Queues a final and waits until it is rendering. */
async function rendering(pid: string, shotId: string, draftId: string, kind: FinalKind): Promise<Job> {
  const queued = await api.job(`/api/projects/${pid}/shots/${shotId}/final`, { draftId, kind, mode: "now" });
  for (let i = 0; i < 400; i++) {
    const job = (await api.call("GET", `/api/jobs?projectId=${pid}`, z.array(JobSchema))).find((j) => j.id === queued.id)!;
    if (job.status === "running") return job;
    if (job.status !== "queued") throw new Error(`final ${job.status}`);
    await sleep(10);
  }
  throw new Error("the final never started");
}

/** What the shot shows: its picked draft, its final, and the clip the editor cut for it. */
function shown(p: Project, shotId: string) {
  const shot = p.shots.find((s) => s.id === shotId)!;
  return { draft: shot.chosenDraftId, final: shot.chosenFinalId, clip: p.timeline?.clips.find((c) => c.shotId === shotId)?.assetId };
}

const showsFinal = (draft: Take, final: Take) => ({ draft: draft.id, final: final.id, clip: final.videoAssetId });
const showsDraft = (draft: Take) => ({ draft: draft.id, final: undefined, clip: draft.videoAssetId });

const finalsOf = (p: Project) => p.takes.filter((t) => t.rung === "final").map((t) => [t.id, t.parentTakeId]);

describe.skipIf(!hasFfmpeg)("picking takes keeps each draft's final", { timeout: 120_000 }, () => {
  it("picking Take 2 and then Take 1 again brings Take 1's same-take final back, every time", async () => {
    const { pid, shotId, take1, take2 } = await twoTakes("back and forth");
    const final = await finish(pid, shotId, take1.id, "same_take");
    const before = await api.project(pid);
    expect(shown(before, shotId)).toEqual(showsFinal(take1, final));

    for (const copy of ["stale", "lean", "stale", "lean"] as const) {
      expect(shown(await pick(pid, shotId, take2.id, copy), shotId), `Take 2 (${copy} copy)`).toEqual(showsDraft(take2));
      const back = await pick(pid, shotId, take1.id, copy);
      expect(shown(back, shotId), `Take 1 again (${copy} copy)`).toEqual(showsFinal(take1, final));
      expect(finalsOf(back), "no final is lost").toEqual(finalsOf(before));
    }

    // Picking the picked draft again changes nothing.
    expect(shown(await pick(pid, shotId, take1.id, "stale"), shotId)).toEqual(showsFinal(take1, final));
    expect(shown(await pick(pid, shotId, take1.id, "lean"), shotId)).toEqual(showsFinal(take1, final));
  });

  it("the reveal follows the pick: refused on a draft with no final, made again once Take 1 is back", async () => {
    const { pid, shotId, take1, take2 } = await twoTakes("reveal follows");
    await finish(pid, shotId, take1.id, "same_take");
    const reveal = () => fetch(`${engine.url}/api/projects/${pid}/export`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ aspect: "9:16", kind: "reveal", shotId, quality: "preview" }) });
    await pick(pid, shotId, take2.id);
    expect((await reveal()).status).toBe(409);
    await pick(pid, shotId, take1.id);
    const res = await reveal();
    expect(res.status).toBe(202);
    const job = JobSchema.parse(await res.json());
    if (!canRender) return void (await api.call("POST", `/api/jobs/${job.id}/cancel`, JobSchema));
    const done = await api.wait(job.id);
    expect(done.status, done.error).toBe("done");
    expect(done.message).toMatch(/same take/);
  });

  it("a draft with a same-take final and a remaster shows its newest final again, whichever kind came last", async () => {
    const { pid, shotId, take1, take2 } = await twoTakes("same take and remaster");
    const same1 = await finish(pid, shotId, take1.id, "same_take");
    const remaster1 = await finish(pid, shotId, take1.id, "remaster");
    // A final takes over its shot when it finishes; picking the draft again shows that same final.
    expect(shown(await api.project(pid), shotId)).toEqual(showsFinal(take1, remaster1));

    await pick(pid, shotId, take2.id);
    const remaster2 = await finish(pid, shotId, take2.id, "remaster");
    const same2 = await finish(pid, shotId, take2.id, "same_take");
    expect(shown(await api.project(pid), shotId)).toEqual(showsFinal(take2, same2));

    for (let i = 0; i < 3; i++) {
      expect(shown(await pick(pid, shotId, take1.id), shotId)).toEqual(showsFinal(take1, remaster1));
      expect(shown(await pick(pid, shotId, take2.id, "stale"), shotId)).toEqual(showsFinal(take2, same2));
    }
    const p = await api.project(pid);
    expect(finalsOf(p)).toEqual([same1, remaster1, remaster2, same2].map((t) => [t.id, t.parentTakeId]));

    // A client that names one of the new draft's finals with the pick gets that one.
    const named = await api.call("PATCH", `/api/projects/${pid}`, ProjectSchema, { shots: p.shots.map((s) => ({ ...s, chosenDraftId: take1.id, chosenFinalId: same1.id })) });
    expect(shown(named, shotId)).toEqual(showsFinal(take1, same1));
  });

  it("a draft with two finals shows the newer one again", async () => {
    const { pid, shotId, take1, take2 } = await twoTakes("two finals");
    await finish(pid, shotId, take1.id, "same_take");
    const newer = await finish(pid, shotId, take1.id, "same_take");
    expect(shown(await api.project(pid), shotId)).toEqual(showsFinal(take1, newer));
    await pick(pid, shotId, take2.id, "stale");
    expect(shown(await pick(pid, shotId, take1.id, "stale"), shotId)).toEqual(showsFinal(take1, newer));
  });

  it("a final still rendering: it lands on its draft whenever that draft is picked, and never on another", async () => {
    const { pid, shotId, take1, take2 } = await twoTakes("still rendering");

    // Switched away while it renders: it finishes without taking over Take 2, and comes back with Take 1.
    let open = runner.hold();
    let job = await rendering(pid, shotId, take1.id, "same_take");
    expect(shown(await pick(pid, shotId, take2.id), shotId)).toEqual(showsDraft(take2));
    open();
    expect((await api.wait(job.id)).status).toBe("done");
    const first = (await api.project(pid)).takes.find((t) => t.jobId === job.id)!;
    expect(shown(await api.project(pid), shotId)).toEqual(showsDraft(take2));
    expect(shown(await pick(pid, shotId, take1.id), shotId)).toEqual(showsFinal(take1, first));

    // Switched away and back while it renders: Take 1 keeps its finished final until the new one is done.
    open = runner.hold();
    job = await rendering(pid, shotId, take1.id, "remaster");
    expect(shown(await pick(pid, shotId, take2.id), shotId)).toEqual(showsDraft(take2));
    expect(shown(await pick(pid, shotId, take1.id, "stale"), shotId)).toEqual(showsFinal(take1, first));
    open();
    expect((await api.wait(job.id)).status).toBe("done");
    const second = (await api.project(pid)).takes.find((t) => t.jobId === job.id)!;
    expect(shown(await api.project(pid), shotId)).toEqual(showsFinal(take1, second));

    // A draft whose only final is still rendering has none to show yet.
    open = runner.hold();
    job = await rendering(pid, shotId, take2.id, "same_take");
    expect(shown(await pick(pid, shotId, take2.id), shotId)).toEqual(showsDraft(take2));
    open();
    expect((await api.wait(job.id)).status).toBe("done");
    const third = (await api.project(pid)).takes.find((t) => t.jobId === job.id)!;
    expect(shown(await api.project(pid), shotId)).toEqual(showsFinal(take2, third));
    expect(shown(await pick(pid, shotId, take1.id), shotId)).toEqual(showsFinal(take1, second));
    expect(finalsOf(await api.project(pid))).toEqual([first, second, third].map((t) => [t.id, t.parentTakeId]));
  });
});
