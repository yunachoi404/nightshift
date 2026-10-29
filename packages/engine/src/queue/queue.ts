/**
 * Two workers. The GPU worker runs one job at a time: interactive work (storyboard text, stills, drafts, audio) before
 * finals, and finals queued for the night only in the overnight window. The CPU worker runs exports and audio
 * analysis, one at a time, beside the GPU work, so an export never holds up a draft. Every job is persisted, so a
 * restart picks the queue back up (remote work is followed by its saved ComfyUI job id when it survives).
 *
 * A queued job's message says what it waits for: the GPU, the overnight window, or (an export) the jobs of its
 * project queued before it.
 */
import type { Job, OtherGpuUse, Settings } from "@nightshift/contract";
import { failureMessage, isRuntimeLost, ShutdownError } from "../errors.js";
import type { EventBus } from "../events.js";
import { inWindow } from "../settings.js";
import { errorMessage, isAbortError, nowIso, type Logger } from "../util.js";
import type { JobPayload, JobStore, StoredJob } from "./store.js";

export const FINAL_STEPS: ReadonlySet<Job["step"]> = new Set(["video_final_same_take", "video_final_remaster"]);

export type Lane = "gpu" | "cpu";
const LANES: readonly Lane[] = ["gpu", "cpu"];

/** Exports and analysis jobs need no GPU: they run on the CPU worker. */
export function laneOf(job: Job): Lane {
  return job.step === "export" || job.analysis ? "cpu" : "gpu";
}

/** 0 = interactive, 1 = finals to run now, 2 = finals for the night. Lower runs first. */
export function jobPriority(job: Job): number {
  if (!FINAL_STEPS.has(job.step)) return 0;
  return job.mode === "overnight" ? 2 : 1;
}

/** Overnight jobs only start inside the overnight window, and only when overnight mode is on. */
export function isEligible(job: Job, settings: Settings, now: Date): boolean {
  if (job.mode !== "overnight") return true;
  return settings.overnight.enabled && inWindow(now, settings.overnight.startAt, settings.overnight.endAt);
}

/** A job put back after the runtime went away waits until this time (ms since epoch). */
function notBefore(entry: StoredJob): number {
  return typeof entry.payload._notBefore === "number" ? entry.payload._notBefore : 0;
}

export function pickNext(entries: StoredJob[], settings: Settings, now: Date, canStart: (job: Job) => boolean): StoredJob | undefined {
  return entries
    .filter((e) => e.job.status === "queued" && notBefore(e) <= now.getTime() && isEligible(e.job, settings, now) && canStart(e.job))
    .sort((a, b) => jobPriority(a.job) - jobPriority(b.job) || a.seq - b.seq)[0];
}

const NOUN: Partial<Record<Job["step"], string>> = { text: "shot list", still: "still", video_draft: "draft", video_what_if: "film", music: "song", voice: "voiceover" };

/**
 * The jobs an export waits for, of its own project: the stills, drafts, songs, voices and shot lists queued before it
 * (it renders what they make, as when everything shared one worker), and the analysis of any song or voice on its way
 * to the cut, whenever that was queued (a song made before the export is placed by an analysis job queued after it).
 * Never finals, which can take all night. The queue only counts GPU jobs that run or could start now, so an export
 * does not wait out a GPU that is away.
 */
export function awaitedBy(entry: StoredJob, entries: Iterable<StoredJob>): StoredJob[] {
  if (entry.job.step !== "export") return [];
  return [...entries].filter(
    (e) =>
      e !== entry &&
      e.job.projectId === entry.job.projectId &&
      (e.job.status === "queued" || e.job.status === "running") &&
      (e.job.analysis === true || (e.seq < entry.seq && laneOf(e.job) === "gpu" && jobPriority(e.job) === 0)),
  );
}

export interface ExecContext {
  signal: AbortSignal;
  progress(progress: number, message?: string): void;
  /** Save a value in the job's persisted payload (it survives retries and restarts). */
  remember(key: string, value: unknown): void;
}

export interface ExecResult {
  outputAssetIds: string[];
  message?: string;
  peakGb?: number;
}

export interface QueueHooks {
  /** Why the job cannot start now, in plain words ("Waiting for the GPU"), or undefined when it can. */
  blocked?(job: Job): string | undefined;
  execute(job: Job, payload: JobPayload, ctx: ExecContext): Promise<ExecResult>;
  /** After a job fails or is cancelled: undo whatever was set up for it (a pending take, say). */
  onSettled?(job: Job, payload: JobPayload): Promise<void>;
  /** A job lost its runtime mid-run: look at the runtime again now, so the jobs waiting for it say so at once. */
  onRuntimeLost?(job: Job): void;
}

