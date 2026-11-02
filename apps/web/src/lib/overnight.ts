/**
 * The night shift's window, read on the engine's clock. The engine opens and closes the window by its own clock, and
 * the settings say which zone that is (`overnight.timeZone`). A browser in another zone (a judge on the shared preview)
 * works the window out there, and names the zone beside each time: "11 pm PT". Where the clocks agree (one machine),
 * times read as they always did, with no zone. Without a zone (an older engine), the browser's own clock.
 */
import { clock } from "./format";
import { instantAt, knownZone, onDay, sameClock, wallAt, zoneLong, zoneShort } from "./zone";

/** The window as the settings give it. */
export interface NightWindow {
  startAt: string;
  endAt: string;
  /** The engine's time zone, which startAt and endAt are on. */
  timeZone?: string | undefined;
}

/** Minutes since midnight of "HH:MM". */
function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Minutes since midnight on the engine's clock at an instant. */
export function minutesOnClock(night: Pick<NightWindow, "timeZone">, now: number): number {
  const w = wallAt(now, knownZone(night.timeZone));
  return w.hour * 60 + w.minute;
}

/** The instant the engine's clock reads `hhmm`, `days` after the date it shows at `ref`. */
function clockTime(night: NightWindow, ref: number, days: number, hhmm: string): number {
  const zone = knownZone(night.timeZone);
  return instantAt(onDay(wallAt(ref, zone), days, hhmm), zone);
}

/** True while the engine's clock is inside the overnight window, which usually crosses midnight. */
export function insideWindow(night: NightWindow, now: number): boolean {
  const cur = minutesOnClock(night, now);
  const start = minutesOf(night.startAt);
  const end = minutesOf(night.endAt);
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

/** The next time the window opens: today if still ahead, else tomorrow (on the engine's clock). */
export function nextWindowStart(night: NightWindow, now: number): Date {
  const today = clockTime(night, now, 0, night.startAt);
  return new Date(today > now ? today : clockTime(night, now, 1, night.startAt));
}

/** When the window that is open now opened (today or, after midnight, yesterday), or null while it is closed. */
export function windowOpenedAt(night: NightWindow, now: number): Date | null {
  if (!insideWindow(night, now)) return null;
  const today = clockTime(night, now, 0, night.startAt);
  return new Date(today <= now ? today : clockTime(night, now, -1, night.startAt));
}

/**
 * When tonight's window closes: the one open now, else the next one. A window from a time to the same time is all day.
 * Counted on the clock, not in hours, so a night when the clocks change still ends at its time.
 */
export function windowEndsAt(night: NightWindow, now: number): Date {
  const opened = (windowOpenedAt(night, now) ?? nextWindowStart(night, now)).getTime();
  const end = clockTime(night, opened, 0, night.endAt);
  return new Date(end > opened ? end : clockTime(night, opened, 1, night.endAt));
}

/** Times on the engine's clock, in words, with its zone named when that is not this browser's clock. */
export interface NightClock {
  /** The zone's short name when its clock is not this browser's ("PT"), else "". */
  label: string;
  /** "11 pm" for "23:00", or "11 pm PT" on another clock. */
  time(hhmm: string): string;
  /** An instant on the engine's clock: "3:40 am", or "3:40 am PT". */
  at(when: number | Date): string;
  /**
   * When the clocks differ, a line that says so, for the places a final is queued for the night: "The night shift
   * keeps Pacific Time, where Nightshift runs. It is 12:27 am there now." Null where the clocks agree.
   */
  note: string | null;
}

export function nightClock(night: Pick<NightWindow, "timeZone"> | undefined, now: number): NightClock {
  const zone = knownZone(night?.timeZone);
  const label = sameClock(zone, now) ? "" : zoneShort(zone, now);
  const named = (text: string) => (label ? `${text} ${label}` : text);
  const plain = (when: number) => {
    const w = wallAt(when, zone);
    return clock(`${w.hour}:${String(w.minute).padStart(2, "0")}`);
  };
  return {
    label,
    time: (hhmm) => named(clock(hhmm)),
    at: (when) => named(plain(typeof when === "number" ? when : when.getTime())),
    note: label ? `The night shift keeps ${zoneLong(zone, now)}, where Nightshift runs. It is ${plain(now)} there now.` : null,
  };
}

/**
 * When a final queued for tonight starts, in words, for the toast and the confirmation that queue one. While the window
 * is open it starts once the GPU is free, so "at 11 pm" would be wrong: it says when the window closes instead.
 */
export function tonightStart(night: NightWindow, now: number): { open: boolean; text: string } {
  const c = nightClock(night, now);
  if (insideWindow(night, now)) return { open: true, text: `Starts once the GPU is free. The night shift runs until ${c.time(night.endAt)}.` };
  return { open: false, text: `Starts at ${c.time(night.startAt)}.` };
}
