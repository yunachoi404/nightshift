/**
 * A GPU computer on the network (Settings.remote): its ComfyUI runs there, comfy-api-proxy runs here and points at it,
 * and every job goes through the proxy with the Comfy SDK as in local mode. Like attach mode, the remote can go away for
 * hours (a shared box gives way to other work) and come back by itself: the runtime stays "ready" with
 * `comfyui.running` false meanwhile, GPU jobs wait, the rest of the app goes on. The proxy is ours, so a crashed one is
 * restarted, as local mode does.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { EventBus } from "../events.js";
import { proxyExe } from "../install/proxy.js";
import { BaseRuntime, freePort, httpOk, killGracefully, probeProxy, waitHttp, type Runtime } from "../runtime/runtime.js";
import { errorMessage, sleep, type Logger } from "../util.js";
import { readSystemStats, remoteLabel } from "./check.js";

export interface RemoteRuntimeDeps {
  /** The remote ComfyUI, normalized ("http://spark:8190"). */
  comfyUrl: string;
  proxyVenv: string;
  /** The proxy's state for this remote only: its index of uploaded files must never point at another ComfyUI's inputs. */
  stateDir: string;
  logFile: string;
  log: Logger;
  /** Install the proxy if it is missing. */
  prepare: () => Promise<void>;
  /** What the remote lacks for `tier`, in plain words, or undefined. Asked each time it comes up. */
  problems: (tier: string) => Promise<string | undefined>;
  /** How often to look at the proxy and the remote, ms. */
  checkMs?: number;
}

const MAX_CRASHES = 4;
const CRASH_WINDOW_MS = 10 * 60_000;

export class RemoteRuntime extends BaseRuntime implements Runtime {
  readonly mode = "remote" as const;
  private proxy?: ChildProcess;
  private proxyUrl?: string;
  private tier: string | null = null;
  private starting?: Promise<void>;
  private checking?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private crashes: number[] = [];
  /** Whether the remote answered at the last check; when it comes back, it is looked at again. */
  private answered = false;
  /** What the remote lacked the last time it came up. */
  private problem?: string;
  /** Bumped by stop(): work from an older generation spawns and announces nothing more. */
  private generation = 0;

  constructor(
    bus: EventBus,
    private readonly d: RemoteRuntimeDeps,
  ) {
    super(bus);
  }

  get url(): string {
    return this.d.comfyUrl;
  }

  private get label(): string {
    return `The GPU computer at ${remoteLabel(this.d.comfyUrl)}`;
  }

