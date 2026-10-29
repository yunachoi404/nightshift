/**
 * Attach mode against a fake comfy-api-proxy that goes down and comes back, the way a shared GPU box's does: its ComfyUI
 * gives way to other work (the proxy stays up and answers 503), and the ssh tunnel to it can drop. Jobs wait for the GPU,
 * survive both, never run twice in ComfyUI when they can follow the job they started, and the app stays usable.
 */
import { JobSchema, ProjectSchema, RuntimeStatusSchema, type Job, type RuntimeStatus } from "@nightshift/contract";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { startEngine, type EngineHandle } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import { AttachRuntime, freePort } from "../src/runtime/runtime.js";
import { sleep } from "../src/util.js";
import { FakeProxy } from "./fakeProxy.js";
import { Api } from "./flow.js";

const ECHO_RECIPES = fileURLToPath(new URL("../fixtures/recipes-echo", import.meta.url));

async function until<T>(get: () => T | Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last value ${JSON.stringify(v)}`);
    await sleep(20);
  }
}

describe("AttachRuntime", () => {
  let proxy: FakeProxy | undefined;
  let runtime: AttachRuntime | undefined;
  afterEach(async () => {
    await runtime?.stop();
    await proxy?.close();
  });

  it("a proxy that never answered is a setup error", async () => {
    runtime = new AttachRuntime(new EventBus(), `http://127.0.0.1:${await freePort()}`, () => undefined, 20);
    await runtime.start("spark-echo");
    expect(runtime.status()).toMatchObject({ phase: "error", error: expect.stringContaining("is not answering") });
    expect(runtime.available()).toBe(false);
  });

  it("once attached it stays ready through outages, and says whether ComfyUI answers behind the proxy", async () => {
    proxy = await FakeProxy.start();
    runtime = new AttachRuntime(new EventBus(), proxy.url, () => undefined, 20);
    await runtime.start("spark-echo");
    expect(runtime.status()).toMatchObject({ phase: "ready", comfyui: { running: true } });
    expect(runtime.available()).toBe(true);

    // ComfyUI preempted: the proxy's own health route still says healthy, but ComfyUI is gone.
    proxy.comfyDown();
    expect(await (await fetch(`${proxy.url}/api/v2/health`)).json()).toMatchObject({ status: "healthy" });
    const r = runtime;
    let s = await until(() => r.status(), (x) => !x.comfyui.running);
    expect(s).toMatchObject({ phase: "ready", error: expect.stringContaining("ComfyUI is not answering") });
    expect(r.available()).toBe(false);

    // The tunnel drops too.
    await proxy.down();
    s = await until(() => r.status(), (x) => !!x.error?.includes("stopped answering"));
    expect(s).toMatchObject({ phase: "ready", comfyui: { running: false } });

    await proxy.up();
    proxy.comfyBack();
    s = await until(() => r.status(), (x) => x.comfyui.running);
    expect(s.phase).toBe("ready");
    expect(s.error).toBeUndefined();
    expect(r.available()).toBe(true);
  });
});

