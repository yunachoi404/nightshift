import { clock } from "./format";

/** Minutes since midnight of "HH:MM". */
function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** True while the clock is inside the overnight window, which usually crosses midnight. */
export function insideWindow(startAt: string, endAt: string, now: number): boolean {
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  const start = minutesOf(startAt);
  const end = minutesOf(endAt);
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

/** The next time the window opens: today if still ahead, else tomorrow. */
export function nextWindowStart(startAt: string, now: number): Date {
  const d = new Date(now);
  const [h, m] = startAt.split(":").map(Number);
  d.setHours(h ?? 23, m ?? 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d;
}

/** When the window that is open now opened (today or, after midnight, yesterday), or null while it is closed. */
export function windowOpenedAt(startAt: string, endAt: string, now: number): Date | null {
  if (!insideWindow(startAt, endAt, now)) return null;
  const d = new Date(now);
  const [h, m] = startAt.split(":").map(Number);
  d.setHours(h ?? 23, m ?? 0, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  return d;
}

/**
 * When tonight's window closes: the one open now, else the next one. A window from a time to the same time is all day.
 * Counted on the clock, not in hours, so a night when the clocks change still ends at its time.
 */
export function windowEndsAt(startAt: string, endAt: string, now: number): Date {
  const opened = windowOpenedAt(startAt, endAt, now) ?? nextWindowStart(startAt, now);
  const end = new Date(opened);
  const [h, m] = endAt.split(":").map(Number);
  end.setHours(h ?? 7, m ?? 0, 0, 0);
  if (end.getTime() <= opened.getTime()) end.setDate(end.getDate() + 1);
  return end;
}

/**
 * When a final queued for tonight starts, in words, for the toast and the confirmation that queue one. While the window
 * is open it starts once the GPU is free, so "at 11 pm" would be wrong: it says when the window closes instead.
 */
export function tonightStart(night: { startAt: string; endAt: string }, now: number): { open: boolean; text: string } {
  if (insideWindow(night.startAt, night.endAt, now)) return { open: true, text: `Starts once the GPU is free. The night shift runs until ${clock(night.endAt)}.` };
  return { open: false, text: `Starts at ${clock(night.startAt)}.` };
}
