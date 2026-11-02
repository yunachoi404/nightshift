/**
 * Finishing every pick at once: which shots of the cut have a picked take with no final yet, what kind of final this
 * setup makes, and how long they take. The board's header and the editor's Export panel queue them for tonight with
 * one press, as the card's own Finish tonight does one by one.
 */
import { type FinalKind, type Job, type Project, type Shot, type TierSummary } from "@nightshift/contract";
import { activeJob, timelineShots } from "@/features/project/helpers";
import { FINAL_STEPS, shotHistory } from "@/features/media/items";

/** The final this setup makes: the same take where it can, else a remaster. Null when it makes none. */
export function finalKindFor(tier: Pick<TierSummary, "steps"> | null | undefined): FinalKind | null {
  if (!tier?.steps || tier.steps.includes("video_final_same_take")) return "same_take";
  return tier.steps.includes("video_final_remaster") ? "remaster" : null;
}

/**
 * Whether a shot's pick can be finished: the pick is a draft (not a still restored over it, not a final), and no final
 * of the shot is queued or rendering. The card's Finish now and Finish tonight follow the same rule.
 */
export function canFinish(project: Project, shot: Shot, jobs: Job[]): boolean {
  const pick = shotHistory(project, shot).find((v) => v.pick);
  return pick?.rung === "draft" && pick.take?.id === shot.chosenDraftId && !activeJob(jobs, shot.id, FINAL_STEPS);
}

/**
 * The cut's shots whose picked take has no final yet, in timeline order. Cards kept on a board only are left out: the
 * film is what tonight's finals are for, and each final is minutes of GPU time.
 */
export function unfinishedPicks(project: Project, jobs: Job[]): Shot[] {
  return timelineShots(project).filter((s) => canFinish(project, s, jobs));
}

/**
 * Seconds one final of `shot` takes here: the setup's estimate, as the Queue counts it. A What if? film is 15 s of video,
 * but it finishes at twice the draft's size, not four times (the recipe's long-take final), so it takes about as long as
 * a shot's final: 304 s on the Spark on Nov 2, against 288 s estimated.
 */
export function finalSecondsFor(_project: Project, _shot: Shot, tier: TierSummary | null | undefined, kind: FinalKind): number {
  const step = kind === "remaster" ? "video_final_remaster" : "video_final_same_take";
  return tier?.estimates?.[step]?.seconds ?? 0;
}
