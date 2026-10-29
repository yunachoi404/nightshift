/**
 * A GPU computer on the network, end to end: the engine starts for this machine, the user checks and picks the remote,
 * and every job goes through the real comfy-api-proxy (run here) into a fake remote ComfyUI over HTTP. Uploads (a
 * reference photo, the still, the draft and its saved latent for the same-take final) must arrive in the remote's input
 * folder. The remote goes away and comes back; the choice survives a restart; DELETE goes back to this machine.
 *
 * Needs uv (to install comfy-api-proxy once into a shared folder) and ffmpeg; skips itself without them.
 */
import { HardwareProfileSchema, JobSchema, ProjectSchema, RemoteCheckSchema, RuntimeStatusSchema, SettingsSchema, TierSummarySchema, type Job, type Project, type RuntimeStatus } from "@nightshift/contract";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { startEngine, type EngineHandle } from "../src/engine.js";
import { findUv } from "../src/install/comfyui.js";
import { installProxy } from "../src/install/proxy.js";
import { placeholderScene } from "../src/media/png.js";
import { sleep } from "../src/util.js";
import { FakeComfy } from "./fakeComfy.js";
import { Api } from "./flow.js";

const RECIPES = fileURLToPath(new URL("./fixtures/remote/recipes", import.meta.url));
const WORKFLOWS = fileURLToPath(new URL("./fixtures/remote/workflows", import.meta.url));
const NODE_TYPES = ["LoadImage", "UNETLoader", "CLIPTextEncode", "SaveImage", "RandomNoise", "LatentUpscaleModelLoader", "NightshiftSaveAVLatent", "SaveVideo", "NightshiftLoadAVLatent", "LoadVideo"];
/** comfy-api-proxy for every run of this test, installed once. */
const PROXY_VENV = join(tmpdir(), "nightshift-test-proxy", ".venv");
const ErrorSchema = z.object({ error: z.string() });

const ffmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const uv = await findUv();

