/**
 * The GPU runtime the job runner talks to, in three flavors:
 * - local: spawn and supervise ComfyUI (with the recipe's launch flags plus the memory limit) and
 *   comfy-api-proxy in front of it; restart on crash.
 * - attach: use an already-running comfy-api-proxy (a GPU box through an ssh tunnel); spawn nothing.
 * - mock: no GPU at all; the mock step runner makes placeholder media.
 * - remote: a GPU computer on the network the user picked in the app (src/remote/).
 */
import type { HardwareProfile, OtherGpuUse, Recipe, RuntimeStatus, Settings } from "@nightshift/contract";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { delimiter, join } from "node:path";
import type { EventBus } from "../events.js";
import { legacyNodeDirs } from "../install/comfyui.js";
import { linkNodePacks, missingNodeClasses, recipeNodePacks, workflowNodeClasses } from "../install/nodes.js";
import type { DataPaths } from "../paths.js";
import { errorMessage, execCapture, exists, round1, sleep, type Logger } from "../util.js";
import { launchPlan } from "./flags.js";
import { GPU_WATCH_MS, mockOtherGpu, otherGpuUse, otherGpuUseChanged, readComputeApps, watchesOtherGpuUse } from "./gpuShare.js";

export interface Runtime {
  readonly mode: "local" | "attach" | "remote" | "mock";
  status(): RuntimeStatus;
  /** Bring the runtime up for `tier`. Resolves once ready; failures land in status().error. */
  start(tier: string): Promise<void>;
  stop(): Promise<void>;
  /** Apply new launch flags (memory limit changed). Local mode restarts ComfyUI; the others do nothing. */
  restart(tier: string): Promise<void>;
  /** The comfy-api-proxy base URL for the Comfy SDK, when ready. */
  baseUrl(): string | null;
  /** Whether GPU jobs can start now: the runtime is ready and ComfyUI answers. */
  available(): boolean;
  /** A job just lost the runtime: look at it again now instead of at the next regular check. */
  noteLost(): void;
  /** GPU memory ComfyUI holds right now, in GB, if the runtime can tell. */
  sampleMemoryGb(): Promise<number | null>;
  /** Mark the runtime as installing, not installed, or starting while its install is checked (the installer drives this). */
  setPhase(phase: "not_installed" | "installing" | "starting", tier: string | null, error?: string): void;
  /**
   * Whether a GPU job runs now. Meanwhile local mode on an NVIDIA card looks every 15 s for other programs holding the
   * GPU's memory (status().otherGpuUse; see gpuShare.ts). The others do nothing.
   */
  setGpuBusy(busy: boolean): void;
}

export abstract class BaseRuntime {
  protected state: RuntimeStatus = { phase: "not_installed", tier: null, comfyui: { running: false, url: null, version: null }, memoryUsedGb: null };

  abstract readonly mode: Runtime["mode"];

  /** Set by a runtime that can see other programs on its GPU: how to look, and how often while a GPU job runs. */
  protected gpuWatch?: { read: () => Promise<OtherGpuUse | null>; everyMs: number; log?: Logger };
  private gpuBusy = false;
  private gpuIdleSince = 0;
  private gpuTimer?: NodeJS.Timeout;
  private gpuLooking = false;

  constructor(protected readonly bus: EventBus) {}

  status(): RuntimeStatus {
    return { ...structuredClone(this.state), mode: this.mode };
  }

  setPhase(phase: "not_installed" | "installing" | "starting", tier: string | null, error?: string): void {
    this.set({ phase, tier, comfyui: { running: false, url: null, version: null }, memoryUsedGb: null, ...(error ? { error } : {}) }, true);
  }

  available(): boolean {
    return this.state.phase === "ready" && this.state.comfyui.running;
  }

  noteLost(): void {
    // Local mode watches its processes; mock never loses its runtime.
  }

  setGpuBusy(busy: boolean): void {
    if (this.gpuBusy && !busy) this.gpuIdleSince = Date.now();
    this.gpuBusy = busy;
    if (!busy || this.gpuTimer || !this.gpuWatch) return;
    this.gpuTimer = setInterval(() => void this.lookAtGpu(), this.gpuWatch.everyMs);
    this.gpuTimer.unref();
    void this.lookAtGpu();
  }

