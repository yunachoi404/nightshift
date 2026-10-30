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
