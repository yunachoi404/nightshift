import type { Job, Settings } from "@nightshift/contract";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeLostError } from "../src/errors.js";
import { EventBus } from "../src/events.js";
import { awaitedBy, isEligible, JobQueue, jobPriority, laneOf, modelKey, nightGroupFor, pickNext, runOrder, WAITING_FOR_GPU, type ExecContext, type QueueHooks, type QueueOptions } from "../src/queue/queue.js";
import { JobStore, type StoredJob } from "../src/queue/store.js";
import { DEFAULT_SETTINGS, inWindow } from "../src/settings.js";
import { sleep } from "../src/util.js";

let n = 0;
function job(step: Job["step"], mode: Job["mode"] = "now", extra: Partial<Job> = {}): Job {
  return { id: `job_${++n}`, projectId: "prj_1", step, mode, status: "queued", progress: 0, outputAssetIds: [], createdAt: new Date().toISOString(), ...extra };
}
const entries = (...jobs: Job[]): StoredJob[] => jobs.map((j, i) => ({ job: j, payload: {}, seq: i + 1 }));
const settings = (overnight: Partial<Settings["overnight"]> = {}): Settings => ({ ...DEFAULT_SETTINGS, overnight: { ...DEFAULT_SETTINGS.overnight, ...overnight } });
const at = (hhmm: string) => new Date(`2026-10-19T${hhmm}:00`);

describe("ordering", () => {
  it("interactive work first, then finals now, then overnight finals; FIFO within a class", () => {
    const finalNight = job("video_final_remaster", "overnight");
    const finalNow = job("video_final_same_take");
    const draft = job("video_draft");
    const still = job("still");
    expect([finalNight, finalNow, draft, still].map(jobPriority)).toEqual([2, 1, 0, 0]);
    const night = settings({ enabled: true });
    const order: string[] = [];
    let list = entries(finalNight, finalNow, draft, still);
    for (;;) {
      const next = pickNext(list, night, at("23:30"), () => true);
      if (!next) break;
      order.push(next.job.step);
      list = list.filter((e) => e !== next);
    }
    expect(order).toEqual(["video_draft", "still", "video_final_same_take", "video_final_remaster"]);
  });

  it("overnight jobs wait for the window, and only when overnight mode is on", () => {
    const j = job("video_final_remaster", "overnight");
    expect(isEligible(j, settings({ enabled: true }), at("22:59"))).toBe(false);
    expect(isEligible(j, settings({ enabled: true }), at("23:00"))).toBe(true);
    expect(isEligible(j, settings({ enabled: true }), at("06:59"))).toBe(true);
    expect(isEligible(j, settings({ enabled: true }), at("07:00"))).toBe(false);
    expect(isEligible(j, settings({ enabled: false }), at("02:00"))).toBe(false);
    expect(isEligible(job("still"), settings(), at("12:00"))).toBe(true);
  });

  it("windows inside one day and the all-day window", () => {
    expect(inWindow(at("13:00"), "12:00", "14:00")).toBe(true);
    expect(inWindow(at("14:00"), "12:00", "14:00")).toBe(false);
    expect(inWindow(at("03:00"), "00:00", "00:00")).toBe(true);
  });

  it("jobs the runtime cannot start yet are skipped, not blocking others", () => {
    const draft = job("video_draft");
    const exp = job("export");
    const next = pickNext(entries(draft, exp), settings(), at("12:00"), (j) => j.step === "export");
    expect(next?.job.id).toBe(exp.id);
  });
});