  /**
   * One look at the GPU while a job runs. What it found stays one interval past the last job, so the next job in a row
   * does not make the warning flicker; then it goes and the looking stops.
   */
  private async lookAtGpu(): Promise<void> {
    const watch = this.gpuWatch;
    if (!this.gpuBusy || !watch) {
      if (!watch || Date.now() - this.gpuIdleSince >= watch.everyMs) this.stopGpuWatch();
      return;
    }
    if (this.gpuLooking || !this.available()) return;
    this.gpuLooking = true;
    try {
      const use = await watch.read().catch(() => null);
      if (!this.gpuBusy || !this.available() || !otherGpuUseChanged(this.state.otherGpuUse, use)) return;
      watch.log?.(use ? `other programs hold ${use.usedGb} GB of the GPU (${use.apps.join(", ") || "names unknown"}); renders may be slower` : "other programs let go of the GPU");
      this.set({ otherGpuUse: use ?? undefined });
    } finally {
      this.gpuLooking = false;
    }
  }

  private stopGpuWatch(): void {
    clearInterval(this.gpuTimer);
    this.gpuTimer = undefined;
    if (this.state.otherGpuUse) this.set({ otherGpuUse: undefined });
  }

  /** After the processes are gone. During an install the phase stays "installing". */
  protected markStopped(): void {
    clearInterval(this.gpuTimer);
    this.gpuTimer = undefined;
    const down = { comfyui: { running: false, url: this.state.comfyui.url, version: null }, memoryUsedGb: null };
    this.set(this.state.phase === "installing" ? down : { phase: "stopped", ...down });
  }

  protected set(patch: Partial<RuntimeStatus>, replace = false): void {
    const next = { ...this.state, ...patch };
    if (replace || patch.phase === "ready") delete next.error;
    if (patch.error) next.error = patch.error;
    // Only said of a GPU that renders right now.
    if (!next.otherGpuUse || next.phase !== "ready" || !next.comfyui.running) delete next.otherGpuUse;
    this.state = next;
    this.bus.emit({ type: "runtime", status: this.status() });
  }
}

// ---------------------------------------------------------------- mock

export class MockRuntime extends BaseRuntime implements Runtime {
  readonly mode = "mock" as const;

  constructor(
    bus: EventBus,
    private readonly speed: number,
    /** NIGHTSHIFT_MOCK_OTHER_GPU ("python:3.5"): other programs to report on the GPU while a GPU job runs. */
    otherGpu?: string,
  ) {
    super(bus);
    const read = mockOtherGpu(otherGpu);
    // Paced like the jobs: 15 s at speed 1.
    if (read) this.gpuWatch = { read: async () => read(), everyMs: Math.max(50, GPU_WATCH_MS * speed) };
  }

  async start(tier: string): Promise<void> {
    this.set({ phase: "starting", tier, comfyui: { running: false, url: null, version: null } }, true);
    await sleep(1200 * this.speed);
    this.set({ phase: "ready", tier, comfyui: { running: true, url: "mock://comfyui", version: "mock" }, memoryUsedGb: 0 });
  }

  async stop(): Promise<void> {
    this.markStopped();
  }

  async restart(tier: string): Promise<void> {
    await this.start(tier);
  }

  baseUrl(): string | null {
    return null;
  }

  async sampleMemoryGb(): Promise<number | null> {
    return null;
  }
}

// ---------------------------------------------------------------- attach

/**
 * A job id no job has. Asking the proxy for it goes through to ComfyUI: 404 when ComfyUI answers, 503
 * `upstream_unreachable` when it does not. The proxy's own /api/v2/health never asks ComfyUI.
 */
const PROBE_JOB = "00000000-0000-4000-8000-000000000000";

