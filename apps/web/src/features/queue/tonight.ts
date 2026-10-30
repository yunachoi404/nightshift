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
 * engine's) is a group of its own, after the others.
 */
export function tonightGroups(jobs: Job[], turn?: number): TonightGroup[] {
  const rank = (j: Job) => (j.nightGroup === undefined ? Number.MAX_SAFE_INTEGER : j.nightGroup === turn ? -1 : j.nightGroup);
  const queued = jobs.filter((j) => j.status === "queued" && j.mode === "overnight").sort((a, b) => rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt));
  const groups: TonightGroup[] = [];
  for (const j of queued) {
    const last = groups.at(-1);
    if (last && j.nightGroup !== undefined && last.jobs[0]!.nightGroup === j.nightGroup) last.jobs.push(j);
    else groups.push({ ...(j.model ? { model: j.model } : {}), step: j.step, jobs: [j] });
  }
  return groups;
}

/** A group's name: its model, else what its finals are ("Same take") when the engine does not say. */
export function groupName(g: Pick<TonightGroup, "model" | "step">): string {
  return g.model ?? (g.step === "video_final_remaster" ? "Remaster" : "Same take");
}