describe("JobQueue", () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-queue-"));
  let queue: JobQueue | undefined;
  afterEach(async () => {
    await queue?.stop();
    queue = undefined;
  });

  function make(dbName: string, hooks: Partial<QueueHooks>, s: Settings = settings(), opts: Partial<QueueOptions> = {}) {
    const store = new JobStore(join(dir, dbName));
    const bus = new EventBus();
    const events: Job[] = [];
    bus.subscribe((e) => e.type === "job" && events.push(e.job));
    queue = new JobQueue(store, bus, { settings: () => s, retryDelayMs: 20, maxRuntimeLosses: 4, tickMs: 50, ...opts });
    const full: QueueHooks = { execute: async () => ({ outputAssetIds: [] }), ...hooks };
    return { store, queue, events, start: () => queue!.start(full) };
  }

  const until = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error("timed out");
      await sleep(10);
    }
  };

  it("runs one job at a time, in priority order, and reports progress", async () => {
    const ran: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const q = make("a.sqlite", {
      execute: async (j, _p, ctx: ExecContext) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        ctx.progress(0.5, "Halfway");
        // Long enough for the throttled progress event to go out before the job ends.
        await sleep(j.step === "still" ? 260 : 10);
        ran.push(j.step);
        running--;
        return { outputAssetIds: [`ast_${j.id}`], message: "ok" };
      },
    });
    q.queue.enqueue(job("video_final_same_take"), {});
    q.queue.enqueue(job("still"), {});
    q.queue.enqueue(job("music"), {});
    q.start();
    await until(() => ran.length === 3);
    expect(ran).toEqual(["still", "music", "video_final_same_take"]);
    expect(maxRunning).toBe(1);
    expect(q.queue.list().every((j) => j.status === "done" && j.progress === 1 && j.outputAssetIds.length === 1)).toBe(true);
    expect(q.events.some((j) => j.message === "Halfway")).toBe(true);
  });

  it("survives a restart: queued jobs stay queued, a running job is re-queued", async () => {
    const q1 = make("b.sqlite", { execute: () => new Promise(() => undefined) });
    const a = q1.queue.enqueue(job("video_draft"), { takeId: "take_1" });
    const b = q1.queue.enqueue(job("still"), { seed: 5 });
    q1.start();
    await until(() => q1.queue.get(a.id)?.status === "running");
    // Simulate a crash: no stop(), just drop the queue and reopen the database.
    queue = undefined;
    q1.store.close();

    const q2 = make("b.sqlite", {});
    const jobs = q2.queue.list();
    expect(jobs.map((j) => [j.id, j.status])).toEqual([
      [a.id, "queued"],
      [b.id, "queued"],
    ]);
    expect(q2.queue.get(a.id)?.message).toBe("Restarted after the engine stopped");
    expect(q2.store.all().find((e) => e.job.id === b.id)?.payload).toEqual({ seed: 5 });
    q2.start();
    await until(() => q2.queue.list().every((j) => j.status === "done"));
  });

  it("cancels queued and running jobs and lets the service clean up", async () => {
    const settled: string[] = [];
    const q = make("c.sqlite", {
      execute: (_j, _p, ctx) =>
        new Promise((_, reject) => ctx.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
      onSettled: async (j) => void settled.push(j.id),
    });
    const running = q.queue.enqueue(job("video_draft"), {});
    const waiting = q.queue.enqueue(job("video_draft"), {});
    q.start();
    await until(() => q.queue.get(running.id)?.status === "running");
    expect((await q.queue.cancel(waiting.id))?.status).toBe("cancelled");
    expect((await q.queue.cancel(running.id))?.status).toBe("cancelled");
    expect(settled.sort()).toEqual([running.id, waiting.id].sort());
  });

  it("a failure is recorded with its message", async () => {
    const q = make("d.sqlite", { execute: async () => Promise.reject(new Error("ComfyUI failed in KSampler node 3: boom")) });
    const j = q.queue.enqueue(job("still"), {});
    q.start();
    await until(() => q.queue.get(j.id)?.status === "failed");
    expect(q.queue.get(j.id)).toMatchObject({ error: "ComfyUI failed in KSampler node 3: boom", message: "Failed" });
  });

  // As an 8 GB card reported it while another program held 3.5 GB of it.
  const OOM = "ComfyUI failed in BreezeTTS2VoiceDesign node 2: Allocation on device 0 would exceed allowed memory. (out of memory)\nCurrently allocated     : 3.30 GiB";

  it("a GPU job that ran out of memory says so plainly, and what other apps held on the card then", async () => {
    let others: { usedGb: number; apps: string[] } | undefined = { usedGb: 3.5, apps: ["python"] };
    const q = make("oom.sqlite", { execute: async () => Promise.reject(new Error(OOM)) }, settings(), { otherGpuUse: () => others });
    const crowded = q.queue.enqueue(job("voice"), {});
    q.start();
    await until(() => q.queue.get(crowded.id)?.status === "failed");
    expect(q.queue.get(crowded.id)).toMatchObject({ error: OOM, message: "Ran out of graphics memory. Other apps are using 3.5 GB (python)." });

    others = undefined;
    const alone = q.queue.enqueue(job("video_draft"), {});
    await until(() => q.queue.get(alone.id)?.status === "failed");
    expect(q.queue.get(alone.id)?.message).toBe("Ran out of graphics memory.");
  });

  it("a CPU job that says out of memory is not said to have run out of graphics memory", async () => {
    const q = make("oom-cpu.sqlite", { execute: async () => Promise.reject(new Error("Chrome: out of memory")) }, settings(), { otherGpuUse: () => ({ usedGb: 3.5, apps: ["python"] }) });
    const j = q.queue.enqueue(job("export"), {});
    q.start();
    await until(() => q.queue.get(j.id)?.status === "failed");
    expect(q.queue.get(j.id)).toMatchObject({ error: "Chrome: out of memory", message: "Failed" });
  });

  it("when ComfyUI goes away mid-job, the job is retried instead of failed", async () => {
    let tries = 0;
    const q = make("e.sqlite", {
      execute: async () => {
        tries++;
        if (tries < 3) throw new RuntimeLostError("ComfyUI failed: Could not reach ComfyUI.");
        return { outputAssetIds: ["ast_1"] };
      },
    });
    const j = q.queue.enqueue(job("still"), {});
    q.start();
    await until(() => q.queue.get(j.id)?.status === "done");
    expect(tries).toBe(3);
    expect(q.events.some((e) => e.message?.startsWith("The GPU went away. Trying again in"))).toBe(true);
  });

  it("gives up once the runtime went away under the job too many times", async () => {
    let tries = 0;
    const q = make("f.sqlite", { execute: async () => (tries++, Promise.reject(new Error("fetch failed"))) });
    const j = q.queue.enqueue(job("still"), {});
    q.start();
    await until(() => q.queue.get(j.id)?.status === "failed", 5000);
    expect(tries).toBe(4);
    expect(q.queue.get(j.id)?.error).toBe("fetch failed (the GPU went away 4 times while this job ran, so it stopped trying)");
  });

  it("retries the proxy's upload error when ComfyUI disappears during asset upload", async () => {
    let tries = 0;
    const q = make("upload-loss.sqlite", {
      execute: async () => {
        if (++tries === 1) throw new Error("Failed to reach ComfyUI for upload.");
        return { outputAssetIds: ["ast_uploaded"] };
      },
    });
    const j = q.queue.enqueue(job("video_final_remaster"), {});
    q.start();
    await until(() => q.queue.get(j.id)?.status === "done");
    expect(tries).toBe(2);
    expect(q.queue.get(j.id)?.outputAssetIds).toEqual(["ast_uploaded"]);
  });

  it("exclusive() waits for the running job and holds new ones", async () => {
    const log: string[] = [];
    const q = make("g.sqlite", {
      execute: async (j) => {
        log.push(`start ${j.step}`);
        await sleep(30);
        log.push(`end ${j.step}`);
        return { outputAssetIds: [] };
      },
    });
    q.queue.enqueue(job("still"), {});
    q.start();
    await until(() => log.length === 1);
    q.queue.enqueue(job("music"), {});
    await q.queue.exclusive(async () => void log.push("restart"));
    await until(() => log.length === 5);
    expect(log).toEqual(["start still", "end still", "restart", "start music", "end music"]);
  });

  it("overnight finals start when the window opens", async () => {
    let now = at("22:00");
    const s = settings({ enabled: true });
    const store = new JobStore(join(dir, "h.sqlite"));
    queue = new JobQueue(store, new EventBus(), { settings: () => s, clock: () => now, tickMs: 20 });
    const ran: string[] = [];
    queue.start({ execute: async (j) => (ran.push(j.id), { outputAssetIds: [] }) });
    const night = queue.enqueue(job("video_final_remaster", "overnight"), {});
    await sleep(80);
    expect(ran).toEqual([]);
    now = at("23:05");
    await until(() => ran.length === 1);
    expect(ran).toEqual([night.id]);
  });
});

