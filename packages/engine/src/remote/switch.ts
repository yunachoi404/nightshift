/**
 * This machine's runtime, or a GPU computer on the network (Settings.remote), switchable while the engine runs. The rest
 * of the engine holds this one object. Only the selected runtime's events reach the bus: the one being left may still
 * finish a job, and must never show up as the current runtime meanwhile.
 */
import type { RuntimeStatus } from "@nightshift/contract";
import { EventBus } from "../events.js";
import type { Runtime } from "../runtime/runtime.js";

export class RuntimeSwitch implements Runtime {
  private readonly local: Runtime;
  private current: Runtime;
  private remote?: { url: string; runtime: Runtime };
  /** Runtimes left behind that may still run: release() and stop() stop them. */
  private readonly retired = new Set<Runtime>();

  constructor(
    private readonly bus: EventBus,
    makeLocal: (bus: EventBus) => Runtime,
    /** The runtime for a GPU computer on the network (a RemoteRuntime). */
    private readonly makeRemote: (bus: EventBus, url: string) => Runtime,
  ) {
    let local: Runtime | undefined;
    local = makeLocal(this.gate(() => local));
    this.local = local;
    this.current = local;
  }

  get mode(): Runtime["mode"] {
    return this.current.mode;
  }

  /** The GPU computer jobs go to, or null for this machine. */
  get remoteUrl(): string | null {
    return this.remote && this.current === this.remote.runtime ? this.remote.url : null;
  }

  /**
   * Send work to the ComfyUI at `url` from now on, or to this machine (null). Nothing starts or stops here: the runtime
   * left behind keeps running (a job on it finishes) until release() or stop(), and the new one starts with start().
   */
  select(url: string | null): void {
    let next: Runtime;
    if (url === null) next = this.local;
    else if (this.remote?.url === url) next = this.remote.runtime;
    else {
      if (this.remote) this.retired.add(this.remote.runtime);
      let created: Runtime | undefined;
      created = this.makeRemote(this.gate(() => created), url);
      this.remote = { url, runtime: created };
      next = created;
    }
    if (next === this.current) return;
    this.retired.add(this.current);
    this.retired.delete(next);
    this.current = next;
    this.bus.emit({ type: "runtime", status: next.status() });
  }

  /** Stops the runtimes no longer selected. */
  async release(): Promise<void> {
    const left = [...this.retired];
    this.retired.clear();
    await Promise.all(left.map((r) => r.stop()));
  }

  /** A bus that forwards a runtime's events only while it is the selected one. */
  private gate(self: () => Runtime | undefined): EventBus {
    const inner = new EventBus();
    inner.subscribe((e) => {
      if (self() === this.current) this.bus.emit(e);
    });
    return inner;
  }

  status(): RuntimeStatus {
    return this.current.status();
  }

  start(tier: string): Promise<void> {
    return this.current.start(tier);
  }

  /** Stops the selected runtime and every one left behind. */
  async stop(): Promise<void> {
    await Promise.all([this.current.stop(), this.release()]);
  }

  restart(tier: string): Promise<void> {
    return this.current.restart(tier);
  }

  baseUrl(): string | null {
    return this.current.baseUrl();
  }

  available(): boolean {
    return this.current.available();
  }

  noteLost(): void {
    this.current.noteLost();
  }

  sampleMemoryGb(): Promise<number | null> {
    return this.current.sampleMemoryGb();
  }

  setPhase(phase: "not_installed" | "installing" | "starting" | "error", tier: string | null, error?: string): void {
    this.current.setPhase(phase, tier, error);
  }

  setGpuBusy(busy: boolean): void {
    this.current.setGpuBusy(busy);
  }
}
