/**
 * The queue as the engine runs it, for the Queue page: the job on the GPU and how long it has left, the work beside it
 * on the CPU, the GPU's line for now in the order it runs, with when each job should start, and tonight's finals in
 * their model groups, placed in the night window. Times come from the setup's estimates, so they are rough; a final
 * that would start after the window closes waits for the next night, as the engine holds it.
 */
import type { Job, Project, Settings, TierSummary } from "@nightshift/contract";
import { isGpuJob } from "@/features/project/helpers";
import { insideWindow, nextWindowStart, windowOpenedAt } from "@/lib/overnight";
import { finalSeconds } from "./NightArc";
import { groupName, nightTurn, tonightGroups } from "./tonight";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** Seconds for a job the setup has no estimate for. */
const FALLBACK_SECONDS = 60;

/** How long a job should take, in seconds, from the setup's numbers. */
export function estimateSeconds(job: Pick<Job, "step" | "analysis">, tier: TierSummary | null | undefined): number {
  if (job.analysis) return 10;
  if (job.step === "export") return 40;
  if (job.step === "video_final_same_take" || job.step === "video_final_remaster") return finalSeconds(job, tier);
  return tier?.estimates?.[job.step]?.seconds || FALLBACK_SECONDS;
}

/**
 * Seconds left on a running job: the estimate less the time it has run, then more and more its own pace as it gets
 * under way (from 15% done, wholly from half way), since early progress (a model loading) says little. Null when the
 * estimate has run out before the job got going, so nothing is promised.
 */
export function secondsLeft(job: Pick<Job, "step" | "analysis" | "progress" | "startedAt">, tier: TierSummary | null | undefined, now: number): number | null {
  const estimate = estimateSeconds(job, tier);
  const p = job.progress;
  if (!job.startedAt) return estimate * (1 - p);
  const elapsed = Math.max(0, (now - new Date(job.startedAt).getTime()) / 1000);
  const byEstimate = estimate - elapsed > 0 ? estimate - elapsed : null;
  if (p < 0.15) return byEstimate;
  const byPace = (elapsed * (1 - p)) / p;
  const w = Math.min(1, (p - 0.15) / 0.35);
  return byEstimate === null ? byPace : w * byPace + (1 - w) * byEstimate;
}

/** 0 quick work, 1 finals to run now, 2 finals for tonight: the engine's classes, lowest first. */
function priority(j: Job): number {
  if (j.step !== "video_final_same_take" && j.step !== "video_final_remaster") return 0;
  return j.mode === "overnight" ? 2 : 1;
}

/** A job in a line, with when it should start (ms since epoch), or null when that cannot be said. */
export interface Slot {
  job: Job;
  at: number | null;
  /** A final for tonight that does not fit in tonight's window: it waits for the next night. */
  later?: boolean;
}

export interface NightGroupPlan {
  /** The model its finals load, in plain words, or what they are when the engine does not say. */
  name: string;
  slots: Slot[];
}

export interface QueuePlan {
  /** The job on the GPU. */
  gpu?: Job;
  /** Seconds it has left, when that can be said. */
  gpuLeft: number | null;
  /** Exports and the timing of songs and voices, which run on the CPU beside the GPU: the running one first. */
  cpu: Job[];
  /** The GPU's line for now: quick work, then finals to run now, in the order they run. */
  next: Slot[];
  /** Seconds of work in that line. */
  nextSeconds: number;
  /** Tonight's finals in their model groups, in the order they run. */
  tonight: NightGroupPlan[];
  /** Seconds of work tonight: the finals waiting and what is left of the one rendering. */
  tonightSeconds: number;
  /** The window is open now (or a final for tonight is rendering). */
  nightOpen: boolean;
  /** Done, failed or cancelled, newest first. */
  finished: Job[];
}

export interface PlanContext {
  now: number;
  tier: TierSummary | null | undefined;
  night: Settings["overnight"] | undefined;
  /** The GPU is away: work for it waits, so no start time can be said. */
  away: boolean;
}

/** Done, failed and cancelled jobs, newest first. */
function finishedOf(jobs: Job[]): Job[] {
  const at = (j: Job) => j.finishedAt ?? j.createdAt;
  return jobs.filter((j) => j.status === "done" || j.status === "failed" || j.status === "cancelled").sort((a, b) => at(b).localeCompare(at(a)));
}