describe("two workers: the GPU and the CPU", () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-lanes-"));
  let queue: JobQueue | undefined;
  afterEach(async () => {
    await queue?.stop();
    queue = undefined;
  });

  const until = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error("timed out");
      await sleep(5);
    }
  };

  /** A queue whose jobs run until released: `release(id)` ends one, `running` lists what runs now. */
  function gated(dbName: string, hooks: Partial<QueueHooks> = {}) {
    const gates = new Map<string, () => void>();
    const running = new Set<string>();
    const order: string[] = [];
    let maxCpu = 0;
    queue = new JobQueue(new JobStore(join(dir, dbName)), new EventBus(), { settings: () => settings(), tickMs: 20, retryDelayMs: 10 });
    const q = queue;
    q.start({
      execute: (j, _p, ctx) =>
        new Promise((resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
          running.add(j.id);
          order.push(j.id);
          maxCpu = Math.max(maxCpu, [...running].filter((id) => laneOf(q.get(id)!) === "cpu").length);
          gates.set(j.id, () => {
            running.delete(j.id);
            resolve({ outputAssetIds: [] });
          });
        }),
      ...hooks,
    });
    const release = async (id: string) => {
      await until(() => gates.has(id));
      gates.get(id)!();
      gates.delete(id);
      await until(() => q.get(id)?.status === "done");
    };
    return { q, running, order, release, maxCpu: () => maxCpu };
  }

  it("exports and analysis jobs go to the CPU worker, everything else to the GPU", () => {
    expect(laneOf(job("export"))).toBe("cpu");
    expect(laneOf(job("music", "now", { analysis: true }))).toBe("cpu");
    expect(laneOf(job("music"))).toBe("gpu");
    expect(laneOf(job("video_final_remaster", "overnight"))).toBe("gpu");
  });

  it("an export runs beside a GPU job, and only one export runs at a time", async () => {
    const g = gated("lanes-a.sqlite");
    const draft = g.q.enqueue(job("video_draft", "now", { projectId: "prj_a" }), {});
    const exp1 = g.q.enqueue(job("export", "now", { projectId: "prj_b" }), {});
    const exp2 = g.q.enqueue(job("export", "now", { projectId: "prj_c" }), {});
    await until(() => g.running.has(draft.id) && g.running.has(exp1.id));
    await sleep(50);
    expect(g.running.has(exp2.id)).toBe(false);
    // The draft finishes while the export goes on; the second export starts only after the first.
    await g.release(draft.id);
    expect(g.q.get(exp1.id)?.status).toBe("running");
    await g.release(exp1.id);
    await g.release(exp2.id);
    expect(g.maxCpu()).toBe(1);
  });

  it("GPU jobs stay strictly one at a time while the CPU worker is busy", async () => {
    const g = gated("lanes-b.sqlite");
    const exp = g.q.enqueue(job("export", "now", { projectId: "prj_x" }), {});
    const a = g.q.enqueue(job("still"), {});
    const b = g.q.enqueue(job("video_draft"), {});
    await until(() => g.running.has(a.id) && g.running.has(exp.id));
    await sleep(50);
    expect(g.running.has(b.id)).toBe(false);
    await g.release(a.id);
    await until(() => g.running.has(b.id));
    expect([...g.running].sort()).toEqual([b.id, exp.id].sort());
    await g.release(b.id);
    await g.release(exp.id);
  });

  it("an export waits for the stills, drafts and audio of its project queued before it, not for finals or other projects", async () => {
    const g = gated("lanes-c.sqlite");
    const final = g.q.enqueue(job("video_final_same_take", "now", { projectId: "prj_1" }), {});
    const other = g.q.enqueue(job("video_draft", "now", { projectId: "prj_2" }), {});
    const draft = g.q.enqueue(job("video_draft", "now", { projectId: "prj_1" }), {});
    const exp = g.q.enqueue(job("export", "now", { projectId: "prj_1" }), {});
    const later = g.q.enqueue(job("still", "now", { projectId: "prj_1" }), {});
    await until(() => g.q.get(exp.id)?.message === "Waiting for the draft queued before it");
    await g.release(other.id);
    expect(g.q.get(exp.id)?.status).toBe("queued");
    await g.release(draft.id);
    // The draft is done: the export starts beside the GPU work, without waiting for the final or the later still.
    await until(() => g.running.has(exp.id));
    expect(g.q.get(exp.id)?.message).toBe("Starting");
    await g.release(exp.id);
    await g.release(later.id);
    await g.release(final.id);
    const entries = (...jobs: Job[]): StoredJob[] => jobs.map((j, i) => ({ job: j, payload: {}, seq: i + 1 }));
    const list = entries(job("still", "now", { projectId: "p" }), job("music", "now", { projectId: "p" }), job("export", "now", { projectId: "p" }));
    expect(awaitedBy(list[2]!, list).map((e) => e.job.step)).toEqual(["still", "music"]);
    expect(awaitedBy(list[1]!, list)).toEqual([]);
  });

  it("cancelling the job an export waits for lets the export go", async () => {
    const g = gated("lanes-d.sqlite");
    const still = g.q.enqueue(job("still", "now", { projectId: "prj_1" }), {});
    const music = g.q.enqueue(job("music", "now", { projectId: "prj_1" }), {});
    const exp = g.q.enqueue(job("export", "now", { projectId: "prj_1" }), {});
    await until(() => g.q.get(exp.id)?.message === "Waiting for 2 jobs of this project");
    await g.q.cancel(music.id);
    await until(() => g.q.get(exp.id)?.message === "Waiting for the still queued before it");
    await g.release(still.id);
    await g.release(exp.id);
  });

  it("an export waits for the analysis of its project's song even when that was queued after it", async () => {
    const g = gated("lanes-g.sqlite");
    const other = g.q.enqueue(job("export", "now", { projectId: "prj_busy" }), {}); // keeps the CPU worker busy
    await until(() => g.running.has(other.id));
    const exp = g.q.enqueue(job("export", "now", { projectId: "prj_1" }), {});
    const analysis = g.q.enqueue(job("music", "now", { projectId: "prj_1", analysis: true }), {});
    await until(() => g.q.get(exp.id)?.message === "Waiting for the song to be measured");
    await g.release(other.id);
    // The CPU worker takes the analysis first, then the export.
    await until(() => g.running.has(analysis.id));
    expect(g.q.get(exp.id)?.status).toBe("queued");
    await g.release(analysis.id);
    await g.release(exp.id);
  });

  it("an export does not wait out a GPU that is away", async () => {
    let gpu = false;
    const g = gated("lanes-h.sqlite", { blocked: (j) => (laneOf(j) === "gpu" && !gpu ? WAITING_FOR_GPU : undefined) });
    const draft = g.q.enqueue(job("video_draft", "now", { projectId: "prj_1" }), {});
    const exp = g.q.enqueue(job("export", "now", { projectId: "prj_1" }), {});
    // The draft cannot run, so the export goes ahead with what the project has.
    await until(() => g.running.has(exp.id));
    expect(g.q.get(draft.id)).toMatchObject({ status: "queued", message: WAITING_FOR_GPU });
    await g.release(exp.id);
    gpu = true;
    g.q.kick();
    await g.release(draft.id);
  });

  it("exclusive() holds only the GPU worker", async () => {
    const g = gated("lanes-e.sqlite");
    const still = g.q.enqueue(job("still"), {});
    await until(() => g.running.has(still.id));
    let restarted = false;
    const held = g.q.exclusive(async () => void (restarted = true));
    const exp = g.q.enqueue(job("export", "now", { projectId: "prj_other" }), {});
    await until(() => g.running.has(exp.id));
    expect(restarted).toBe(false);
    await g.release(still.id);
    await held;
    expect(restarted).toBe(true);
    await g.release(exp.id);
  });

  it("a CPU job that fails on the network is a failure, not a lost GPU to wait for", async () => {
    queue = new JobQueue(new JobStore(join(dir, "lanes-f.sqlite")), new EventBus(), { settings: () => settings(), tickMs: 20, retryDelayMs: 10 });
    let tries = 0;
    queue.start({ execute: async () => (tries++, Promise.reject(new Error("fetch failed"))) });
    const exp = queue.enqueue(job("export"), {});
    await until(() => queue!.get(exp.id)?.status === "failed");
    expect(tries).toBe(1);
  });
});