export interface QueueOptions {
  settings: () => Settings;
  clock?: () => Date;
  log?: Logger;
  /** How often to re-check the overnight window and the waiting messages, ms. */
  tickMs?: number;
  keepFinished?: number;
  /** First wait before retrying a job whose runtime went away, ms. Doubles each time, up to 10x. */
  retryDelayMs?: number;
  /** A job fails once its runtime went away this many times while it ran. Time spent waiting for the GPU never counts. */
  maxRuntimeLosses?: number;
  /** What other programs hold on the GPU right now, if the runtime can tell: a GPU job that ran out of memory says so. */
  otherGpuUse?: () => OtherGpuUse | undefined;
}

export const WAITING_FOR_GPU = "Waiting for the GPU";

/**
 * When ComfyUI disappears mid-job (a restart, a preemption on a shared GPU box, an ssh tunnel that dropped), the job goes back in
 * the queue. It waits for the GPU for as long as it takes, then runs again (following its ComfyUI job if that is still
 * alive). Only the times it lost the GPU while running count: after this many it fails, so a job that crashes ComfyUI
 * every time does not loop all night.
 */
export const MAX_RUNTIME_LOSSES = 8;

interface Active {
  entry: StoredJob;
  controller: AbortController;
  done: Promise<void>;
}

export class JobQueue {
  private entries = new Map<string, StoredJob>();
  private hooks?: QueueHooks;
  private active = new Map<Lane, Active>();
  private scheduled = false;
  /** Holds the GPU worker (exclusive()). */
  private held = 0;
  private stopped = true;
  private timer?: NodeJS.Timeout;
  /** The wait message each queued job shows, so it is announced once and cleared when the wait is over. */
  private waiting = new Map<string, string>();
  private lastEmit = new Map<string, number>();
  private trailing = new Map<string, NodeJS.Timeout>();
  private lastPersist = new Map<string, number>();

  constructor(
    private readonly store: JobStore,
    private readonly bus: EventBus,
    private readonly opts: QueueOptions,
  ) {
    for (const entry of store.all()) {
      if (entry.job.status === "running") {
        entry.job = { ...entry.job, status: "queued", progress: 0, message: "Restarted after the engine stopped" };
        delete entry.job.startedAt;
        store.put(entry);
      }
      this.entries.set(entry.job.id, entry);
    }
  }

  private now(): Date {
    return this.opts.clock?.() ?? new Date();
  }

  start(hooks: QueueHooks): void {
    this.hooks = hooks;
    this.stopped = false;
    this.timer = setInterval(() => this.kick(), this.opts.tickMs ?? 20_000);
    this.timer.unref();
    this.kick();
  }

  /** Stops local workers. Running jobs are re-queued; surviving remote work is followed on the next start. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    const running = [...this.active.values()];
    for (const a of running) a.controller.abort(new ShutdownError());
    await Promise.all(running.map((a) => a.done.catch(() => undefined)));
  }

  enqueue(job: Job, payload: JobPayload): Job {
    const entry: StoredJob = { job, payload, seq: this.store.nextSeq() };
    this.entries.set(job.id, entry);
    this.store.put(entry);
    this.emit(entry, true);
    this.kick();
    return job;
  }

  get(id: string): Job | undefined {
    return this.entries.get(id)?.job;
  }

  /** Running first, then queued in run order, then finished jobs newest first. */
  list(filter: { projectId?: string } = {}): Job[] {
    const all = [...this.entries.values()].filter((e) => !filter.projectId || e.job.projectId === filter.projectId);
    const running = all.filter((e) => e.job.status === "running").sort((a, b) => a.seq - b.seq);
    const queued = all.filter((e) => e.job.status === "queued").sort((a, b) => jobPriority(a.job) - jobPriority(b.job) || a.seq - b.seq);
    const finished = all.filter((e) => !["running", "queued"].includes(e.job.status)).sort((a, b) => b.seq - a.seq);
    return [...running, ...queued, ...finished].map((e) => e.job);
  }

  async cancel(id: string): Promise<Job | undefined> {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const active = [...this.active.values()].find((a) => a.entry === entry);
    if (entry.job.status === "queued") {
      this.waiting.delete(id);
      this.update(entry, { status: "cancelled", finishedAt: nowIso(), message: "Cancelled" }, true);
      await this.hooks?.onSettled?.(entry.job, entry.payload).catch(() => undefined);
      this.kick(); // an export may have been waiting for it
    } else if (entry.job.status === "running" && active) {
      active.controller.abort();
      await active.done.catch(() => undefined);
    }
    return entry.job;
  }

