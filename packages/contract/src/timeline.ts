import type { Timeline } from "./index.js";

/**
 * Where a cut ends: its last clip or card, in seconds to the millisecond. The export is exactly this long, so it is the
 * film's length wherever the app shows one. It is shorter than the shots added up when they dissolve into each other.
 */
export function timelineDuration(timeline: Pick<Timeline, "clips" | "overlays">): number {
  let end = 0;
  for (const c of timeline.clips) end = Math.max(end, c.start + (c.out - c.in));
  for (const o of timeline.overlays ?? []) end = Math.max(end, o.end);
  return Math.round(end * 1000) / 1000;
}