describe("waiting for the GPU", () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-gpu-"));
  let queue: JobQueue | undefined;
  afterEach(async () => {
    await queue?.stop();
    queue = undefined;
  });

  const until = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error("timed out");
      await sleep(5);
    }
  };

  /** A queue on a clock the test moves, with a GPU the test switches off and on. */
  function world(dbName: string, start: string, execute: QueueHooks["execute"], s: Settings = settings({ enabled: true })) {
    const w = { gpu: true, now: at(start), tries: 0 };
    const store = new JobStore(join(dir, dbName));
    queue = new JobQueue(store, new EventBus(), { settings: () => s, clock: () => w.now, tickMs: 10, retryDelayMs: 60_000, maxRuntimeLosses: 3 });
    const q = queue;
    q.start({
      blocked: (j) => (laneOf(j) === "gpu" && !w.gpu ? WAITING_FOR_GPU : undefined),
      execute: (j, p, ctx) => (w.tries++, execute(j, p, ctx)),
    });
    /** Move the clock on in steps, letting the queue look at each moment. */
    const pass = async (hours: number) => {
      for (let i = 0; i < 12; i++) {
        w.now = new Date(w.now.getTime() + (hours * 3_600_000) / 12);
        q.kick();
        await sleep(15);
      }
    };
    return { w, q, store, pass };
  }

  it("a job waits for the GPU as long as it takes, trying nothing meanwhile", async () => {
    const { w, q, pass } = world("gpu-a.sqlite", "12:00", async () => ({ outputAssetIds: [] }));
    w.gpu = false;
    const still = q.enqueue(job("still"), {});
    await until(() => q.get(still.id)?.message === WAITING_FOR_GPU);
    await pass(5);
    expect(q.get(still.id)).toMatchObject({ status: "queued", message: WAITING_FOR_GPU });
    expect(w.tries).toBe(0);
    w.gpu = true;
    q.kick();
    await until(() => q.get(still.id)?.status === "done");
    expect(w.tries).toBe(1);
  });

  it("an overnight final that loses the GPU mid-run waits out a long outage in the window, then runs again", async () => {
    const lost = { once: false };
    const { w, q, store, pass } = world("gpu-b.sqlite", "23:10", async () => {
      if (!lost.once) {
        lost.once = true;
        w.gpu = false; // a preemption: ComfyUI is gone, and stays gone for hours
        throw new RuntimeLostError("Could not reach ComfyUI.");
      }
      return { outputAssetIds: ["ast_final"] };
    });
    const final = q.enqueue(job("video_final_remaster", "overnight"), {});
    await until(() => q.get(final.id)?.message === WAITING_FOR_GPU);
    // Five hours pass with the GPU away, well past any retry window: nothing is tried, nothing fails.
    await pass(5);
    expect(q.get(final.id)).toMatchObject({ status: "queued", message: WAITING_FOR_GPU });
    expect(w.tries).toBe(1);
    expect(store.all().find((e) => e.job.id === final.id)?.payload._losses).toBe(1);
    // 04:10: the GPU is back inside the window. The job goes at once, without sitting out its retry pause.
    w.gpu = true;
    q.retryNow();
    await until(() => q.get(final.id)?.status === "done");
    expect(w.tries).toBe(2);
  });

  it("only losses while running count: a job that keeps killing ComfyUI fails in the end", async () => {
    const { w, q } = world("gpu-c.sqlite", "12:00", async () => {
      throw new RuntimeLostError("ComfyUI restarted and lost the job");
    });
    const still = q.enqueue(job("still"), {});
    for (let i = 1; i < 3; i++) {
      await until(() => w.tries === i && q.get(still.id)?.status === "queued");
      q.retryNow();
    }
    await until(() => q.get(still.id)?.status === "failed");
    expect(w.tries).toBe(3);
    expect(q.get(still.id)?.error).toMatch(/the GPU went away 3 times while this job ran/);
  });

  it("an overnight job outside its window says when it runs", async () => {
    const { q } = world("gpu-d.sqlite", "22:00", async () => ({ outputAssetIds: [] }));
    const night = q.enqueue(job("video_final_same_take", "overnight"), {});
    await until(() => q.get(night.id)?.message === "Runs tonight, 23:00 to 07:00");
    await queue!.stop();
    const off = world("gpu-e.sqlite", "02:00", async () => ({ outputAssetIds: [] }), settings({ enabled: false }));
    const later = off.q.enqueue(job("video_final_same_take", "overnight"), {});
    await until(() => off.q.get(later.id)?.message === "Runs when overnight mode is on");
  });

  it("the wait message goes away once the wait is over", async () => {
    let finish!: () => void;
    const { w, q } = world("gpu-f.sqlite", "12:00", () => new Promise((r) => (finish = () => r({ outputAssetIds: [] }))));
    w.gpu = false;
    const a = q.enqueue(job("still"), {});
    const b = q.enqueue(job("still"), {});
    await until(() => q.get(b.id)?.message === WAITING_FOR_GPU);
    w.gpu = true;
    q.kick();
    await until(() => q.get(a.id)?.status === "running");
    // b is behind a now, not waiting for the GPU: no stale message.
    await until(() => q.get(b.id)?.message === undefined);
    finish();
    await until(() => q.get(b.id)?.status === "running");
    finish();
    await until(() => q.get(b.id)?.status === "done");
  });
});

