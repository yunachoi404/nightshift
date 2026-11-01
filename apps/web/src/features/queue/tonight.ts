import { windowOpenedAt } from "@/lib/overnight";
import type { Job } from "@nightshift/contract";

/** Finals for the night that share a model and run back to back (Job.nightGroup). */
export interface TonightGroup {
  /** The model the group's finals load, in plain words ("LTX-2.5"), when the engine knows it. */
  model?: string;
  step: Job["step"];
  jobs: Job[];
}

/**
 * The night group on the GPU: that of the final for the night that started last. The engine finishes it before it starts
 * another, so it goes first.
 */
export function nightTurn(jobs: Job[]): number | undefined {
  let last: Job | undefined;
  for (const j of jobs) if (j.mode === "overnight" && j.startedAt && (!last || j.startedAt > last.startedAt!)) last = j;
  return last?.nightGroup;
}

/**
 * Queued finals for the night in the order the engine runs them, in their model groups: the group on the GPU (`turn`)
 * first, then the lowest group first, and inside a group the order they were queued. A final without a group (an older
 * engine's) is a group of its own, after the others. Groups that run back to back on the same model read as one: the
 * model loads once for all of them. (The engine starts a new group for finals queued after a group started, so a
 * second batch of LTX finals queued in the night is its own group, right behind the first.)
 */
export function tonightGroups(jobs: Job[], turn?: number): TonightGroup[] {
  const rank = (j: Job) => (j.nightGroup === undefined ? Number.MAX_SAFE_INTEGER : j.nightGroup === turn ? -1 : j.nightGroup);
  const queued = jobs.filter((j) => j.status === "queued" && j.mode === "overnight").sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt));
  const groups: TonightGroup[] = [];
  for (const j of queued) {
    const last = groups.at(-1);
    if (last && ((j.nightGroup !== undefined && last.jobs.at(-1)!.nightGroup === j.nightGroup) || sameModel(last.jobs.at(-1)!, j))) last.jobs.push(j);
    else groups.push({ ...(j.model ? { model: j.model } : {}), step: j.step, jobs: [j] });
  }
  return groups;
}

/** Two finals that load the same model, as the engine groups them: by the model when it says, else by the step. */
function sameModel(a: Job, b: Job): boolean {
  return (a.model ?? a.step) === (b.model ?? b.step);
}

/** A group's name: its model, else what its finals are ("Same take") when the engine does not say. */
export function groupName(g: Pick<TonightGroup, "model" | "step">): string {
  return g.model ?? (g.step === "video_final_remaster" ? "Remaster" : "Same take");
}

/** Tonight's finals as the sidebar counts them: those finished since the window opened, the one rendering, the rest. */
export interface TonightTally {
  done: number;
  running?: Job;
  queued: number;
}

/**
 * Tonight's finals: queued ones wait for the window; once it is open, those it finished count as done. Before the window
 * opens nothing is done yet, so last night's finals never fill tonight's bar.
 */
export function tonightTally(jobs: Job[], night: { startAt: string; endAt: string } | undefined, now: number): TonightTally {
  const opened = night ? windowOpenedAt(night.startAt, night.endAt, now) : null;
  const since = opened?.getTime();
  const overnight = jobs.filter((j) => j.mode === "overnight");
  const running = overnight.find((j) => j.status === "running");
  return {
    done: since === undefined ? 0 : overnight.filter((j) => j.status === "done" && !!j.finishedAt && new Date(j.finishedAt).getTime() >= since).length,
    ...(running ? { running } : {}),
    queued: overnight.filter((j) => j.status === "queued").length,
  };
}