/** Whether the comfy-api-proxy answers, and whether the ComfyUI behind it does. */
export async function probeProxy(url: string, timeoutMs: number): Promise<"up" | "comfyui_down" | "proxy_down"> {
  try {
    const res = await fetch(`${url}/api/v2/jobs/${PROBE_JOB}`, { signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel();
    return res.ok || res.status === 404 ? "up" : "comfyui_down";
  } catch {
    return "proxy_down";
  }
}

/**
 * Uses an existing comfy-api-proxy and never starts or stops anything. On a shared GPU box the ComfyUI behind it gives
 * way to other work and comes back by itself, sometimes hours later; the proxy stays up meanwhile. So the check asks for
 * ComfyUI through the proxy. Once the proxy has answered, the runtime stays "ready" through any outage, with
 * `comfyui.running` false while ComfyUI (or the proxy, or the ssh tunnel to it) is gone: GPU jobs wait, the rest of
 * the app goes on. A proxy that never answered is a setup problem and shows as "error".
 */
export class AttachRuntime extends BaseRuntime implements Runtime {
  readonly mode = "attach" as const;
  private timer?: NodeJS.Timeout;
  private tier: string | null = null;
  private attached = false;
  private checking?: Promise<void>;

  constructor(
    bus: EventBus,
    private readonly url: string,
    private readonly log: Logger,
    /** How often to look at the proxy and ComfyUI, ms. */
    private readonly checkMs = 10_000,
  ) {
    super(bus);
  }

  async start(tier: string): Promise<void> {
    this.tier = tier;
    this.attached = false;
    this.set({ phase: "starting", tier, comfyui: { running: false, url: this.url, version: null } }, true);
    await this.check();
    if (!this.timer) {
      this.timer = setInterval(() => void this.check(), this.checkMs);
      this.timer.unref();
    }
  }

  /** One check at a time; a call during a check waits for it. */
  private check(): Promise<void> {
    this.checking ??= this.probe().finally(() => (this.checking = undefined));
    return this.checking;
  }

  private async probe(): Promise<void> {
    const tier = this.tier;
    if (!tier) return;
    const health = await probeProxy(this.url, 4000);
    if (tier !== this.tier) return; // stopped or switched meanwhile
    if (health !== "proxy_down") this.attached = true;
    if (!this.attached) {
      if (this.state.phase !== "error") this.set({ phase: "error", comfyui: { running: false, url: this.url, version: null }, error: `comfy-api-proxy at ${this.url} is not answering` });
      return;
    }
    const running = health === "up";
    const error =
      health === "comfyui_down"
        ? "ComfyUI is not answering behind the proxy. The GPU may be busy with other work. Jobs wait for it."
        : health === "proxy_down"
          ? `comfy-api-proxy at ${this.url} stopped answering. Jobs wait for it to come back.`
          : undefined;
    if (this.state.phase === "ready" && this.state.comfyui.running === running && this.state.error === error) return;
    this.log(running ? `ComfyUI answers through comfy-api-proxy at ${this.url}` : error!);
    this.set({ phase: "ready", tier, comfyui: { running, url: this.url, version: null }, ...(error ? { error } : {}) });
  }

  noteLost(): void {
    void this.check();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.tier = null;
    this.attached = false;
    this.markStopped();
  }

  async restart(tier: string): Promise<void> {
    this.tier = tier;
    await this.check();
  }

  baseUrl(): string | null {
    return this.state.phase === "ready" ? this.url : null;
  }

  async sampleMemoryGb(): Promise<number | null> {
    return null;
  }
}

// ---------------------------------------------------------------- local

export interface LocalRuntimeDeps {
  paths: DataPaths;
  recipe: (tier: string) => Recipe | undefined;
  hardware: () => Promise<HardwareProfile>;
  settings: () => Settings;
  log: Logger;
  /** The repo's comfy_nodes/. Our pack and the tier's node packs are linked into custom_nodes before every start. */
  nodesDir?: string;
  /** The recipes' workflows, to check that ComfyUI loaded every node type they use. */
  workflowsDir?: string;
  /** Folders to put first on ComfyUI's PATH: where the engine found ffmpeg, which Nightshift's final node runs. */
  toolDirs?: () => Promise<string[]>;
}

/** Crash budget: this many unexpected exits inside the window puts the runtime in "error". */
const MAX_CRASHES = 4;
const CRASH_WINDOW_MS = 10 * 60_000;

export class LocalRuntime extends BaseRuntime implements Runtime {
  readonly mode = "local" as const;
  private comfy?: ChildProcess;
  private proxy?: ChildProcess;
  private comfyUrl?: string;
  private proxyUrl?: string;
  private stopping = false;
  private crashes: number[] = [];
  private tier: string | null = null;
  private starting?: Promise<void>;
  private memoryTimer?: NodeJS.Timeout;
  /** Bumped by stop(): a launch from an older generation stops at its next step and spawns nothing more. */
  private generation = 0;

  constructor(
    bus: EventBus,
    private readonly deps: LocalRuntimeDeps,
  ) {
    super(bus);
  }

  python(): string {
    const p = this.deps.paths.comfy;
    return process.platform === "win32" ? join(p, ".venv", "Scripts", "python.exe") : join(p, ".venv", "bin", "python");
  }

  proxyExe(): string {
    const v = this.deps.paths.proxyVenv;
    return process.platform === "win32" ? join(v, "Scripts", "comfy-api-proxy.exe") : join(v, "bin", "comfy-api-proxy");
  }

  async start(tier: string): Promise<void> {
    this.tier = tier;
    if (this.state.phase === "ready" && this.comfy && this.proxy) return;
    this.starting ??= this.launch(tier, this.generation).finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async launch(tier: string, gen: number): Promise<void> {
    const { paths, log } = this.deps;
    const current = () => gen === this.generation;
    const check = () => {
      if (!current()) throw new Error("ComfyUI start was cancelled");
    };
    this.stopping = false;
    this.set({ phase: "starting", tier, comfyui: { running: false, url: null, version: null }, memoryUsedGb: null }, true);
    try {
      const recipe = this.deps.recipe(tier);
      if (!recipe) throw new Error(`No recipe for tier ${tier}`);
      if (!(await exists(this.python()))) throw new Error(`ComfyUI is not installed at ${paths.comfy}`);
      if (!(await exists(this.proxyExe()))) throw new Error("comfy-api-proxy is not installed");
      // custom_nodes holds exactly this tier's packs: another tier installed since may have changed it.
      await linkNodePacks({ comfyDir: paths.comfy, nodesDir: this.deps.nodesDir, packs: recipeNodePacks(recipe), legacy: await legacyNodeDirs(paths.comfy), log });
      const hardware = await this.deps.hardware();
      const plan = launchPlan(recipe, hardware, this.deps.settings().memoryLimitGb);
      this.gpuWatch = watchesOtherGpuUse(hardware) ? { read: () => this.otherGpuUse(), everyMs: GPU_WATCH_MS, log } : undefined;
      for (const note of plan.notes) log(`memory: ${note}`);
      const env: NodeJS.ProcessEnv = { ...process.env, ...plan.env, PYTHONUNBUFFERED: "1" };
      // An app opened from the Finder has a bare PATH; ComfyUI's ffmpeg must be the one the engine found.
      const toolDirs = (await this.deps.toolDirs?.()) ?? [];
      if (toolDirs.length) env.PATH = [...toolDirs, env.PATH].filter(Boolean).join(delimiter);
      await mkdir(paths.logs, { recursive: true });
      await mkdir(paths.comfyInput, { recursive: true });
      await mkdir(paths.comfyOutput, { recursive: true });

      const comfyPort = await freePort();
      check(); // nothing below spawns once stop() has run
      const args = [
        join(paths.comfy, "main.py"),
        "--listen",
        "127.0.0.1",
        "--port",
        String(comfyPort),
        "--input-directory",
        paths.comfyInput,
        "--output-directory",
        paths.comfyOutput,
        "--disable-auto-launch",
        ...plan.args,
      ];
      log(`starting ComfyUI: ${args.slice(1).join(" ")}`);
      this.comfy = this.spawnLogged(this.python(), args, env, join(paths.logs, "comfyui.log"), "ComfyUI");
      this.comfyUrl = `http://127.0.0.1:${comfyPort}`;
      await waitHttp(`${this.comfyUrl}/system_stats`, 15 * 60_000, () => current() && this.comfy?.exitCode === null);

      const proxyPort = await freePort();
      await mkdir(paths.proxyState, { recursive: true });
      check();
      const proxyArgs = ["run", "--comfyui", this.comfyUrl, "--port", String(proxyPort), "--comfyui-base-dir", paths.comfy, "--state-dir", paths.proxyState, "--max-upload-mb", "2048"];
      this.proxy = this.spawnLogged(this.proxyExe(), proxyArgs, { ...process.env, PYTHONUNBUFFERED: "1" }, join(paths.logs, "proxy.log"), "comfy-api-proxy");
      this.proxyUrl = `http://127.0.0.1:${proxyPort}`;
      await waitHttp(`${this.proxyUrl}/api/v2/health`, 60_000, () => current() && this.proxy?.exitCode === null);

      const version = await comfyVersion(this.comfyUrl);
      const missing = await this.missingNodes(recipe);
      check();
      this.set({ phase: "ready", tier, comfyui: { running: true, url: this.proxyUrl, version }, memoryUsedGb: await this.sampleMemoryGb(), ...(missing ? { error: missing } : {}) });
      log(`ComfyUI ${version ?? ""} ready behind comfy-api-proxy at ${this.proxyUrl}`);
      if (missing) log(missing);
      clearInterval(this.memoryTimer);
      this.memoryTimer = setInterval(() => void this.refreshMemory(), 10_000);
      this.memoryTimer.unref();
    } catch (err) {
      if (!current()) throw err; // stop() owns the processes and the phase now
      await this.killAll();
      this.set({ phase: "error", comfyui: { running: false, url: null, version: null }, error: errorMessage(err) });
      throw err;
    }
  }

  /**
   * The node types the tier's workflows use that ComfyUI did not load, said plainly, or undefined. A pack that fails to
   * import only logs a warning in ComfyUI; this makes it visible before a job runs into it.
   */
  private async missingNodes(recipe: Recipe): Promise<string | undefined> {
    if (!this.deps.workflowsDir || !this.comfyUrl) return undefined;
    try {
      const res = await fetch(`${this.comfyUrl}/object_info`, { signal: AbortSignal.timeout(60_000) });
      const info = (await res.json()) as Record<string, unknown>;
      return missingNodeClasses(await workflowNodeClasses(recipe, this.deps.workflowsDir), Object.keys(info));
    } catch (err) {
      this.deps.log(`could not list ComfyUI's node types: ${errorMessage(err)}`);
      return undefined;
    }
  }

  private spawnLogged(cmd: string, args: string[], env: NodeJS.ProcessEnv, logPath: string, name: string): ChildProcess {
    const out: WriteStream = createWriteStream(logPath, { flags: "a" });
    out.write(`\n==== ${new Date().toISOString()} ${name} ${args.join(" ")}\n`);
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout?.pipe(out, { end: false });
    child.stderr?.pipe(out, { end: false });
    child.on("exit", (code, signal) => {
      out.end(`==== ${name} exited (code ${code}, signal ${signal})\n`);
      void this.onExit(child, name, code, signal);
    });
    child.on("error", (err) => this.deps.log(`${name} failed to start: ${err.message}`));
    return child;
  }

  private async onExit(child: ChildProcess, name: string, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.stopping || (child !== this.comfy && child !== this.proxy)) return;
    if (this.state.phase !== "ready") return; // launch() handles failures while starting
    this.deps.log(`${name} exited unexpectedly (code ${code}, signal ${signal}); restarting`);
    await this.killAll();
    const gen = this.generation;
    let reason = `${name} stopped (code ${code})`;
    // A relaunch that fails counts as another crash; keep trying until the crash budget is spent.
    for (;;) {
      const now = Date.now();
      this.crashes = [...this.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
      if (this.crashes.length >= MAX_CRASHES) {
        this.set({ phase: "error", comfyui: { running: false, url: null, version: null }, error: `${name} keeps crashing. See logs/${name === "ComfyUI" ? "comfyui" : "proxy"}.log` });
        return;
      }
      this.set({ phase: "starting", comfyui: { running: false, url: null, version: null }, error: `${reason}; restarting` });
      await sleep(2000 * this.crashes.length);
      if (gen !== this.generation || this.stopping || !this.tier) return;
      try {
        await this.start(this.tier);
        return;
      } catch (err) {
        if (gen !== this.generation) return;
        reason = `Restart failed: ${errorMessage(err)}`;
      }
    }
  }

  /** Stops ComfyUI and the proxy, including a launch that is still starting up. */
  async stop(): Promise<void> {
    this.generation++;
    this.stopping = true;
    const inflight = this.starting;
    await this.killAll(); // the launch sees its process die (or the new generation) and gives up
    await inflight?.catch(() => undefined);
    await this.killAll();
    this.markStopped();
  }

  async restart(tier: string): Promise<void> {
    await this.stop();
    await this.start(tier);
  }

  /** Keep status().memoryUsedGb current; only announce changes of half a GB or more. */
  private async refreshMemory(): Promise<void> {
    if (this.state.phase !== "ready") return;
    const gb = await this.sampleMemoryGb();
    if (gb !== null && Math.abs(gb - (this.state.memoryUsedGb ?? 0)) >= 0.5) this.set({ memoryUsedGb: gb });
  }

  private async killAll(): Promise<void> {
    clearInterval(this.memoryTimer);
    const children = [this.proxy, this.comfy].filter((c): c is ChildProcess => !!c && c.exitCode === null && c.signalCode === null);
    this.proxy = undefined;
    this.comfy = undefined;
    await Promise.all(children.map((c) => killGracefully(c)));
  }

  baseUrl(): string | null {
    return this.state.phase === "ready" ? (this.proxyUrl ?? null) : null;
  }

  /** ComfyUI's own address behind the proxy while it runs, for diagnostics. Jobs always go through the proxy. */
  comfyUiUrl(): string | null {
    return this.state.phase === "ready" ? (this.comfyUrl ?? null) : null;
  }

  /** Other programs on the card ComfyUI uses, from nvidia-smi. */
  private async otherGpuUse(): Promise<OtherGpuUse | null> {
    const pid = this.comfy?.pid;
    const apps = pid ? await readComputeApps() : null;
    return pid && apps ? otherGpuUse(apps, pid) : null;
  }

  /**
   * CUDA: memory PyTorch's allocator holds (torch_vram_total). MPS and CPU report whole-machine numbers
   * there, so on those the ComfyUI process's resident memory is used instead.
   */
  async sampleMemoryGb(): Promise<number | null> {
    if (!this.comfyUrl) return null;
    try {
      const res = await fetch(`${this.comfyUrl}/system_stats`, { signal: AbortSignal.timeout(3000) });
      const j = (await res.json()) as { devices?: { type?: string; torch_vram_total?: number }[] };
      const dev = j.devices?.[0];
      if (dev?.type === "cuda" && typeof dev.torch_vram_total === "number") return round1(dev.torch_vram_total / 1024 ** 3);
      const pid = this.comfy?.pid;
      if (!pid || process.platform === "win32") return null;
      const { stdout, code } = await execCapture("ps", ["-o", "rss=", "-p", String(pid)]);
      const kb = Number(stdout.trim());
      return code === 0 && kb > 0 ? round1(kb / 1024 ** 2) : null;
    } catch {
      return null;
    }
  }
}

/** SIGTERM, then SIGKILL after 10 s. Only ever our own child, by PID. */
export function killGracefully(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("exit", () => {
      clearTimeout(t);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export async function httpOk(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

export async function waitHttp(url: string, timeoutMs: number, alive: () => boolean): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive()) throw new Error(`process exited before ${new URL(url).pathname} answered (see the logs folder)`);
    if (await httpOk(url, 3000)) return;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function comfyVersion(comfyUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${comfyUrl}/system_stats`, { signal: AbortSignal.timeout(3000) });
    const j = (await res.json()) as { system?: { comfyui_version?: string } };
    return j.system?.comfyui_version ?? null;
  } catch {
    return null;
  }
}