describe("finals for the night, grouped by model", () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-night-"));
  let queue: JobQueue | undefined;
  afterEach(async () => {
    await queue?.stop();
    queue = undefined;
  });

  const until = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error("timed out");
      await sleep(5);
    }
  };

  /** A final for the night that loads LTX-2.5 (same take) or MiniMax H3 (remaster). */
  const ltx = (extra: Partial<Job> = {}) => job("video_final_same_take", "overnight", { model: "LTX-2.5", ...extra });
  const h3 = (extra: Partial<Job> = {}) => job("video_final_remaster", "overnight", { model: "MiniMax H3", ...extra });

  /** A queue on a clock the test moves, whose jobs run until released. `order` lists the jobs in the order they started. */
  function night(dbName: string, start: string) {
    const w = { now: at(start) };
    const store = new JobStore(join(dir, dbName));
    const gates = new Map<string, () => void>();
    const order: string[] = [];
    queue = new JobQueue(store, new EventBus(), { settings: () => settings({ enabled: true }), clock: () => w.now, tickMs: 10, retryDelayMs: 10 });
    const q = queue;
    const begin = () =>
      q.start({
        execute: (j, _p, ctx) =>
          new Promise((resolve, reject) => {
            ctx.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
            order.push(j.id);
            gates.set(j.id, () => resolve({ outputAssetIds: [] }));
          }),
      });
    /** Let a running job finish and wait until it is done. */
    const release = async (id: string) => {
      await until(() => gates.has(id));
      gates.get(id)!();
      gates.delete(id);
      await until(() => q.get(id)?.status === "done");
    };
    /** Release the jobs one by one as they start, until `count` have run. */
    const drain = async (count: number) => {
      for (let i = 0; i < count; i++) {
        await until(() => order.length > i);
        if (q.get(order[i]!)?.status !== "done") await release(order[i]!);
      }
    };
    const waitingOrder = () => q.list().filter((j) => j.status === "queued").map((j) => j.id);
    return { w, q, store, order, release, drain, start: begin, waitingOrder };
  }

  it("mixed models: each model's finals run back to back, groups in the order their first final was queued", async () => {
    const n = night("night-mixed.sqlite", "21:00");
    n.start();
    const [l1, h1, l2, h2, l3] = [ltx(), h3(), ltx(), h3(), ltx()].map((j) => n.q.enqueue(j, {})) as [Job, Job, Job, Job, Job];
    // The LTX-2.5 group was started first (l1), so it runs first; inside a group, the order queued.
    expect([l2.nightGroup, l3.nightGroup]).toEqual([l1.nightGroup, l1.nightGroup]);
    expect(h2.nightGroup).toBe(h1.nightGroup);
    expect(h1.nightGroup).toBeGreaterThan(l1.nightGroup!);
    expect(n.waitingOrder()).toEqual([l1, l2, l3, h1, h2].map((j) => j.id));
    await until(() => n.q.get(l1.id)?.message === "Runs tonight, 23:00 to 07:00");
    await sleep(40);
    expect(n.order).toEqual([]);
    // The window opens: one model, then the other.
    n.w.now = at("23:01");
    n.q.kick();
    await n.drain(5);
    expect(n.order).toEqual([l1, l2, l3, h1, h2].map((j) => j.id));
  });

  it("same model: one group, in the order queued", async () => {
    const n = night("night-same.sqlite", "23:30");
    const jobs = [ltx(), ltx(), ltx()].map((j) => n.q.enqueue(j, {}));
    expect(new Set(jobs.map((j) => j.nightGroup)).size).toBe(1);
    n.start();
    await n.drain(3);
    expect(n.order).toEqual(jobs.map((j) => j.id));
  });

  it("interactive work and finals to run now still go first; exports run beside on the CPU", async () => {
    const n = night("night-classes.sqlite", "23:30");
    const l1 = n.q.enqueue(ltx(), {});
    const h1 = n.q.enqueue(h3(), {});
    const l2 = n.q.enqueue(ltx(), {});
    const now = n.q.enqueue(job("video_final_remaster", "now", { model: "MiniMax H3" }), {});
    const draft = n.q.enqueue(job("video_draft"), {});
    const exp = n.q.enqueue(job("export", "now", { projectId: "prj_other" }), {});
    expect(now.nightGroup).toBeUndefined();
    expect(draft.nightGroup).toBeUndefined();
    n.start();
    await until(() => n.order.length === 2);
    expect(n.order.sort()).toEqual([draft.id, exp.id].sort());
    await n.release(exp.id);
    await n.release(draft.id);
    for (const id of [now.id, l1.id, l2.id, h1.id]) {
      await until(() => n.order.length > 0 && n.order.at(-1) === id);
      await n.release(id);
    }
    expect(n.order.slice(2)).toEqual([now.id, l1.id, l2.id, h1.id]);
  });

  it("interleaved queueing: a final joins its model's group until that group starts, then waits for the next turn", async () => {
    const n = night("night-interleaved.sqlite", "23:30");
    n.start();
    const l1 = n.q.enqueue(ltx(), {});
    await until(() => n.order.includes(l1.id));
    // l1 runs, so its group is closed. A later LTX final starts a new group, behind the MiniMax one queued before it.
    const h1 = n.q.enqueue(h3(), {});
    const l2 = n.q.enqueue(ltx(), {});
    const h2 = n.q.enqueue(h3(), {});
    expect(l2.nightGroup).not.toBe(l1.nightGroup);
    expect(h2.nightGroup).toBe(h1.nightGroup);
    expect(n.waitingOrder()).toEqual([h1.id, h2.id, l2.id]);
    await n.release(l1.id);
    await until(() => n.order.includes(h1.id));
    // While MiniMax runs, another LTX final joins the waiting LTX group, which has not started.
    const l3 = n.q.enqueue(ltx(), {});
    expect(l3.nightGroup).toBe(l2.nightGroup);
    await n.drain(5);
    expect(n.order).toEqual([l1, h1, h2, l2, l3].map((j) => j.id));
  });

  it("never starves: a model that keeps getting finals does not hold the other model back", async () => {
    const n = night("night-starve.sqlite", "23:30");
    n.start();
    const first = n.q.enqueue(ltx(), {});
    await until(() => n.order.includes(first.id));
    const remaster = n.q.enqueue(h3(), {});
    // A new LTX final arrives while each one runs.
    let running = first;
    for (let i = 0; i < 4 && running.id !== remaster.id; i++) {
      const next = n.q.enqueue(ltx(), {});
      await n.release(running.id);
      await until(() => n.order.length === i + 2);
      running = n.q.get(n.order.at(-1)!)!;
      expect([next.id, remaster.id]).toContain(running.id);
    }
    // The remaster went second: right after the LTX group that was running when it was queued.
    expect(n.order.slice(0, 2)).toEqual([first.id, remaster.id]);
  });

  it("a group that has started finishes first, even when a final of an earlier group comes back from a pause", () => {
    const [a1, b1, b2] = entries(ltx({ nightGroup: 1 }), h3({ nightGroup: 2 }), h3({ nightGroup: 2 })) as [StoredJob, StoredJob, StoredJob];
    const t = at("23:30");
    const s = settings({ enabled: true });
    // a1 lost the GPU and pauses before its next try, so the MiniMax group goes ahead.
    const paused = [{ ...a1, payload: { _notBefore: t.getTime() + 60_000 } }, b1, b2];
    expect(pickNext(paused, s, t, () => true)?.job.id).toBe(b1.job.id);
    // Its pause is over while b1 runs: the MiniMax group, on the GPU now, still goes first.
    const back = [a1, b2];
    expect(pickNext(back, s, t, () => true, 2)?.job.id).toBe(b2.job.id);
    expect(pickNext(back, s, t, () => true)?.job.id).toBe(a1.job.id);
    expect([...back].sort(runOrder(2)).map((e) => e.job.id)).toEqual([b2.job.id, a1.job.id]);
  });

  it("survives a restart: the groups are kept, and so is the group whose turn it was", async () => {
    const n1 = night("night-restart.sqlite", "21:00");
    const l1 = n1.q.enqueue(ltx(), {});
    const h1 = n1.q.enqueue(h3(), {});
    const l2 = n1.q.enqueue(ltx(), {});
    n1.w.now = at("23:30");
    n1.start();
    await until(() => n1.order.includes(l1.id));
    // A crash while l1 runs: no stop(), just drop the queue and reopen the database.
    queue = undefined;
    n1.store.close();

    const n2 = night("night-restart.sqlite", "23:31");
    expect(n2.q.list().map((j) => [j.id, j.status, j.nightGroup])).toEqual([
      [l1.id, "queued", l1.nightGroup],
      [l2.id, "queued", l1.nightGroup],
      [h1.id, "queued", h1.nightGroup],
    ]);
    // l1 had started, so its group stays closed: an LTX final queued now waits for the next turn.
    const l3 = n2.q.enqueue(ltx(), {});
    expect(l3.nightGroup).not.toBe(l1.nightGroup);
    n2.start();
    await n2.drain(4);
    expect(n2.order).toEqual([l1, l2, h1, l3].map((j) => j.id));
  });

  it("finals for the night queued before the queue grouped them are grouped when it starts", () => {
    const store = new JobStore(join(dir, "night-legacy.sqlite"));
    // As an older engine saved them: no model, no group. The step stands in for the model.
    const old = [job("video_final_same_take", "overnight"), job("video_final_remaster", "overnight"), job("still"), job("video_final_same_take", "overnight")];
    for (const j of old) store.put({ job: j, payload: {}, seq: store.nextSeq() });
    queue = new JobQueue(store, new EventBus(), { settings: () => settings({ enabled: true }), clock: () => at("23:30") });
    const [same1, remaster, still, same2] = old.map((j) => j.id);
    expect(queue.list().map((j) => j.id)).toEqual([still, same1, same2, remaster]);
    expect(store.all().map((e) => e.job.nightGroup)).toEqual([1, 2, undefined, 1]);
  });

  it("groups by the model when it is known, else by the step", () => {
    expect(modelKey(ltx())).toBe("LTX-2.5");
    expect(modelKey(job("video_final_remaster", "overnight"))).toBe("video_final_remaster");
    const list = entries(ltx(), h3(), job("video_final_same_take", "overnight", { model: "MiniMax H3" }));
    const groups: number[] = [];
    for (const e of list) {
      e.job.nightGroup = nightGroupFor(e.job, e.seq, list.slice(0, e.seq - 1));
      groups.push(e.job.nightGroup);
    }
    // A same-take final whose workflow loads MiniMax H3 joins the remasters' group.
    expect(groups).toEqual([1, 2, 2]);
  });
});