describe("the engine attached to a proxy that goes away and comes back", () => {
  let proxy: FakeProxy;
  let engine: EngineHandle;
  let api: Api;
  let projectId: string;

  beforeAll(async () => {
    proxy = await FakeProxy.start();
    const dataDir = mkdtempSync(join(tmpdir(), "ns-attach-"));
    mkdirSync(dataDir, { recursive: true });
    // Installed and set up before: the engine attaches on start.
    writeFileSync(join(dataDir, "settings.json"), JSON.stringify({ tier: "spark-echo", memoryLimitGb: null, overnight: { enabled: false, startAt: "23:00", endAt: "07:00" } }));
    writeFileSync(join(dataDir, "install.json"), JSON.stringify({ installed: { "spark-echo": "2026-10-19T00:00:00.000Z" } }));
    engine = await startEngine({ port: 0, dataDir, comfyBaseUrl: proxy.url, recipesDir: ECHO_RECIPES, attachCheckMs: 30, log: () => undefined });
    api = new Api(engine.url);
    await until(status, (s) => s.phase === "ready" && s.comfyui.running);
    const p = await api.call("POST", "/api/projects", ProjectSchema, { name: "Spark", template: "cinematic_shot", aspect: "16:9", brief: {} });
    const shots = [0, 1, 2].map((i) => ({ id: `shot_${i}`, index: i, prompt: `Shot ${i}`, durationSec: 3, locked: false }));
    projectId = (await api.call("PATCH", `/api/projects/${p.id}`, ProjectSchema, { shots })).id;
  });

  afterAll(async () => {
    await engine?.stop();
    await proxy?.close();
  });

  const status = (): Promise<RuntimeStatus> => api.call("GET", "/api/status", RuntimeStatusSchema);
  const jobs = (): Promise<Job[]> => api.call("GET", `/api/jobs?projectId=${projectId}`, z.array(JobSchema));
  const jobById = async (id: string) => (await jobs()).find((j) => j.id === id)!;
  const still = (shot: number) => api.job(`/api/projects/${projectId}/shots/shot_${shot}/still`, { seed: shot });

  it("a still waits for the GPU while ComfyUI is preempted, tries nothing, and runs when it is back", async () => {
    proxy.comfyDown();
    expect(await until(status, (s) => !s.comfyui.running)).toMatchObject({ phase: "ready", error: expect.stringContaining("ComfyUI is not answering") });
    const before = proxy.submitted.length;
    const job = await still(0);
    expect(await until(() => jobById(job.id), (j) => j.message === "Waiting for the GPU")).toMatchObject({ status: "queued" });
    // A long while later (many checks): still waiting, nothing sent to ComfyUI.
    await sleep(400);
    expect(await jobById(job.id)).toMatchObject({ status: "queued", message: "Waiting for the GPU" });
    expect(proxy.submitted.length).toBe(before);
    // The app keeps working meanwhile.
    await api.call("PATCH", `/api/projects/${projectId}`, ProjectSchema, { name: "Spark, renamed" });

    proxy.comfyBack();
    const done = await api.wait(job.id, 15_000);
    expect(done).toMatchObject({ status: "done", outputAssetIds: [expect.any(String)] });
    expect(proxy.submitted.length).toBe(before + 1);
    expect((await api.project(projectId)).shots[0]!.stillAssetId).toBe(done.outputAssetIds[0]);
  });

  it("the ssh tunnel drops mid-job: the job waits, then follows the same ComfyUI job instead of running it twice", async () => {
    proxy.hold = true;
    const before = proxy.submitted.length;
    const job = await still(1);
    await until(() => proxy.running().length, (n) => n === 1);
    await proxy.down();
    expect(await until(() => jobById(job.id), (j) => j.message === "Waiting for the GPU")).toMatchObject({ status: "queued" });
    expect(await status()).toMatchObject({ phase: "ready", comfyui: { running: false }, error: expect.stringContaining("stopped answering") });
    await sleep(200);
    expect((await jobById(job.id)).status).toBe("queued");

    await proxy.up();
    // Back on the same ComfyUI job: it is still running there. It finishes; nothing was submitted again.
    await until(() => jobById(job.id), (j) => j.status === "running");
    proxy.release();
    expect(await api.wait(job.id, 15_000)).toMatchObject({ status: "done" });
    expect(proxy.submitted.length).toBe(before + 1);
  });

  it("ComfyUI is preempted mid-job: the job waits, and is submitted again once ComfyUI is back", async () => {
    proxy.hold = true;
    const before = proxy.submitted.length;
    const job = await still(2);
    await until(() => proxy.running().length, (n) => n === 1);
    proxy.comfyDown();
    expect(await until(() => jobById(job.id), (j) => j.message === "Waiting for the GPU")).toMatchObject({ status: "queued" });
    expect(await status()).toMatchObject({ phase: "ready", comfyui: { running: false } });
    await sleep(200);

    proxy.hold = false;
    proxy.comfyBack(); // the old job is gone from ComfyUI ("expired")
    expect(await api.wait(job.id, 15_000)).toMatchObject({ status: "done" });
    expect(proxy.submitted.length).toBe(before + 2);
  });
});
