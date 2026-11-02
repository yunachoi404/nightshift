/**
 * Wall clocks in a named time zone, with the browser's Intl. The engine keeps the night shift on its own clock, which
 * is not the browser's when a judge opens a shared preview from another part of the world.
 */

/** A time on a wall clock: the date (month 1 to 12) and the time of day, to the minute. */
export interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const parts = new Map<string, Intl.DateTimeFormat>();

function partsFormat(zone: string): Intl.DateTimeFormat {
  let f = parts.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    parts.set(zone, f);
  }
  return f;
}

/** This browser's time zone. */
export function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** `zone` when this browser knows it, else the browser's own: an engine may name a zone an old browser lacks. */
export function knownZone(zone: string | undefined): string {
  if (!zone) return browserZone();
  try {
    partsFormat(zone);
    return zone;
  } catch {
    return browserZone();
  }
}

/** The wall clock in `zone` at an instant (ms since epoch). */
export function wallAt(ms: number, zone: string): Wall {
  const out: Wall = { year: 0, month: 0, day: 0, hour: 0, minute: 0 };
  for (const p of partsFormat(zone).formatToParts(new Date(ms))) if (p.type in out) out[p.type as keyof Wall] = Number(p.value);
  return out;
}

/** How far `zone`'s clock is ahead of UTC at an instant, in ms. */
function offsetAt(ms: number, zone: string): number {
  const w = wallAt(ms, zone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - Math.floor(ms / 60_000) * 60_000;
}

/**
 * The instant `zone`'s clock reads `wall`. As `Date.setHours` does: a time skipped when the clocks go forward is read
 * on the clock before the change (2:30 am becomes 3:30 am), and a time that comes twice is its first.
 */
export function instantAt(wall: Wall, zone: string): number {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const before = asUtc - offsetAt(asUtc - 86_400_000, zone);
  const after = asUtc - offsetAt(asUtc + 86_400_000, zone);
  const reads = (t: number) => {
    const w = wallAt(t, zone);
    return w.year === wall.year && w.month === wall.month && w.day === wall.day && w.hour === wall.hour && w.minute === wall.minute;
  };
  const fits = [before, after].filter(reads);
  return fits.length ? Math.min(...fits) : before;
}

/** The date `days` after (or before) the wall's, at `hhmm`. */
export function onDay(wall: Wall, days: number, hhmm: string): Wall {
  const d = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  const [h, m] = hhmm.split(":").map(Number);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: h ?? 0, minute: m ?? 0 };
}

/** Whether `zone`'s clock reads the same as this browser's at an instant: then a time there needs no zone named. */
export function sameClock(zone: string, ms: number): boolean {
  return offsetAt(ms, zone) === offsetAt(ms, browserZone());
}

function zoneName(zone: string, ms: number, style: "shortGeneric" | "short" | "longGeneric"): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: style }).formatToParts(new Date(ms)).find((p) => p.type === "timeZoneName")?.value;
  return name ?? zone;
}

/** A zone's short name: "PT", "ET", "Germany Time". "UTC" over "GMT+0". */
export function zoneShort(zone: string, ms: number): string {
  const generic = zoneName(zone, ms, "shortGeneric");
  return generic.startsWith("GMT") ? zoneName(zone, ms, "short") : generic;
}

/** A zone's name in words: "Pacific Time", "Central European Time". */
export function zoneLong(zone: string, ms: number): string {
  return zoneName(zone, ms, "longGeneric");
}
