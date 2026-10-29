/** Plain-words formatting. The UI never shows raw floats to the user. */

export function gb(n: number, digits = 0): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)} TB`;
  if (n < 1 && n > 0) return `${Math.round(n * 1000)} MB`;
  return `${digits ? n.toFixed(digits) : Math.round(n)} GB`;
}

/** "about 40 seconds", "about 3 minutes", "about 1 h 20 min". Rough on purpose. */
export function roughDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "a moment";
  if (seconds < 8) return "a few seconds";
  if (seconds < 55) return `about ${Math.round(seconds / 5) * 5} seconds`;
  const min = seconds / 60;
  if (min < 1.5) return "about a minute";
  if (min < 10) return `about ${Math.round(min)} minutes`;
  if (min < 55) return `about ${Math.round(min / 5) * 5} minutes`;
  const h = Math.floor(min / 60);
  const rem = Math.round((min - h * 60) / 5) * 5;
  if (rem === 0) return h === 1 ? "about an hour" : `about ${h} hours`;
  return `about ${h} h ${rem} min`;
}

/** Compact: "40 s", "3 min", "1 h 20 min". For tight rows. */
export function shortDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const min = Math.round(seconds / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rem = min - h * 60;
  return rem ? `${h} h ${rem} min` : `${h} h`;
}

/** "0:04.2" style timecode for the editor. */
export function timecode(seconds: number, showTenths = true): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  const whole = Math.floor(rem);
  const tenths = Math.floor((rem - whole) * 10);
  const base = `${m}:${whole.toString().padStart(2, "0")}`;
  return showTenths ? `${base}.${tenths}` : base;
}

/** "11:00 pm" from "23:00". */
export function clock(hhmm: string): string {
  const [hStr, mStr] = hhmm.split(":");
  const h = Number(hStr ?? 0);
  const m = Number(mStr ?? 0);
  const suffix = h >= 12 ? "pm" : "am";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12} ${suffix}` : `${h12}:${m.toString().padStart(2, "0")} ${suffix}`;
}

export function clockFromDate(d: Date): string {
  return clock(`${d.getHours()}:${d.getMinutes().toString().padStart(2, "0")}`);
}

/** "yesterday", "3 days ago", "just now" */
export function relativeTime(iso: string, now = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return h === 1 ? "an hour ago" : `${h} hours ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function pct(n: number): string {
  return `${Math.round(Math.min(1, Math.max(0, n)) * 100)}%`;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