export function planQueue(jobs: Job[], { now, tier, night, away }: PlanContext): QueuePlan {
  const running = jobs.filter((j) => j.status === "running");
  const gpu = running.find(isGpuJob);
  const cpu = [...running.filter((j) => !isGpuJob(j)), ...jobs.filter((j) => j.status === "queued" && !isGpuJob(j))];
  const turn = nightTurn(jobs);

  const gpuLeft = gpu ? secondsLeft(gpu, tier, now) : null;
  // The line for now starts once the job on the GPU is done.
  let t: number | null = away ? null : now + (gpu ? (gpuLeft ?? estimateSeconds(gpu, tier) * (1 - gpu.progress)) * 1000 : 0);
  const line = jobs.filter((j) => j.status === "queued" && isGpuJob(j) && priority(j) < 2).sort((a, b) => priority(a) - priority(b) || a.createdAt.localeCompare(b.createdAt));
  const next: Slot[] = line.map((job) => {
    const slot = { job, at: t };
    if (t !== null) t += estimateSeconds(job, tier) * 1000;
    return slot;
  });
  const nextSeconds = line.reduce((s, j) => s + estimateSeconds(j, tier), 0);

  const nightOpen = gpu?.mode === "overnight" || (!!night?.enabled && insideWindow(night, now));
  const groups = tonightGroups(jobs, turn);
  const tonight = placeTonight(groups, t, { now, tier, night, away }, nightOpen);

  return { ...(gpu ? { gpu } : {}), gpuLeft, cpu, next, nextSeconds, tonight, tonightSeconds: tonightSeconds(jobs, tier, now), nightOpen, finished: finishedOf(jobs) };
}

/**
 * Seconds of work left tonight: the finals for the night waiting, and what is left of the one rendering. The sidebar's
 * Tonight card and the Queue's Tonight say the same.
 */
export function tonightSeconds(jobs: Job[], tier: TierSummary | null | undefined, now: number): number {
  let s = 0;
  for (const j of jobs) {
    if (j.mode !== "overnight") continue;
    if (j.status === "queued") s += estimateSeconds(j, tier);
    else if (j.status === "running") s += secondsLeft(j, tier, now) ?? estimateSeconds(j, tier) * (1 - j.progress);
  }
  return s;
}

/** The window's length in minutes. A window from a time to the same time is all day. */
function windowMinutes(night: Settings["overnight"]): number {
  const m = (hhmm: string) => {
    const [h, mm] = hhmm.split(":").map(Number);
    return (h ?? 0) * 60 + (mm ?? 0);
  };
  return (m(night.endAt) - m(night.startAt) + 1440) % 1440 || 1440;
}

/**
 * Tonight's finals placed in the window: from when the line for now is done (`from`) while the window is open, else
 * from when it opens. A final that would start once the window has closed waits for the next night.
 */
function placeTonight(groups: ReturnType<typeof tonightGroups>, from: number | null, { now, tier, night, away }: PlanContext, open: boolean): NightGroupPlan[] {
  const known = !away && from !== null && !!night?.enabled;
  let t = 0;
  let end = 0;
  if (known && night) {
    const length = windowMinutes(night) * MIN;
    const opened = open ? (windowOpenedAt(night, now)?.getTime() ?? now) : nextWindowStart(night, now).getTime();
    t = open ? Math.max(from!, now) : Math.max(from!, opened);
    end = opened + length;
    if (t >= end) {
      t = opened + DAY;
      end += DAY;
    }
  }
  let later = false;
  return groups.map((g) => ({
    name: groupName(g),
    slots: g.jobs.map((job) => {
      if (!known || !night) return { job, at: null };
      if (t >= end) {
        // It would start after the window closes: the engine holds it for the next night.
        later = true;
        t = end - windowMinutes(night) * MIN + DAY;
        end += DAY;
      }
      const slot: Slot = { job, at: t, ...(later ? { later: true } : {}) };
      t += estimateSeconds(job, tier) * 1000;
      return slot;
    }),
  }));
}

/** Where a job's result is: its card on the media page, the editor for a film's export, else the project. */
export function resultPath(job: Pick<Job, "projectId" | "shotId" | "step" | "analysis">, project?: Pick<Project, "shots">): string {
  const base = `/p/${job.projectId}`;
  if (job.step === "export" && !job.shotId) return `${base}/editor`;
  if (job.shotId && project?.shots.some((s) => s.id === job.shotId)) return `${base}/media?card=${job.shotId}`;
  if (job.step === "music" || job.step === "voice") return `${base}/media`;
  return base;
}
