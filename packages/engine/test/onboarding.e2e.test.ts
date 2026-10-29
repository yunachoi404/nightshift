/**
 * Setup is the engine's fact, kept in its data dir, not a browser's. The "First shot" sample is made at most once per
 * data dir: clients asking at the same time, a client asking again after a reconnect or a remount, and an engine
 * restart in the middle all get the same project back, and its jobs are submitted once.
 */
import { JobSchema, OnboardingSampleSchema, OnboardingSchema, ProjectSchema, type Job, type Project } from "@nightshift/contract";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { startEngine, type EngineHandle } from "../src/engine.js";
import { MockStepRunner } from "../src/runner/mock.js";
import type { StepRunner } from "../src/runner/types.js";
import { sleep } from "../src/util.js";
import { Api } from "./flow.js";

const TIER = "unified-128-cuda";
const SAMPLE_IDEA = "A lone lighthouse on a cliff as a storm rolls in, waves hitting the rocks";

/** While set, still steps wait for it (or for the engine to stop). */
let hold: Promise<void> | null = null;
const mock = new MockStepRunner(0);
const runner: StepRunner = {
  run: async (req, ctx) => {
    if (req.step === "still" && hold) await held(hold, ctx.signal);
    return mock.run(req, ctx);
  },
};

/**
 * Waits for `gate`, or rejects with the reason the job was stopped. Also when it was stopped before the step got here:
 * an abort listener added after the abort never fires, and the engine's stop would wait for this step forever.
 */