  /** Cancel every queued or running job of a project (used when it is deleted). */
  async cancelProject(projectId: string): Promise<void> {
    for (const e of [...this.entries.values()]) {
      if (e.job.projectId === projectId && (e.job.status === "queued" || e.job.status === "running")) await this.cancel(e.job.id);
    }
  }

  /** Run `fn` while no GPU job is running and none may start, e.g. restarting ComfyUI with new flags. CPU jobs go on. */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.held++;
    try {
      for (let gpu = this.active.get("gpu"); gpu; gpu = this.active.get("gpu")) await gpu.done.catch(() => undefined);
      return await fn();
    } finally {
      this.held--;
      this.kick();
    }
  }

  /** The GPU is back: jobs that lost it stop pausing before their next try. */
  retryNow(): void {
    for (const entry of this.entries.values()) {
      if (entry.job.status !== "queued" || notBefore(entry) === 0) continue;
      entry.payload = { ...entry.payload, _notBefore: 0 };
      this.store.put(entry);
    }
    this.kick();
  }

  /** The job on the GPU right now. */
  get runningJob(): Job | undefined {
    return this.active.get("gpu")?.entry.job;
  }

  /** Re-check what can run: call when a job is added, settings change, or the runtime changes. */
  kick(): void {
    if (this.stopped || this.scheduled || !this.hooks) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.stopped) return;
      this.refreshWaiting();
      for (const lane of LANES) void this.runNext(lane);
    });
  }

  /** What a queued job waits for, or undefined when it may start now. */
  private waitReason(entry: StoredJob, settings: Settings, now: Date): string | undefined {
    const job = entry.job;
    if (!isEligible(job, settings, now)) {
      const { enabled, startAt, endAt } = settings.overnight;
      return enabled ? `Runs tonight, ${startAt} to ${endAt}` : "Runs when overnight mode is on";
    }
    const blocked = this.hooks?.blocked?.(job);
    if (blocked) return blocked;
    const before = awaitedBy(entry, this.entries.values()).filter((e) => e.job.status === "running" || laneOf(e.job) === "cpu" || this.waitReason(e, settings, now) === undefined);
    if (before.length === 1) {
      const only = before[0]!.job;
      return only.analysis ? `Waiting for the ${NOUN[only.step]} to be measured` : `Waiting for the ${NOUN[only.step] ?? "job"} queued before it`;
    }
    if (before.length > 1) return `Waiting for ${before.length} jobs of this project`;
    const wait = notBefore(entry) - now.getTime();
    if (wait > 0) return `The GPU went away. Trying again in ${describeWait(wait)}.`;
    return undefined;
  }

  /** Give every queued job the message of what it waits for; clear it once the wait is over. */
  private refreshWaiting(): void {
    const settings = this.opts.settings();
    const now = this.now();
    for (const entry of this.entries.values()) {
      if (entry.job.status !== "queued") continue;
      const id = entry.job.id;
      const reason = this.waitReason(entry, settings, now);
      const shown = this.waiting.get(id);
      if (reason === shown) continue;
      if (reason !== undefined) {
        this.waiting.set(id, reason);
        this.update(entry, { message: reason }, true);
      } else {
        this.waiting.delete(id);
        const { message: _, ...rest } = entry.job;
        entry.job = rest;
        this.update(entry, {}, true);
      }
    }
  }

  private async runNext(lane: Lane): Promise<void> {
    const hooks = this.hooks;
    if (!hooks || this.stopped || this.active.has(lane) || (lane === "gpu" && this.held > 0)) return;
    const settings = this.opts.settings();
    const now = this.now();
    const inLane = [...this.entries.values()].filter((e) => laneOf(e.job) === lane);
    const entry = pickNext(inLane, settings, now, (j) => this.waitReason(this.entries.get(j.id)!, settings, now) === undefined);
    if (!entry) return;
    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((r) => (finish = r));
    this.active.set(lane, { entry, controller, done });
    this.waiting.delete(entry.job.id);
    this.update(entry, { status: "running", startedAt: nowIso(), progress: 0, message: "Starting" }, true);
    try {
      const result = await hooks.execute(entry.job, entry.payload, {
        signal: controller.signal,
        progress: (progress, message) => {
          if (controller.signal.aborted) return;
          const p = Math.max(entry.job.progress, Math.min(0.99, progress));
          this.update(entry, message === undefined ? { progress: p } : { progress: p, message }, false);
        },
        remember: (key, value) => {
          entry.payload = { ...entry.payload, [key]: value };
          this.store.put(entry);
        },
      });
      const patch: Partial<Job> = { status: "done", progress: 1, finishedAt: nowIso(), outputAssetIds: result.outputAssetIds, message: result.message ?? "Done" };
      if (result.peakGb !== undefined) patch.peakGb = result.peakGb;
      this.update(entry, patch, true);
    } catch (err) {
      if (controller.signal.reason instanceof ShutdownError) {
        // Engine shutting down: leave it queued so the next start runs it again.
        const { startedAt: _, ...rest } = entry.job;
        entry.job = rest;
        this.update(entry, { status: "queued", progress: 0, message: "Waiting for the engine to restart" }, true);
      } else if (!controller.signal.aborted && lane === "gpu" && isRuntimeLost(err)) {
        await this.onLost(entry, err, hooks);
      } else if (controller.signal.aborted || isAbortError(err)) {
        this.update(entry, { status: "cancelled", finishedAt: nowIso(), message: "Cancelled" }, true);
        await hooks.onSettled?.(entry.job, entry.payload).catch(() => undefined);
      } else {
        const error = errorMessage(err);
        this.opts.log?.(`job ${entry.job.id} (${entry.job.step}) failed: ${error}`);
        this.update(entry, { status: "failed", finishedAt: nowIso(), error, message: this.failure(lane, error) }, true);
        await hooks.onSettled?.(entry.job, entry.payload).catch(() => undefined);
      }
    } finally {
      this.active.delete(lane);
      finish();
      this.store.prune(this.opts.keepFinished ?? 1000);
      this.kick();
    }
  }

  /** The runtime went away under a running job: back in the queue to wait for it, unless that keeps happening. */
  private async onLost(entry: StoredJob, err: unknown, hooks: QueueHooks): Promise<void> {
    const losses = Number(entry.payload._losses ?? 0) + 1;
    const max = this.opts.maxRuntimeLosses ?? MAX_RUNTIME_LOSSES;
    if (losses >= max) {
      const error = `${errorMessage(err)} (the GPU went away ${losses} times while this job ran, so it stopped trying)`;
      this.opts.log?.(`job ${entry.job.id} (${entry.job.step}) failed: ${error}`);
      this.update(entry, { status: "failed", finishedAt: nowIso(), error, message: this.failure("gpu", error) }, true);
      await hooks.onSettled?.(entry.job, entry.payload).catch(() => undefined);
      return;
    }
    const base = this.opts.retryDelayMs ?? 30_000;
    const delay = Math.min(base * 10, base * 2 ** (losses - 1));
    this.opts.log?.(`job ${entry.job.id}: the runtime went away (${errorMessage(err)}); it waits for the GPU, then tries again (${losses} of ${max})`);
    entry.payload = { ...entry.payload, _losses: losses, _notBefore: this.now().getTime() + delay };
    const { startedAt: _, ...rest } = entry.job;
    entry.job = rest;
    const message = `The GPU went away. Trying again in ${describeWait(delay)}.`;
    this.update(entry, { status: "queued", progress: 0, message }, true);
    this.waiting.set(entry.job.id, message);
    hooks.onRuntimeLost?.(entry.job);
    setTimeout(() => this.kick(), delay + 50).unref();
  }

  /** A failed job's message: "Failed", or on the GPU a plain reason when it ran out of memory (see failureMessage). */
  private failure(lane: Lane, error: string): string {
    return lane === "gpu" ? failureMessage(error, this.opts.otherGpuUse?.()) : "Failed";
  }

  private update(entry: StoredJob, patch: Partial<Job>, important: boolean): void {
    entry.job = { ...entry.job, ...patch };
    const now = Date.now();
    const id = entry.job.id;
    if (important || now - (this.lastPersist.get(id) ?? 0) > 3000) {
      this.store.put(entry);
      this.lastPersist.set(id, now);
    }
    this.emit(entry, important);
    if (important && entry.job.status !== "running" && entry.job.status !== "queued") {
      this.lastEmit.delete(id);
      this.lastPersist.delete(id);
      this.waiting.delete(id);
    }
  }

  /** At most five progress events a second per job; a skipped update is sent at the end of the window. */
  private emit(entry: StoredJob, important: boolean): void {
    const id = entry.job.id;
    const wait = 200 - (Date.now() - (this.lastEmit.get(id) ?? 0));
    if (!important && wait > 0) {
      if (!this.trailing.has(id)) {
        const t = setTimeout(() => {
          this.trailing.delete(id);
          this.lastEmit.set(id, Date.now());
          this.bus.emit({ type: "job", job: entry.job });
        }, wait);
        t.unref();
        this.trailing.set(id, t);
      }
      return;
    }
    clearTimeout(this.trailing.get(id));
    this.trailing.delete(id);
    this.lastEmit.set(id, Date.now());
    this.bus.emit({ type: "job", job: entry.job });
  }
}

function describeWait(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`;
}