  async start(tier: string): Promise<void> {
    if (this.state.phase === "ready" && this.proxy) {
      if (tier !== this.tier) this.set({ tier });
      this.tier = tier;
      this.answered = false; // a new tier may need what the old one did not
      return this.check();
    }
    this.tier = tier;
    this.starting ??= this.launch(tier, this.generation).finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async launch(tier: string, gen: number): Promise<void> {
    const current = () => gen === this.generation;
    this.answered = false;
    this.problem = undefined;
    this.set({ phase: "starting", tier, comfyui: { running: false, url: this.d.comfyUrl, version: null }, memoryUsedGb: null }, true);
    try {
      await this.d.prepare();
      if (!current()) throw new Error("Start was cancelled");
      await this.spawnProxy(gen);
      if (!current()) throw new Error("Start was cancelled");
      this.d.log(`comfy-api-proxy at ${this.proxyUrl} sends jobs to ${this.d.comfyUrl}`);
      // Ready from here on, whether or not the remote answers right now: jobs wait for it.
      await this.probe(true);
      clearInterval(this.timer);
      this.timer = setInterval(() => void this.check(), this.d.checkMs ?? 10_000);
      this.timer.unref();
    } catch (err) {
      if (!current()) throw err; // stop() owns the proxy and the phase now
      await this.killProxy();
      this.set({ phase: "error", comfyui: { running: false, url: this.d.comfyUrl, version: null }, error: errorMessage(err) });
      throw err;
    }
  }

  private async spawnProxy(gen: number): Promise<void> {
    const port = await freePort();
    await mkdir(this.d.stateDir, { recursive: true });
    await mkdir(dirname(this.d.logFile), { recursive: true });
    if (gen !== this.generation) throw new Error("Start was cancelled");
    const args = ["run", "--comfyui", this.d.comfyUrl, "--port", String(port), "--state-dir", this.d.stateDir, "--max-upload-mb", "2048"];
    const out = createWriteStream(this.d.logFile, { flags: "a" });
    out.write(`\n==== ${new Date().toISOString()} comfy-api-proxy ${args.join(" ")}\n`);
    const child = spawn(proxyExe(this.d.proxyVenv), args, { env: { ...process.env, PYTHONUNBUFFERED: "1" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    child.stdout?.pipe(out, { end: false });
    child.stderr?.pipe(out, { end: false });
    child.on("error", (err) => this.d.log(`comfy-api-proxy failed to start: ${err.message}`));
    child.on("exit", (code, signal) => {
      out.end(`==== comfy-api-proxy exited (code ${code}, signal ${signal})\n`);
      void this.onExit(child, code);
    });
    this.proxy = child;
    this.proxyUrl = `http://127.0.0.1:${port}`;
    await waitHttp(`${this.proxyUrl}/api/v2/health`, 60_000, () => gen === this.generation && child.exitCode === null);
  }

  /** One check at a time; a call during a check waits for it. */
  private check(): Promise<void> {
    this.checking ??= this.probe().finally(() => (this.checking = undefined));
    return this.checking;
  }

  /**
   * Asks for the remote through the proxy, as jobs reach it. A network that drops packets makes the proxy wait rather
   * than fail, so no answer in time counts as the remote being away too, unless the proxy itself does not answer. When
   * the remote comes back it is looked at again: its ComfyUI version, and what it lacks for the tier.
   */
  private async probe(launching = false): Promise<void> {
    const gen = this.generation;
    const tier = this.tier;
    if (!tier || !this.proxyUrl || (this.state.phase !== "ready" && !launching)) return;
    const proxyUrl = this.proxyUrl;
    const health = await probeProxy(proxyUrl, 8000);
    const proxyDown = health === "proxy_down" && !(await httpOk(`${proxyUrl}/api/v2/health`, 2000));
    if (gen !== this.generation) return;
    const running = health === "up";
    let version = this.state.comfyui.version;
    if (running && !this.answered) {
      version = (await readSystemStats(this.d.comfyUrl, 4000).catch(() => undefined))?.system?.comfyui_version ?? version;
      this.problem = await this.d.problems(tier).catch((err: unknown) => {
        this.d.log(`could not list what ${this.d.comfyUrl} has: ${errorMessage(err)}`);
        return undefined;
      });
      if (this.problem) this.d.log(this.problem);
    }
    if (gen !== this.generation || tier !== this.tier) return;
    const error = running
      ? this.problem
      : proxyDown
        ? "comfy-api-proxy on this computer is not answering. Jobs wait for it."
        : `${this.label} is not answering. It may be busy with other work or turned off. Jobs wait for it.`;
    const wasAnswering = this.answered;
    this.answered = running;
    if (this.state.phase === "ready" && this.state.comfyui.running === running && this.state.error === error && this.state.comfyui.version === version) return;
    if (running !== wasAnswering || launching) this.d.log(running ? `${this.d.comfyUrl} answers` : error!);
    const status = { phase: "ready" as const, comfyui: { running, url: this.d.comfyUrl, version } };
    this.set(error ? { ...status, error } : status);
  }

  noteLost(): void {
    void this.check();
  }

  private async onExit(child: ChildProcess, code: number | null): Promise<void> {
    if (child !== this.proxy) return; // stopped or replaced
    this.proxy = undefined;
    if (this.state.phase !== "ready") return; // launch() handles failures while starting
    this.d.log(`comfy-api-proxy exited unexpectedly (code ${code}); restarting`);
    clearInterval(this.timer);
    // Nothing reaches the remote until the proxy is back: jobs wait rather than start against a dead one.
    this.answered = false;
    this.set({ comfyui: { ...this.state.comfyui, running: false }, error: `comfy-api-proxy stopped (code ${code}); restarting` });
    const gen = this.generation;
    for (;;) {
      const now = Date.now();
      this.crashes = [...this.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
      if (this.crashes.length >= MAX_CRASHES) {
        this.set({ phase: "error", comfyui: { running: false, url: this.d.comfyUrl, version: null }, error: "comfy-api-proxy keeps crashing. See logs/proxy-remote.log" });
        return;
      }
      await sleep(2000 * this.crashes.length);
      if (gen !== this.generation || !this.tier) return;
      try {
        await this.start(this.tier);
        return;
      } catch {
        if (gen !== this.generation) return;
      }
    }
  }

  private async killProxy(): Promise<void> {
    const child = this.proxy;
    this.proxy = undefined;
    if (child && child.exitCode === null && child.signalCode === null) await killGracefully(child);
  }

  /** Stops the proxy, including a start still under way. The remote's ComfyUI is never touched. */
  async stop(): Promise<void> {
    this.generation++;
    clearInterval(this.timer);
    this.timer = undefined;
    const inflight = this.starting;
    await this.killProxy();
    await inflight?.catch(() => undefined);
    await this.killProxy();
    this.answered = false;
    this.markStopped();
  }

  /** The memory limit is the remote's own business; a new tier is looked at again. */
  async restart(tier: string): Promise<void> {
    await this.start(tier);
  }

  baseUrl(): string | null {
    return this.state.phase === "ready" ? (this.proxyUrl ?? null) : null;
  }

  /**
   * Not measured. The remote's PyTorch figure (torch_vram_total) misses most of what a GB10 holds under ComfyUI's dynamic
   * VRAM (6.9 GB for a Krea 2 still the lab measured at 32.9), and a wrong number is worse than none.
   */
  async sampleMemoryGb(): Promise<number | null> {
    return null;
  }
}
