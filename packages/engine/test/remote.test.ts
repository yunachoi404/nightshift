/**
 * A GPU computer on the network, the parts that need no proxy: the address the user types, the hardware read from its
 * ComfyUI, what it lacks for a tier, clear words when it does not answer, settings that keep it, and the runtime switch.
 */
import type { Event } from "@nightshift/contract";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isRuntimeLost } from "../src/errors.js";
import { EventBus } from "../src/events.js";
import { REPO_ROOT } from "../src/paths.js";
import { loadRecipes, recommendTier } from "../src/recipes.js";
import { checkRemote, hardwareFromStats, normalizeRemoteUrl } from "../src/remote/check.js";
import { RuntimeSwitch } from "../src/remote/switch.js";
import { MockRuntime, freePort } from "../src/runtime/runtime.js";
import { SettingsPatchSchema, SettingsStore } from "../src/settings.js";
import { FakeComfy, GB10_STATS } from "./fakeComfy.js";

const RECIPES = fileURLToPath(new URL("./fixtures/remote/recipes", import.meta.url));
const WORKFLOWS = fileURLToPath(new URL("./fixtures/remote/workflows", import.meta.url));
const NODE_TYPES = ["LoadImage", "UNETLoader", "CLIPTextEncode", "SaveImage", "RandomNoise", "LatentUpscaleModelLoader", "NightshiftSaveAVLatent", "SaveVideo", "NightshiftLoadAVLatent", "LoadVideo"];

describe("the address of a GPU computer", () => {
  it("takes a name, name:port or a URL; port 8190 and http unless said otherwise", () => {
    expect(normalizeRemoteUrl("spark")).toBe("http://spark:8190");
    expect(normalizeRemoteUrl("  spark:8190 ")).toBe("http://spark:8190");
    expect(normalizeRemoteUrl("spark:8188")).toBe("http://spark:8188");
    expect(normalizeRemoteUrl("192.168.1.20")).toBe("http://192.168.1.20:8190");
    expect(normalizeRemoteUrl("http://spark:8190/")).toBe("http://spark:8190");
    expect(normalizeRemoteUrl("HTTP://Spark:8190")).toBe("http://spark:8190");
    expect(normalizeRemoteUrl("[fd00::1]")).toBe("http://[fd00::1]:8190");
    // A full URL is used as it is: a ComfyUI behind https on 443.
    expect(normalizeRemoteUrl("https://comfy.example.com")).toBe("https://comfy.example.com");
    expect(normalizeRemoteUrl("https://comfy.example.com/gpu/")).toBe("https://comfy.example.com/gpu");
  });

  it("refuses what is not an address, or carries a password", () => {
    for (const bad of ["", "   ", "ftp://spark", "http://me:secret@spark:8190", "spark:8190?x=1", "spark:99999"]) {
      expect(() => normalizeRemoteUrl(bad), bad).toThrow();
    }
  });
});

describe("the hardware of a GPU computer, from its ComfyUI", () => {
  it("a DGX Spark: its GB10 shares system memory, and gets the Spark's tier", async () => {
    const hw = hardwareFromStats(GB10_STATS);
    expect(hw).toEqual({ os: "linux", arch: "unknown", cpu: "unknown", ramGb: 121.7, gpus: [{ vendor: "nvidia", name: "NVIDIA GB10", vramGb: 121.7, unifiedMemory: true }], freeDiskGb: 0, source: "remote" });
    const { recipes } = await loadRecipes(join(REPO_ROOT, "recipes"));
    expect(recommendTier(recipes, hw)?.tier).toBe("unified-128-cuda");
  });

  it("a discrete card, a Mac and a CPU-only box", () => {
    const pc = hardwareFromStats({ system: { os: "nt", ram_total: 64 * 1024 ** 3 }, devices: [{ name: "cuda:0 NVIDIA GeForce RTX 4090 : cudaMallocAsync", type: "cuda", vram_total: 24 * 1024 ** 3 }] });
    expect(pc).toMatchObject({ os: "windows", ramGb: 64, gpus: [{ vendor: "nvidia", name: "NVIDIA GeForce RTX 4090", vramGb: 24, unifiedMemory: false }] });
    const mac = hardwareFromStats({ system: { os: "darwin", ram_total: 64 * 1024 ** 3 }, devices: [{ name: "mps", type: "mps", vram_total: 64 * 1024 ** 3 }] });
    expect(mac).toMatchObject({ os: "macos", gpus: [{ vendor: "apple", vramGb: 64, unifiedMemory: true }] });
    const amd = hardwareFromStats({ system: { os: "linux", ram_total: 32 * 1024 ** 3 }, devices: [{ name: "cuda:0 AMD Radeon RX 7900 XTX : native", type: "cuda", vram_total: 24 * 1024 ** 3 }] });
    expect(amd.gpus[0]).toMatchObject({ vendor: "amd", unifiedMemory: false });
    expect(hardwareFromStats({ system: { os: "linux", ram_total: 16 * 1024 ** 3 }, devices: [{ name: "cpu", type: "cpu" }] }).gpus).toEqual([]);
  });
});

