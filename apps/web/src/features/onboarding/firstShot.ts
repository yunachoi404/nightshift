import { sentenceCase, type StepId, type TierSummary } from "@nightshift/contract";
import { roughDuration } from "@/lib/format";
import { shotListSeconds } from "@/store/tier";

/** The First shot sample's steps, in order: its one-shot list, its still, then a motion draft. */
export type SampleStep = "text" | "still" | "draft";
export const SAMPLE_STEPS: SampleStep[] = ["text", "still", "draft"];

/** What each step is expected to take on this setup, from its recipe. Null when the recipe has no time for one. */
export function sampleEstimates(tier: TierSummary | null | undefined, draftStep: StepId): Record<SampleStep, number> | null {
  const text = shotListSeconds(tier, 1);
  const still = tier?.estimates?.still?.seconds;
  const draft = tier?.estimates?.[draftStep]?.seconds;
  if (!text || !valid(still) || !valid(draft)) return null;
  return { text, still, draft };
}

/**
 * How long the sample takes, in a few plain words. Before any step is done, the whole of it: "About 7 minutes on
 * this machine". After that, what is left: the steps still to come, less the time the current one has had so far.
 * Null when the recipe has no times, or the draft is done.
 */
export function sampleTimeLine(o: { estimates: Record<SampleStep, number> | null; done: SampleStep[]; elapsedSec: number; where: string }): string | null {
  const { estimates, done } = o;
  if (!estimates) return null;
  const left = SAMPLE_STEPS.filter((s) => !done.includes(s));
  if (!left.length) return null;
  if (left.length === SAMPLE_STEPS.length) return `${sentenceCase(roughDuration(total(estimates)))} on ${o.where}`;
  const [current, ...later] = left;
  const seconds = Math.max(0, estimates[current!] - o.elapsedSec) + later.reduce((sum, s) => sum + estimates[s], 0);
  return seconds < 10 ? "Almost done" : `${sentenceCase(roughDuration(seconds))} left`;
}

function total(estimates: Record<SampleStep, number>): number {
  return SAMPLE_STEPS.reduce((sum, s) => sum + estimates[s], 0);
}

function valid(seconds: number | undefined): seconds is number {
  return seconds !== undefined && Number.isFinite(seconds) && seconds > 0;
}
