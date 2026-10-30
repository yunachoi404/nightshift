/**
 * Other programs on the GPU (RuntimeStatus.otherGpuUse): nvidia-smi's output as it comes, the 1 GB rule, how the runtime
 * looks while a GPU job runs and lets go after it, and the field on GET /api/status and the event stream.
 */
import { EventSchema, ProjectSchema, RuntimeStatusSchema, type Event, type RuntimeStatus } from "@nightshift/contract";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, type EngineHandle } from "../src/engine.js";
import { EventBus } from "../src/events.js";
import { SAMPLE_RECIPES_DIR } from "../src/paths.js";
import { MockStepRunner } from "../src/runner/mock.js";
import type { StepContext, StepRequest, StepRunner } from "../src/runner/types.js";
import { appName, mockOtherGpu, otherGpuUse, otherGpuUseChanged, parseComputeApps, readComputeApps, watchesOtherGpuUse } from "../src/runtime/gpuShare.js";
import { AttachRuntime, MockRuntime } from "../src/runtime/runtime.js";
import { sleep } from "../src/util.js";
import { FakeProxy } from "./fakeProxy.js";
import { Api } from "./flow.js";
import { hw } from "./helpers.js";

async function until<T>(get: () => T | Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out; last value ${JSON.stringify(v)}`);
    await sleep(10);
  }
}

/** Our ComfyUI on an 8 GB RTX 2080 Super, as `nvidia-smi --query-compute-apps=pid,gpu_uuid,process_name,used_memory` prints it. */
const COMFY = "4242, GPU-6b1f2c3d-0000-4a5b-8c9d-2080abcdef01, /home/ada/.nightshift/comfyui/.venv/bin/python, 5120";
const smi = (...rows: string[]) => rows.map((r) => `${r}\n`).join("");

describe("nvidia-smi's compute apps", () => {
  it("none: nothing to say, even without our own ComfyUI in the list", () => {
    expect(parseComputeApps("")).toEqual([]);
    expect(parseComputeApps("No running processes found\n")).toEqual([]);
    expect(otherGpuUse(parseComputeApps(""), 4242)).toBeNull();
  });

  it("our own ComfyUI only: nothing to say", () => {
    const apps = parseComputeApps(smi(COMFY));
    expect(apps).toEqual([{ pid: 4242, gpu: "GPU-6b1f2c3d-0000-4a5b-8c9d-2080abcdef01", name: "/home/ada/.nightshift/comfyui/.venv/bin/python", usedMb: 5120 }]);
    expect(otherGpuUse(apps, 4242)).toBeNull();
  });

  it("a small one (under 1 GB together) is left alone", () => {
    const apps = parseComputeApps(smi(COMFY, "9100, GPU-6b1f2c3d-0000-4a5b-8c9d-2080abcdef01, /usr/bin/python3, 410", "9230, GPU-6b1f2c3d-0000-4a5b-8c9d-2080abcdef01, /opt/obs/bin/obs, 300"));
    expect(otherGpuUse(apps, 4242)).toBeNull();
  });

  it("a large one is named, with what it holds", () => {
    const apps = parseComputeApps(smi(COMFY, "9100, GPU-6b1f2c3d-0000-4a5b-8c9d-2080abcdef01, /usr/bin/python3, 3584"));
    expect(otherGpuUse(apps, 4242)).toEqual({ usedGb: 3.5, apps: ["python3"] });
  });

  it("several small ones that add up count, biggest first, each name once", () => {
    const g = "GPU-6b1f2c3d-0000-4a5b-8c9d-2080abcdef01";
    const apps = parseComputeApps(smi(COMFY, `9100, ${g}, /usr/bin/python3, 400`, `9230, ${g}, /usr/bin/blender, 700`, `9231, ${g}, /usr/bin/python3, 300`));
    expect(otherGpuUse(apps, 4242)).toEqual({ usedGb: 1.4, apps: ["blender", "python3"] });
  });

  it("only the card ComfyUI runs on counts", () => {
    const apps = parseComputeApps(smi(COMFY, "9100, GPU-ffffffff-1111-2222-3333-444444444444, /usr/bin/python3, 20480"));
    expect(otherGpuUse(apps, 4242)).toBeNull();
  });

  it("process ids it cannot match (a container, WSL): nothing, rather than our own ComfyUI passing for another program", () => {
    const apps = parseComputeApps(smi("1, GPU-6b1f2c3d-0000-4a5b-8c9d-2080abcdef01, [Not Found], 5120"));
    expect(otherGpuUse(apps, 4242)).toBeNull();
  });

  it("names: paths, Windows programs, commas in a path, and processes the driver will not name", () => {
    const g = "GPU-6b1f2c3d-0000-4a5b-8c9d-2080abcdef01";
    const apps = parseComputeApps(smi(COMFY, `9100, ${g}, C:\\Program Files\\Blender Foundation\\blender.exe, 1024`, `9101, ${g}, /opt/a,b/render, 512`, `9102, ${g}, [Not Found], 2048`));
    expect(apps.map((a) => appName(a.name))).toEqual(["python", "blender", "render", ""]);
    expect(otherGpuUse(apps, 4242)).toEqual({ usedGb: 3.5, apps: ["blender", "render"] });
  });

  it("rows without a memory figure (Windows' WDDM says [N/A]) are left out", () => {
    expect(parseComputeApps(smi(COMFY, "9100, GPU-6b1f2c3d-0000-4a5b-8c9d-2080abcdef01, C:\\Windows\\explorer.exe, [N/A]"))).toHaveLength(1);
  });

  it("no nvidia-smi, or one that fails: null", async () => {
    expect(await readComputeApps(async () => ({ code: 127, stdout: "", stderr: "not found" }))).toBeNull();
    expect(await readComputeApps(async (cmd, args) => ({ code: 0, stdout: cmd === "nvidia-smi" && args[0]!.startsWith("--query-compute-apps=pid,gpu_uuid,") ? smi(COMFY) : "", stderr: "" }))).toHaveLength(1);
  });

  it("only an NVIDIA card with VRAM of its own is watched", () => {
    expect(watchesOtherGpuUse(hw({ name: "NVIDIA GeForce RTX 2080 SUPER", vramGb: 8 }, 32))).toBe(true);
    expect(watchesOtherGpuUse(hw({ name: "NVIDIA GeForce RTX 4090", vramGb: 24 }, 64, { os: "windows" }))).toBe(true);
    expect(watchesOtherGpuUse(hw({ name: "NVIDIA GB10", vramGb: 128, unifiedMemory: true }, 128))).toBe(false);
    expect(watchesOtherGpuUse(hw({ vendor: "apple", name: "Apple M4 Max", vramGb: 128, unifiedMemory: true }, 128, { os: "macos" }))).toBe(false);
    expect(watchesOtherGpuUse(hw({ vendor: "amd", name: "Radeon RX 7900 XTX", vramGb: 24 }, 64))).toBe(false);
    expect(watchesOtherGpuUse(hw(null, 16))).toBe(false);
  });

  it("an event only when it comes or goes, the programs change, or the memory moves by half a GB", () => {
    const a = { usedGb: 3.5, apps: ["python"] };
    expect(otherGpuUseChanged(undefined, null)).toBe(false);
    expect(otherGpuUseChanged(undefined, a)).toBe(true);
    expect(otherGpuUseChanged(a, null)).toBe(true);
    expect(otherGpuUseChanged(a, { usedGb: 3.8, apps: ["python"] })).toBe(false);
    expect(otherGpuUseChanged(a, { usedGb: 4.0, apps: ["python"] })).toBe(true);
    expect(otherGpuUseChanged(a, { usedGb: 3.5, apps: ["python", "blender"] })).toBe(true);
  });

  it("mock mode's NIGHTSHIFT_MOCK_OTHER_GPU follows the same rules", () => {
    expect(mockOtherGpu(undefined)).toBeNull();
    expect(mockOtherGpu("nonsense")).toBeNull();
    expect(mockOtherGpu("python:3.5")?.()).toEqual({ usedGb: 3.5, apps: ["python"] });
    expect(mockOtherGpu("python:2.1, blender:1.4")?.()).toEqual({ usedGb: 3.5, apps: ["python", "blender"] });
    expect(mockOtherGpu("python:0.4")?.()).toBeNull();
  });
});

describe("the runtime looks while a GPU job runs", () => {
  /** Mock runtime at 1/300 speed: it looks every 50 ms. */
  async function runtime(spec: string) {
    const statuses: RuntimeStatus[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => {
      const ev = EventSchema.parse(e);
      if (ev.type === "runtime") statuses.push(ev.status);
    });
    const rt = new MockRuntime(bus, 1 / 300, spec);
    await rt.start("nvidia-8");
    statuses.length = 0;
    return { rt, statuses, shown: () => statuses.filter((s) => s.otherGpuUse).length };
  }

  it("says nothing while idle, says it once while a job runs, and lets go one look after the last job", async () => {
    const { rt, statuses, shown } = await runtime("python:3.5");
    await sleep(120);
    expect(rt.status().otherGpuUse).toBeUndefined();
    expect(statuses).toHaveLength(0);

    rt.setGpuBusy(true);
    await until(() => rt.status().otherGpuUse, (u) => !!u);
    expect(rt.status().otherGpuUse).toEqual({ usedGb: 3.5, apps: ["python"] });
    await sleep(250); // several more looks, the same answer: no more events
    expect(shown()).toBe(1);
    expect(statuses).toHaveLength(1);

    // The next job right after: no flicker.
    rt.setGpuBusy(false);
    rt.setGpuBusy(true);
    await sleep(150);
    expect(statuses).toHaveLength(1);

    rt.setGpuBusy(false);
    await until(() => rt.status().otherGpuUse, (u) => !u, 2000);
    expect(statuses).toHaveLength(2);
    expect(statuses.at(-1)).not.toHaveProperty("otherGpuUse");
    await rt.stop();
  });

  it("under 1 GB together: nothing", async () => {
    const { rt, statuses } = await runtime("python:0.6");
    rt.setGpuBusy(true);
    await sleep(200);
    expect(statuses).toHaveLength(0);
    await rt.stop();
  });

  it("a stopped runtime says nothing about the GPU", async () => {
    const { rt } = await runtime("python:3.5");
    rt.setGpuBusy(true);
    await until(() => rt.status().otherGpuUse, (u) => !!u);
    await rt.stop();
    expect(rt.status()).toMatchObject({ phase: "stopped" });
    expect(rt.status()).not.toHaveProperty("otherGpuUse");
  });

  it("attach mode never looks: the GPU behind the proxy is not this machine's", async () => {
    const proxy = await FakeProxy.start();
    const rt = new AttachRuntime(new EventBus(), proxy.url, () => undefined, 20);
    try {
      await rt.start("spark-echo");
      rt.setGpuBusy(true);
      await sleep(100);
      expect(rt.status()).toMatchObject({ phase: "ready", comfyui: { running: true } });
      expect(rt.status()).not.toHaveProperty("otherGpuUse");
    } finally {
      await rt.stop();
      await proxy.close();
    }
  });
});

/** The instant mock GPU, held at a gate while it is closed, so a test can look during a render. */
class GatedRunner implements StepRunner {
  private readonly mock: MockStepRunner;
  private gate: Promise<void> | undefined;

  /** `outOfMemory`: steps that fail as ComfyUI does when the card is full. */
  constructor(outOfMemory: string[] = []) {
    this.mock = new MockStepRunner(0, outOfMemory);
  }

  hold(): () => void {
    let open!: () => void;
    this.gate = new Promise((resolve) => (open = resolve));
    return () => {
      this.gate = undefined;
      open();
    };
  }

  async run(req: StepRequest, ctx: StepContext) {
    await this.gate;
    return this.mock.run(req, ctx);
  }
}

describe("GET /api/status and the event stream (mock engine, NIGHTSHIFT_MOCK_OTHER_GPU)", () => {
  const runner = new GatedRunner(["voice"]);
  const events: Event[] = [];
  let engine: EngineHandle;
  let api: Api;
  let sse: AbortController;

  beforeAll(async () => {
    process.env.NIGHTSHIFT_MOCK_OTHER_GPU = "python:3.5";
    try {
      // At 1/50 speed the mock looks every 300 ms: back-to-back jobs stay inside one look.
      engine = await startEngine({ port: 0, dataDir: mkdtempSync(join(tmpdir(), "ns-gpushare-")), mock: true, mockSpeed: 0.02, runner, recipesDir: SAMPLE_RECIPES_DIR, log: () => undefined });
    } finally {
      delete process.env.NIGHTSHIFT_MOCK_OTHER_GPU;
    }
    api = new Api(engine.url);
    await api.install("nvidia-8");
    sse = new AbortController();
    const res = await fetch(`${engine.url}/api/events`, { signal: sse.signal });
    void (async () => {
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for await (const chunk of res.body!) {
          buf += decoder.decode(chunk as Uint8Array, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n\n")) !== -1) {
            const data = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: "));
            buf = buf.slice(i + 2);
            if (data) events.push(EventSchema.parse(JSON.parse(data.slice(6))));
          }
        }
      } catch {
        // aborted
      }
    })();
    // The install runs at the mock's 1/50 speed: on a busy machine it takes longer than the default 10 s.
  }, 60_000);
  afterAll(async () => {
    sse?.abort();
    await engine?.stop();
  });

  it("carries otherGpuUse while a GPU job runs, and drops it after", async () => {
    const runtimeEvents = () => events.flatMap((e) => (e.type === "runtime" ? [e.status] : []));
    await until(() => runtimeEvents().length, (n) => n > 0);
    expect(RuntimeStatusSchema.parse(await api.call("GET", "/api/status", null))).not.toHaveProperty("otherGpuUse");

    const open = runner.hold();
    const project = await api.call("POST", "/api/projects", ProjectSchema, { name: "Harbor", template: "cinematic_shot", aspect: "16:9", brief: { idea: "a harbor at dawn" } });
    const job = await api.job(`/api/projects/${project.id}/storyboard`);

    const during = await until(() => api.call("GET", "/api/status", RuntimeStatusSchema), (s) => !!s.otherGpuUse);
    expect(during).toMatchObject({ phase: "ready", mode: "mock", otherGpuUse: { usedGb: 3.5, apps: ["python"] } });
    await until(() => runtimeEvents(), (s) => s.some((x) => x.otherGpuUse));
    expect(runtimeEvents().find((s) => s.otherGpuUse)!.otherGpuUse).toEqual({ usedGb: 3.5, apps: ["python"] });

    open();
    expect(await api.wait(job.id, 10_000)).toMatchObject({ status: "done" });
    await api.settle(project.id); // the stills it queued run too
    const after = await until(() => api.call("GET", "/api/status", RuntimeStatusSchema), (s) => !s.otherGpuUse);
    expect(after.phase).toBe("ready");
    await until(() => runtimeEvents().at(-1), (s) => !!s && !s.otherGpuUse);
    // Said once when it came and once when it went, not on every look.
    const flips = runtimeEvents().filter((s, i, all) => !!s.otherGpuUse !== !!all[i - 1]?.otherGpuUse);
    expect(flips.map((s) => !!s.otherGpuUse)).toEqual([true, false]);
  });

  it("a voice that runs out of graphics memory while another program holds the card says so, and names the program", async () => {
    const project = await api.call("POST", "/api/projects", ProjectSchema, { name: "Rain Rider", template: "cinematic_shot", aspect: "16:9", brief: { idea: "a red motorcycle in the rain" } });
    const open = runner.hold();
    const job = await api.job(`/api/projects/${project.id}/audio`, { role: "voice", text: "Rain on chrome. The city sleeps." });
    await until(() => api.call("GET", "/api/status", RuntimeStatusSchema), (s) => !!s.otherGpuUse);
    open();
    const failed = await api.wait(job.id, 10_000);
    expect(failed).toMatchObject({ status: "failed", message: "Ran out of graphics memory. Other apps are using 3.5 GB (python)." });
    // The details stay in the error.
    expect(failed.error).toMatch(/^ComfyUI failed in mock node 2: Allocation on device 0 would exceed allowed memory/);
  });
});