function held(gate: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return Promise.race([gate, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
}

async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last value ${JSON.stringify(v)}`);
    await sleep(10);
  }
}

const running: EngineHandle[] = [];
afterEach(async () => {
  hold = null;
  await Promise.all(running.splice(0).map((e) => e.stop()));
});

/** An engine on a data dir, in mock mode. */
async function engine(dataDir = mkdtempSync(join(tmpdir(), "ns-onboard-"))) {
  const handle = await startEngine({ port: 0, dataDir, mock: true, mockSpeed: 0, runner, log: () => undefined });
  running.push(handle);
  const api = new Api(handle.url);
  return {
    dataDir,
    api,
    async stop() {
      running.splice(running.indexOf(handle), 1);
      await handle.stop();
    },
    onboarding: () => api.call("GET", "/api/onboarding", OnboardingSchema),
    sample: (body: { again?: boolean } = {}) => api.call("POST", "/api/onboarding/sample", OnboardingSampleSchema, body),
    done: () => api.call("POST", "/api/onboarding/done", OnboardingSchema),
    projects: () => api.call("GET", "/api/projects", z.array(ProjectSchema)),
    jobs: async (projectId: string) => (await api.call("GET", `/api/jobs?projectId=${projectId}`, z.array(JobSchema))).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  };
}

const samples = (projects: Project[]) => projects.filter((p) => p.name === "First shot");
const steps = (jobs: Job[]) => jobs.map((j) => j.step);
const settled = (jobs: Job[]) => jobs.every((j) => j.status !== "queued" && j.status !== "running");

describe("onboarding", () => {
  it("a new data dir is not set up, and the sample is made once however many clients ask at the same time", async () => {
    const e = await engine();
    await e.api.install(TIER);
    expect(await e.onboarding()).toEqual({ done: false, sampleProjectId: null });

    const answers = await Promise.all(Array.from({ length: 6 }, () => e.sample()));
    const id = answers[0]!.project!.id;
    expect(new Set(answers.map((a) => a.project?.id))).toEqual(new Set([id]));
    expect(answers.every((a) => a.onboarding.sampleProjectId === id && !a.onboarding.done)).toBe(true);
    expect(answers[0]!.project).toMatchObject({ name: "First shot", template: "cinematic_shot", aspect: "16:9", brief: { idea: SAMPLE_IDEA } });

    // The engine runs the whole sample: shot list, still, then one motion draft.
    const jobs = await until(() => e.jobs(id), (js) => js.length === 3 && settled(js));
    expect(steps(jobs)).toEqual(["text", "still", "video_draft"]);
    expect(jobs.every((j) => j.status === "done")).toBe(true);
    expect((await e.api.project(id)).takes.filter((t) => t.rung === "draft")).toHaveLength(1);

    // A client that remounts or reconnects asks again: the same project, and nothing new is submitted.
    expect((await e.sample()).project?.id).toBe(id);
    await sleep(100);
    expect(await e.jobs(id)).toHaveLength(3);
    expect(samples(await e.projects())).toHaveLength(1);
  });

  it("an engine restart in the middle of the sample gives the same project back and submits nothing twice", async () => {
    hold = new Promise(() => undefined);
    let e = await engine();
    await e.api.install(TIER);
    const first = (await e.sample()).project!;
    await until(() => e.jobs(first.id), (js) => js.some((j) => j.step === "still" && j.status === "running"));
    await e.stop();

    hold = null;
    e = await engine(e.dataDir);
    expect(await e.onboarding()).toEqual({ done: false, sampleProjectId: first.id });
    // The client reconnects and asks again, from two tabs.
    const again = await Promise.all([e.sample(), e.sample()]);
    expect(again.map((a) => a.project?.id)).toEqual([first.id, first.id]);

    const jobs = await until(() => e.jobs(first.id), (js) => js.length === 3 && settled(js));
    expect(steps(jobs)).toEqual(["text", "still", "video_draft"]);
    expect(samples(await e.projects())).toHaveLength(1);
  });

  it("a sample whose start was cut short gets its shot list, once", async () => {
    let e = await engine();
    await e.api.install(TIER);
    // The engine stopped after keeping the sample and before queueing its shot list.
    const sample = await e.api.call("POST", "/api/projects", ProjectSchema, { name: "First shot", template: "cinematic_shot", aspect: "16:9", brief: { idea: SAMPLE_IDEA, cameraMove: "dolly_in", look: "dawn", sequence: "one" } });
    await e.stop();
    writeFileSync(join(e.dataDir, "onboarding.json"), JSON.stringify({ done: false, sampleProjectId: sample.id }));

    e = await engine(e.dataDir);
    const answers = await Promise.all([e.sample(), e.sample()]);
    expect(answers.map((a) => a.project?.id)).toEqual([sample.id, sample.id]);
    const jobs = await until(() => e.jobs(sample.id), (js) => js.length === 3 && settled(js));
    expect(steps(jobs)).toEqual(["text", "still", "video_draft"]);
  });

  it("a deleted sample is not made again, unless the user asks for another", async () => {
    const e = await engine();
    await e.api.install(TIER);
    const first = (await e.sample()).project!;
    await until(() => e.jobs(first.id), (js) => js.length === 3 && settled(js));
    await e.api.call("DELETE", `/api/projects/${first.id}`, null);

    const after = await e.sample();
    expect(after).toEqual({ onboarding: { done: false, sampleProjectId: first.id }, project: null });
    expect(await e.projects()).toEqual([]);

    const another = await e.sample({ again: true });
    expect(another.project?.id).toBeTruthy();
    expect(another.project?.id).not.toBe(first.id);
    expect(another.onboarding.sampleProjectId).toBe(another.project?.id);
    expect(samples(await e.projects())).toHaveLength(1);
  });

  it("setup done is kept in the data dir: a restart sees it, and no sample is made after it", async () => {
    let e = await engine();
    await e.api.install(TIER);
    expect(await e.done()).toEqual({ done: true, sampleProjectId: null });
    await e.stop();

    e = await engine(e.dataDir);
    expect(await e.onboarding()).toEqual({ done: true, sampleProjectId: null });
    expect(await e.sample()).toEqual({ onboarding: { done: true, sampleProjectId: null }, project: null });
    expect(await e.projects()).toEqual([]);
  });

  it("finishing setup stops the sample where it is: no draft is queued after the user skipped ahead", async () => {
    hold = new Promise(() => undefined);
    const e = await engine();
    await e.api.install(TIER);
    const sample = (await e.sample()).project!;
    await until(() => e.jobs(sample.id), (js) => js.some((j) => j.step === "still" && j.status === "running"));
    await e.done();
    hold = null;
    // Release the held still: stop and start again, the still runs to the end.
    await e.stop();
    const again = await engine(e.dataDir);
    const jobs = await until(() => again.jobs(sample.id), (js) => js.length === 2 && settled(js));
    await sleep(100);
    expect(steps(await again.jobs(sample.id))).toEqual(["text", "still"]);
    expect(jobs.every((j) => j.status === "done")).toBe(true);
  });

  it("a project of the user's own finishes setup", async () => {
    const e = await engine();
    await e.api.install(TIER);
    await e.api.call("POST", "/api/projects", ProjectSchema, { name: "My film", template: "cinematic_shot", aspect: "16:9", brief: { idea: "a fox in the snow" } });
    expect(await e.onboarding()).toEqual({ done: true, sampleProjectId: null });
    expect((await e.sample()).project).toBeNull();
    expect(samples(await e.projects())).toEqual([]);
  });

  it("a data dir set up before the engine kept this reads as set up, and keeps its sample", async () => {
    let e = await engine();
    await e.api.install(TIER);
    // What the app used to make by itself, and a project of the user's own.
    const sample = await e.api.call("POST", "/api/projects", ProjectSchema, { name: "First shot", template: "cinematic_shot", aspect: "16:9", brief: { idea: SAMPLE_IDEA, cameraMove: "dolly_in", look: "dawn", sequence: "one" } });
    await e.api.call("POST", "/api/projects", ProjectSchema, { name: "My film", template: "cinematic_shot", aspect: "16:9", brief: { idea: "a fox in the snow" } });
    await e.stop();
    rmSync(join(e.dataDir, "onboarding.json"));

    e = await engine(e.dataDir);
    expect(await e.onboarding()).toEqual({ done: true, sampleProjectId: sample.id });
    expect((await e.sample()).project?.id).toBe(sample.id);
    expect(samples(await e.projects())).toHaveLength(1);
  });

  it("a data dir with no projects yet reads as not set up", async () => {
    const e = await engine();
    expect(await e.onboarding()).toEqual({ done: false, sampleProjectId: null });
  });
});
