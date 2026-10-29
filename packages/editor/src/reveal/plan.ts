/**
 * The reveal clip's timing, in frames so every cut lands on the frame grid and the frozen draft frame and the
 * revealed final frame are the same frame index.
 *
 * Beats, in order: the source photo; the draft playing up to frame F; the draft frozen on frame F; the reveal of
 * the final's frame F beside or over it, held as a labelled pair; that frame held alone; a close crop of both frames
 * side by side (same-take finals only); the final playing on from frame F with its sound; an end card where the
 * final plays from its start, clean.
 *
 * A short take plays whole. A long one (a 15 second What-if film) plays a window around the freeze: the last
 * moments of the draft before frame F and the first moments of the final after it, so the clip stays 8 to 12
 * seconds for any take and the two frames compared are still the same index.
 */
import type { FinalKind } from "@nightshift/contract";

export interface RevealPlanInput {
  fps: number;
  /** Frames in the draft. */
  draftFrames: number;
  /** Frames in the final. Equal to the draft's for a same-take final; a remaster can differ. */
  finalFrames: number;
  hasSource: boolean;
  kind: FinalKind;
}

/** A span of the clip, in seconds, [start, end). */
export interface Span {
  start: number;
  end: number;
}

export interface RevealPlan {
  fps: number;
  /** The frame the draft freezes on and the final is revealed at. */
  freezeFrame: number;
  draftFrames: number;
  finalFrames: number;
  /** The source photo, when there is one. */
  source: Span | null;
  /** The first draft frame played: 0 for a short take, later for a long one. The draft plays draftFrom to freezeFrame - 1. */
  draftFrom: number;
  /** One past the last final frame played on the resume: finalFrames for a short take, earlier for a long one. */
  resumeTo: number;
  /** The draft playing frames draftFrom to freezeFrame - 1. */
  draft: Span;
  /** The draft's frame F, still. */
  freeze: Span;
  /** The final's frame F wiping over the draft's. */
  wipe: Span;
  /** The final's frame F alone, still. */
  hold: Span;
  /** Both frames up close, side by side. Not for remasters, whose frames need not match. */
  detail: Span | null;
  /** The final playing from frame F to resumeTo - 1. */
  resume: Span;
  /** The final from its first frame, clean, with the maker's mark. */
  endCard: Span;
  /** Seconds the picture fades out at the end, inside the end card. */
  fadeOut: number;
  duration: number;
}

/** Beat lengths in seconds. Each is rounded to whole frames at the clip's rate. */
export const BEATS = {
  source: 0.9,
  freeze: 0.45,
  /** The reveal: the final's frame slides in under the draft's, or wipes over it and holds as a labelled split. */
  wipe: 1.2,
  hold: 0.4,
  detail: 1.3,
  endCard: 2.6,
  fadeOut: 0.35,
  /** Where in the draft the freeze lands, as a share of its frames. */
  freezeAt: 0.42,
  /** The most of the draft that plays before the freeze, and of the final after it, in seconds. Longer takes play a window. */
  draftMax: 1.7,
  resumeMax: 2.4,
} as const;

/** The clip never runs shorter than this: stills hold longer for short takes. */
export const MIN_SECONDS = 8;
/** Nor longer: long takes play a window around the freeze. */
export const MAX_SECONDS = 12;

export function planReveal(input: RevealPlanInput): RevealPlan {
  const { fps, draftFrames, finalFrames, kind } = input;
  if (!(fps > 0) || !Number.isInteger(draftFrames) || draftFrames < 2 || !Number.isInteger(finalFrames) || finalFrames < 2) {
    throw new Error(`A reveal needs a frame rate and at least two frames in the draft and the final (got ${fps} fps, ${draftFrames} and ${finalFrames} frames).`);
  }
  const frames = (sec: number) => Math.max(1, Math.round(sec * fps));
  // Enough draft before the freeze to read as motion, and enough final after it to read as the same motion going on.
  const shared = Math.min(draftFrames, finalFrames);
  const freezeFrame = Math.min(Math.max(Math.round(draftFrames * BEATS.freezeAt), Math.min(8, shared - 2)), shared - 2);

  // Beat lengths in frames. A short take (two seconds) would make a clip under eight seconds, too quick to read:
  // the stills then hold longer, split between the freeze, the hold and the close crop.
  const draftFrom = Math.max(0, freezeFrame - frames(BEATS.draftMax));
  const resumeTo = Math.min(finalFrames, freezeFrame + frames(BEATS.resumeMax));
  const lengths = {
    source: input.hasSource ? frames(BEATS.source) : 0,
    draft: freezeFrame - draftFrom,
    freeze: frames(BEATS.freeze),
    wipe: frames(BEATS.wipe),
    hold: frames(BEATS.hold),
    detail: kind === "same_take" ? frames(BEATS.detail) : 0,
    resume: resumeTo - freezeFrame,
    endCard: Math.min(finalFrames, frames(BEATS.endCard)),
  };
  const total = Object.values(lengths).reduce((a, b) => a + b, 0);
  const short = Math.max(0, frames(MIN_SECONDS) - total);
  if (short > 0) {
    const stills = lengths.detail > 0 ? (["freeze", "hold", "detail", "detail"] as const) : (["freeze", "hold", "hold", "freeze"] as const);
    for (let i = 0; i < short; i++) lengths[stills[i % stills.length]!] += 1;
  }

  let cursor = 0;
  const span = (length: number): Span => {
    const s = { start: cursor / fps, end: (cursor + length) / fps };
    cursor += length;
    return s;
  };
  const source = input.hasSource ? span(lengths.source) : null;
  const draft = span(lengths.draft);
  const freeze = span(lengths.freeze);
  const wipe = span(lengths.wipe);
  const hold = span(lengths.hold);
  const detail = kind === "same_take" ? span(lengths.detail) : null;
  const resume = span(lengths.resume);
  const endCard = span(lengths.endCard);
  return {
    fps,
    freezeFrame,
    draftFrames,
    finalFrames,
    draftFrom,
    resumeTo,
    source,
    draft,
    freeze,
    wipe,
    hold,
    detail,
    resume,
    endCard,
    fadeOut: Math.min(frames(BEATS.fadeOut) / fps, endCard.end - endCard.start),
    duration: cursor / fps,
  };
}

/** Frame index of a clip time, for checks: which composition frame a time falls on. */
export function frameAt(plan: Pick<RevealPlan, "fps">, time: number): number {
  return Math.round(time * plan.fps);
}