async function until<T>(get: () => T | Promise<T>, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last value ${JSON.stringify(v)}`);
    await sleep(25);
  }
}

describe.skipIf(!uv || !ffmpeg)("a GPU computer on the network, through the real comfy-api-proxy", () => {
  let comfy: FakeComfy;
  let engine: EngineHandle;
  let api: Api;
  let dataDir: string;
  let projectId: string;
  /** The MP4 the fake remotes' video savers put out. */
  let video: string;
  const logs: string[] = [];
  const options = () => {
    const tools = mkdtempSync(join(tmpdir(), "ns-tools-"));
    const tool = (name: string) => {
      writeFileSync(join(tools, name), "");
      return join(tools, name);
    };
    // The editor's downloads count as present, so using the remote fetches nothing.
    const editorTools = { whisper: tool("whisper-cli"), whisperModel: tool("ggml-large-v3-turbo.bin"), whisperVad: tool("vad"), vadModel: tool("ggml-silero-v6.2.0.bin"), chrome: tool("chrome") };
    return { port: 0, dataDir, recipesDir: RECIPES, workflowsDir: WORKFLOWS, attachCheckMs: 100, editorTools, log: (m: string) => logs.push(m) };
  };
  const status = (): Promise<RuntimeStatus> => api.call("GET", "/api/status", RuntimeStatusSchema);
  const settings = () => api.call("GET", "/api/settings", SettingsSchema);
  const jobs = (): Promise<Job[]> => api.call("GET", `/api/jobs?projectId=${projectId}`, z.array(JobSchema));
  const jobById = async (id: string) => (await jobs()).find((j) => j.id === id)!;
  const refused = async (method: string, path: string, body: unknown, code: number) => {
    const res = await fetch(api.url + path, { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    expect(res.status, await res.clone().text()).toBe(code);
    return ErrorSchema.parse(await res.json()).error;
  };
  const inputBytes = (name: string) => readFileSync(join(comfy.inputDir, name));
  const assetBytes = (p: Project, assetId: string | undefined) => readFileSync(join(dataDir, "projects", p.id, p.assets.find((a) => a.id === assetId)!.path));

  beforeAll(async () => {
    await installProxy({ proxyVenv: PROXY_VENV, log: () => undefined });
    const work = mkdtempSync(join(tmpdir(), "ns-remote-"));
    video = join(work, "clip.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=128x64:d=1", "-r", "24", "-pix_fmt", "yuv420p", video]);
    comfy = await FakeComfy.start({ dir: join(work, "comfy"), video, nodeTypes: NODE_TYPES });
    comfy.modelLists = { "UNETLoader.unet_name": ["echo_unet.safetensors"], "LatentUpscaleModelLoader.model_name": ["echo_upscaler.safetensors"] };
    dataDir = join(work, "data");
    mkdirSync(join(dataDir, "proxy"), { recursive: true });
    symlinkSync(PROXY_VENV, join(dataDir, "proxy", ".venv"));
    engine = await startEngine(options());
    api = new Api(engine.url);
  }, 300_000);

  afterAll(async () => {
    await engine?.stop();
    await comfy?.close();
  });

  it("starts on this machine; a check reads the remote and picks its tier", async () => {
    expect(await until(status, (s) => s.phase === "not_installed")).toMatchObject({ mode: "local", tier: null });
    const check = await api.call("POST", "/api/remote/check", RemoteCheckSchema, { url: comfy.url.replace("http://", "") });
    expect(check).toMatchObject({ url: comfy.url, reachable: true, name: "NVIDIA GB10", comfyuiVersion: "0.41.3", recommendedTier: "remote-echo", missingNodes: [], missingModels: [] });
    expect(check.hardware).toMatchObject({ source: "remote", gpus: [{ vendor: "nvidia", unifiedMemory: true }] });
  });

  it("refuses a bad address, an unknown tier, and an address that is not ComfyUI", async () => {
    expect(await refused("POST", "/api/remote/check", { url: "http://me:secret@spark" }, 400)).toMatch(/without a password/);
    expect(await refused("POST", "/api/remote", { url: comfy.url, tier: "nope" }, 404)).toBe("No recipe for tier nope");
    expect(await refused("POST", "/api/remote", { url: engine.url, tier: "remote-echo" }, 409)).toMatch(/answers, but it is not ComfyUI/);
    expect((await status()).mode).toBe("local");
  });

  it("POST /api/remote: ready on the remote through a proxy here, and the settings keep it", async () => {
    const accepted = await api.call("POST", "/api/remote", RuntimeStatusSchema, { url: comfy.url, tier: "remote-echo" });
    expect(accepted).toMatchObject({ mode: "remote", phase: "installing", tier: "remote-echo" });
    expect(await until(status, (s) => s.phase === "ready" && s.comfyui.running)).toMatchObject({ mode: "remote", tier: "remote-echo", comfyui: { url: comfy.url, version: "0.41.3" } });
    expect((await status()).error).toBeUndefined();
    expect(await settings()).toMatchObject({ tier: "remote-echo", remote: { url: comfy.url, name: "NVIDIA GB10" } });
    // Recipes are matched against the computer that runs them.
    expect(await api.call("GET", "/api/hardware", HardwareProfileSchema)).toMatchObject({ source: "remote", gpus: [{ name: "NVIDIA GB10", unifiedMemory: true }] });
    expect((await api.call("GET", "/api/tiers", z.array(TierSummarySchema))).find((t) => t.tier === "remote-echo")).toMatchObject({ recommended: true });
    // Not installed on this machine: going back must not think so.
    const installState = join(dataDir, "install.json");
    expect(existsSync(installState) ? JSON.parse(readFileSync(installState, "utf8")).installed : {}).toEqual({});
  });

  it("a still, a draft and a same-take final run on the remote, with every file they need uploaded there", async () => {
    const p = await api.call("POST", "/api/projects", ProjectSchema, { name: "Remote", template: "cinematic_shot", aspect: "16:9", brief: {} });
    projectId = p.id;
    const photo = placeholderScene(96, 54, "reference").toPng();
    const reference = await api.upload(p.id, photo, "reference.png", "image/png");
    await api.call("PATCH", `/api/projects/${p.id}`, ProjectSchema, { brief: { referenceAssetId: reference.id }, shots: [{ id: "shot_0", index: 0, prompt: "A lighthouse at dusk", durationSec: 1, locked: false }] });
    const base = `/api/projects/${p.id}/shots/shot_0`;

    await api.run(`${base}/still`, { seed: 7 }, 30_000);
    const stillGraph = comfy.prompts.at(-1)!;
    expect(inputBytes(String(stillGraph["1"]!.inputs.image)).equals(Buffer.from(photo))).toBe(true);

    const draftJob = await api.run(`${base}/draft`, { seed: 11 }, 30_000);
    let project = await api.project(p.id);
    const draft = project.takes.find((t) => t.jobId === draftJob.id)!;
    expect(draft).toMatchObject({ rung: "draft", latentAssetId: expect.any(String), imageAssetId: project.shots[0]!.stillAssetId });
    const draftGraph = comfy.prompts.at(-1)!;
    expect(inputBytes(String(draftGraph["1"]!.inputs.image)).equals(assetBytes(project, project.shots[0]!.stillAssetId))).toBe(true);

    await api.run(`${base}/final`, { draftId: draft.id, kind: "same_take", mode: "now" }, 30_000);
    const finalGraph = comfy.prompts.at(-1)!;
    // The saved latent came back from the remote with the draft, and went up again as an input the loader resolves.
    const latentName = String(finalGraph["1"]!.inputs.latent);
    expect(inputBytes(latentName).toString()).toMatch(/^nightshift-latent from /);
    expect(inputBytes(latentName).equals(assetBytes(project, draft.latentAssetId))).toBe(true);
    expect(inputBytes(String(finalGraph["2"]!.inputs.file)).equals(assetBytes(project, draft.videoAssetId))).toBe(true);
    expect(finalGraph["4"]!.inputs.text).toBe(draft.prompt);
    expect(finalGraph["5"]!.inputs.noise_seed).toBe(11);
    project = await api.project(p.id);
    expect(project.takes.find((t) => t.rung === "final")).toMatchObject({ finalKind: "same_take", shotId: "shot_0" });
  });

  it("the remote goes away: jobs wait for it and run once it is back", async () => {
    await comfy.down();
    expect(await until(status, (s) => !s.comfyui.running)).toMatchObject({ mode: "remote", phase: "ready", error: expect.stringContaining("is not answering") });
    const before = comfy.prompts.length;
    const job = await api.job(`/api/projects/${projectId}/shots/shot_0/still`, { seed: 1 });
    expect(await until(() => jobById(job.id), (j) => j.message === "Waiting for the GPU")).toMatchObject({ status: "queued" });
    await sleep(300);
    expect((await jobById(job.id)).status).toBe("queued");
    await comfy.up();
    expect(await api.wait(job.id, 30_000)).toMatchObject({ status: "done" });
    expect(comfy.prompts.length).toBe(before + 1);
    expect((await status()).error).toBeUndefined();
  });

  it("the remote restarts mid-job: the job waits, then is sent again", async () => {
    comfy.hold = true;
    const before = comfy.prompts.length;
    const job = await api.job(`/api/projects/${projectId}/shots/shot_0/still`, { seed: 2 });
    await until(() => comfy.running().length, (n) => n === 1);
    // Accepting /prompt precedes the proxy's acknowledgement and first status poll.
    // Cut the connection only after the engine has observed the job running.
    await until(() => jobById(job.id), (j) => j.message === "Running");
    await comfy.down(); // its jobs are gone with it
    expect(await until(() => jobById(job.id), (j) => j.status === "queued" && !!j.message)).toMatchObject({ status: "queued" });
    await until(status, (s) => !s.comfyui.running);
    comfy.hold = false;
    await comfy.up();
    expect(await api.wait(job.id, 60_000)).toMatchObject({ status: "done" });
    expect(comfy.prompts.length).toBe(before + 2);
  }, 90_000);

  it("a crashed proxy here: jobs wait while it restarts by itself", async () => {
    const line = execFileSync("ps", ["-eo", "pid=,command="], { encoding: "utf8" })
      .split("\n")
      .find((l) => l.includes("comfy-api-proxy run") && l.includes(join(dataDir, "proxy", "remote")));
    const pid = Number(line?.trim().split(/\s+/)[0]);
    expect(pid).toBeGreaterThan(0);
    process.kill(pid, "SIGKILL");
    // The proxy here is down, not the remote: the status says which.
    expect(await until(status, (s) => !s.comfyui.running && !!s.error)).toMatchObject({ mode: "remote", error: expect.stringMatching(/^comfy-api-proxy (stopped|on this computer is not answering)/) });
    expect(await until(status, (s) => s.phase === "ready" && s.comfyui.running, 60_000)).toMatchObject({ mode: "remote" });
    expect((await status()).error).toBeUndefined();
    expect((await api.run(`/api/projects/${projectId}/shots/shot_0/still`, { seed: 4 }, 30_000)).status).toBe("done");
  });

  it("a new launch goes back to the remote", async () => {
    await engine.stop();
    engine = await startEngine(options());
    api = new Api(engine.url);
    expect(await until(status, (s) => s.phase === "ready" && s.comfyui.running)).toMatchObject({ mode: "remote", tier: "remote-echo" });
    expect(logs.some((l) => l.includes(`(remote -> ${comfy.url})`))).toBe(true);
  });

  it("another GPU computer gets every file uploaded again, though the proxy has sent the same bytes elsewhere", async () => {
    const other = await FakeComfy.start({ dir: mkdtempSync(join(tmpdir(), "ns-remote-b-")), video, nodeTypes: NODE_TYPES });
    other.modelLists = comfy.modelLists;
    try {
      await api.call("POST", "/api/remote", RuntimeStatusSchema, { url: other.url, tier: "remote-echo" });
      await until(status, (s) => s.phase === "ready" && s.comfyui.running && s.comfyui.url === other.url);
      await api.run(`/api/projects/${projectId}/shots/shot_0/still`, { seed: 3 }, 30_000);
      const project = await api.project(projectId);
      const photo = assetBytes(project, String(project.brief.referenceAssetId));
      expect(readFileSync(join(other.inputDir, String(other.prompts[0]!["1"]!.inputs.image))).equals(photo)).toBe(true);
      expect(comfy.prompts.length).toBeGreaterThan(0);
      await api.call("POST", "/api/remote", RuntimeStatusSchema, { url: comfy.url, tier: "remote-echo" });
      await until(status, (s) => s.phase === "ready" && s.comfyui.running && s.comfyui.url === comfy.url);
    } finally {
      await other.close();
    }
  });

  it("DELETE /api/remote: back to this machine, which has no install, and the proxy stops", async () => {
    const back = await api.call("DELETE", "/api/remote", RuntimeStatusSchema);
    expect(back).toMatchObject({ mode: "local", phase: "not_installed", tier: null });
    expect(await settings()).toMatchObject({ tier: null, remote: null });
    expect((await api.call("GET", "/api/hardware", HardwareProfileSchema)).source).not.toBe("remote");
    const log = join(dataDir, "logs", "proxy-remote.log");
    await until(() => existsSync(log) && readFileSync(log, "utf8").trim().split("\n").at(-1)!, (last) => !!last && last.startsWith("==== comfy-api-proxy exited"));
    expect(await status()).toMatchObject({ mode: "local", phase: "not_installed" });
    // Nothing to forget a second time.
    expect(await api.call("DELETE", "/api/remote", RuntimeStatusSchema)).toMatchObject({ mode: "local" });
  });
});

describe("engines told where their GPU is at launch cannot switch", () => {
  let engine: EngineHandle;
  afterAll(() => engine?.stop());

  it("mock mode answers 409 to use and forget", async () => {
    engine = await startEngine({ port: 0, dataDir: mkdtempSync(join(tmpdir(), "ns-remote-mock-")), mock: true, mockSpeed: 0, log: () => undefined });
    for (const [method, body] of [["POST", { url: "spark", tier: "apple-64" }], ["DELETE", undefined]] as const) {
      const res = await fetch(`${engine.url}/api/remote`, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
      expect(res.status).toBe(409);
      expect(ErrorSchema.parse(await res.json()).error).toMatch(/started in mock mode/);
    }
  });
});