describe("checking a GPU computer", () => {
  let comfy: FakeComfy;
  const servers: Server[] = [];
  const recipes = async () => (await loadRecipes(RECIPES, WORKFLOWS)).recipes;
  const serve = async (handler: Parameters<typeof createServer>[1]) => {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  beforeAll(async () => {
    comfy = await FakeComfy.start({ dir: mkdtempSync(join(tmpdir(), "ns-fake-comfy-")), video: "", nodeTypes: NODE_TYPES });
  });
  afterAll(async () => {
    await comfy.close();
    for (const s of servers) {
      s.closeAllConnections();
      s.close();
    }
  });

  it("reads its hardware and version, picks the tier, and finds nothing missing when it has it all", async () => {
    comfy.modelLists = { "UNETLoader.unet_name": ["echo_unet.safetensors"], "LatentUpscaleModelLoader.model_name": ["echo_upscaler.safetensors"] };
    const check = await checkRemote(comfy.url, { recipes: await recipes(), workflowsDir: WORKFLOWS });
    expect(check).toEqual({
      url: comfy.url,
      reachable: true,
      name: "NVIDIA GB10",
      comfyuiVersion: "0.41.3",
      hardware: expect.objectContaining({ source: "remote", ramGb: 121.7 }),
      recommendedTier: "remote-echo",
      missingNodes: [],
      missingModels: [],
    });
  });

  it("names the node types and model files the tier needs that it lacks, in both of ComfyUI's list formats", async () => {
    comfy.nodeTypes.delete("RandomNoise");
    comfy.modelLists = { "UNETLoader.unet_name": ["other.safetensors", "sub/echo_unet.safetensors"], "LatentUpscaleModelLoader.model_name": ["other.safetensors"] };
    const check = await checkRemote(comfy.url, { recipes: await recipes(), workflowsDir: WORKFLOWS });
    expect(check).toMatchObject({ reachable: true, missingNodes: ["RandomNoise"], missingModels: ["echo_unet.safetensors", "echo_upscaler.safetensors"] });
    expect(check.error).toBeUndefined();
    comfy.nodeTypes.add("RandomNoise");
  });

  it("says when no tier fits it", async () => {
    comfy.stats = { system: { os: "linux", ram_total: 16 * 1024 ** 3 }, devices: [{ name: "cuda:0 NVIDIA GeForce RTX 3060 : native", type: "cuda", vram_total: 12 * 1024 ** 3 }] };
    const check = await checkRemote(comfy.url, { recipes: await recipes(), workflowsDir: WORKFLOWS });
    expect(check).toMatchObject({ reachable: true, recommendedTier: null, name: "NVIDIA GeForce RTX 3060", error: "No Nightshift tier fits NVIDIA GeForce RTX 3060 (NVIDIA GeForce RTX 3060, 12 GB, 16 GB of memory)." });
    comfy.stats = structuredClone(GB10_STATS);
  });

  it("says plainly why it did not answer: nothing on the port, no such computer, too slow, not ComfyUI", async () => {
    const opts = { recipes: await recipes(), workflowsDir: WORKFLOWS, timeoutMs: 300 };
    const closed = `http://127.0.0.1:${await freePort()}`;
    expect(await checkRemote(closed, opts)).toMatchObject({ reachable: false, hardware: null, recommendedTier: null, error: expect.stringMatching(/^127\.0\.0\.1 is there, but nothing answers on port \d+\./) });
    expect((await checkRemote("http://nightshift-no-such-host.invalid:8190", opts)).error).toBe("No computer named nightshift-no-such-host.invalid was found on this network.");
    const silent = await serve(() => undefined);
    expect((await checkRemote(silent, opts)).error).toMatch(/did not answer within 1 second\. Check that the computer is on/);
    const web = await serve((_req, res) => res.end("<html>a router</html>"));
    expect((await checkRemote(web, opts)).error).toMatch(/answers, but it is not ComfyUI/);
    const json = await serve((_req, res) => res.end(JSON.stringify({ name: "something else" })));
    expect(await checkRemote(json, opts)).toMatchObject({ reachable: false, error: expect.stringMatching(/not ComfyUI/) });
  });
});

describe("losing the remote mid-job", () => {
  it("the proxy's 'Failed to reach ComfyUI' during an upload or download means the GPU went away; a rejected upload does not", () => {
    expect(isRuntimeLost(new Error("Failed to reach ComfyUI for upload."))).toBe(true);
    expect(isRuntimeLost(new Error("Failed to reach ComfyUI for content."))).toBe(true);
    expect(isRuntimeLost(new Error("ComfyUI rejected the upload."))).toBe(false);
  });
});

describe("settings keep the GPU computer", () => {
  it("other changes keep it; PATCH /api/settings cannot set it", async () => {
    const store = new SettingsStore(join(mkdtempSync(join(tmpdir(), "ns-settings-")), "settings.json"));
    expect((await store.load()).remote).toBeNull();
    await store.update({ remote: { url: "http://spark:8190", name: "NVIDIA GB10" } });
    await store.update({ memoryLimitGb: 64, overnight: { enabled: true } });
    expect(store.get().remote).toEqual({ url: "http://spark:8190", name: "NVIDIA GB10" });
    expect(SettingsPatchSchema.parse({ remote: { url: "http://elsewhere" }, memoryLimitGb: 8 })).toEqual({ memoryLimitGb: 8 });
    expect((await store.load()).remote).toEqual({ url: "http://spark:8190", name: "NVIDIA GB10" });
  });
});

describe("RuntimeSwitch", () => {
  it("delegates to the selected runtime, and only its events reach the bus", async () => {
    const bus = new EventBus();
    const events: Event[] = [];
    bus.subscribe((e) => events.push(e));
    const made: { url: string; runtime: MockRuntime }[] = [];
    const sw = new RuntimeSwitch(
      bus,
      (b) => new MockRuntime(b, 0),
      (b, url) => {
        const runtime = new MockRuntime(b, 0);
        made.push({ url, runtime });
        return runtime;
      },
    );
    await sw.start("local-tier");
    expect(sw.status()).toMatchObject({ phase: "ready", tier: "local-tier" });
    const local = events.length;

    sw.select("http://spark:8190");
    expect(sw.remoteUrl).toBe("http://spark:8190");
    expect(sw.status()).toMatchObject({ phase: "not_installed" }); // announced at once
    expect(events.at(-1)).toMatchObject({ type: "runtime", status: { phase: "not_installed" } });
    expect(events.length).toBe(local + 1);
    // The runtime left behind stops quietly: the UI never sees it again.
    await sw.release();
    expect(events.length).toBe(local + 1);
    await sw.start("remote-tier");
    expect(events.at(-1)).toMatchObject({ status: { phase: "ready", tier: "remote-tier" } });
    expect(sw.available()).toBe(true);

    sw.select("http://spark:8190"); // the same computer: nothing changes
    expect(made).toHaveLength(1);
    sw.select("http://other:8190");
    expect(made.map((m) => m.url)).toEqual(["http://spark:8190", "http://other:8190"]);
    sw.select(null);
    expect(sw.remoteUrl).toBeNull();
    expect(sw.status()).toMatchObject({ phase: "stopped", tier: "local-tier" });
    await sw.stop();
    expect(made[0]!.runtime.status().phase).toBe("stopped");
  });
});
