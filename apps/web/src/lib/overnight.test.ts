/**
 * The night shift's window on the engine's clock. The browser here is in US Eastern time (set below, before any date
 * is made; each test file runs in its own process). The engine is wherever its settings say.
 */
process.env.TZ = "America/New_York";

import { describe, expect, it } from "vitest";
import { insideWindow, nextWindowStart, nightClock, tonightStart, windowEndsAt, windowOpenedAt, type NightWindow } from "./overnight";
import { instantAt, knownZone, sameClock, wallAt, zoneShort } from "./zone";

// Local times, on this browser's clock: an engine that names no zone (an older one) is read on it.
const at = (hour: number, minute = 0) => new Date(2026, 10, 1, hour, minute).getTime();
const local = (startAt: string, endAt: string): NightWindow => ({ startAt, endAt });

const PT = "America/Los_Angeles";
/** An instant, from its time in UTC. */
const utc = (month: number, day: number, hour: number, minute = 0) => Date.UTC(2026, month - 1, day, hour, minute);

describe("tonight's start", () => {
  it("names the window's start while it is closed", () => {
    expect(tonightStart(local("23:00", "07:00"), at(21, 30))).toEqual({ open: false, text: "Starts at 11 pm." });
    expect(tonightStart(local("03:05", "09:00"), at(2, 50))).toEqual({ open: false, text: "Starts at 3:05 am." });
  });

  it("inside the window, never a start time already gone by", () => {
    // The dogfood night: the window opened at 3:05 and it was 3:45.
    expect(tonightStart(local("03:05", "09:00"), at(3, 45))).toEqual({ open: true, text: "Starts once the GPU is free. The night shift runs until 9 am." });
    // A window across midnight, after midnight.
    expect(tonightStart(local("23:00", "07:00"), at(1, 10)).open).toBe(true);
  });
});

describe("when the night ends", () => {
  it("the window open now, or the next one", () => {
    expect(windowEndsAt(local("23:00", "07:00"), at(1, 10))).toEqual(new Date(2026, 10, 1, 7, 0));
    expect(windowEndsAt(local("23:00", "07:00"), at(21, 0))).toEqual(new Date(2026, 10, 2, 7, 0));
    expect(windowEndsAt(local("03:05", "09:00"), at(3, 45))).toEqual(new Date(2026, 10, 1, 9, 0));
  });
});

describe("on the engine's clock, from a browser in another zone", () => {
  // The walkthrough: at 3:27 am Eastern a browser said the night shift was on until 6 am, but the engine, on Pacific
  // time, held the final until 12:30 am there (3:30 am Eastern).
  const spark: NightWindow = { startAt: "00:30", endAt: "06:00", timeZone: PT };
  const now = utc(11, 2, 8, 27); // 3:27 am EST, 12:27 am PST

  it("is closed until the engine's clock reaches the start", () => {
    expect(insideWindow(spark, now)).toBe(false);
    expect(insideWindow({ ...spark, timeZone: undefined }, now)).toBe(true); // what the browser's clock said
    expect(windowOpenedAt(spark, now)).toBeNull();
    expect(nextWindowStart(spark, now).getTime()).toBe(utc(11, 2, 8, 30));
    expect(windowEndsAt(spark, now).getTime()).toBe(utc(11, 2, 14, 0));
    expect(tonightStart(spark, now)).toEqual({ open: false, text: "Starts at 12:30 am PT." });
  });

  it("opens at the engine's start, and says until when on its clock", () => {
    const later = utc(11, 2, 8, 31);
    expect(insideWindow(spark, later)).toBe(true);
    expect(windowOpenedAt(spark, later)?.getTime()).toBe(utc(11, 2, 8, 30));
    expect(tonightStart(spark, later)).toEqual({ open: true, text: "Starts once the GPU is free. The night shift runs until 6 am PT." });
  });

  it("crosses midnight on the engine's clock, not the browser's", () => {
    const night: NightWindow = { startAt: "23:00", endAt: "07:00", timeZone: PT };
    // 1:30 am Eastern is 10:30 pm Pacific: the browser's night has started, the engine's has not.
    const evening = utc(11, 3, 6, 30);
    expect(insideWindow(night, evening)).toBe(false);
    expect(nextWindowStart(night, evening).getTime()).toBe(utc(11, 3, 7, 0));
    // 9 am Eastern is 6 am Pacific: still open there, and it opened the evening before, on the engine's date.
    const dawn = utc(11, 3, 14, 0);
    expect(insideWindow(night, dawn)).toBe(true);
    expect(windowOpenedAt(night, dawn)?.getTime()).toBe(utc(11, 3, 7, 0));
    expect(windowEndsAt(night, dawn).getTime()).toBe(utc(11, 3, 15, 0));
  });

  it("works across a whole day of difference, as for a judge in Tokyo", () => {
    const tokyo: NightWindow = { startAt: "23:00", endAt: "07:00", timeZone: "Asia/Tokyo" };
    // 10 am Eastern on Nov 2 is midnight in Tokyo on Nov 3.
    const now = utc(11, 2, 15, 0);
    expect(insideWindow(tokyo, now)).toBe(true);
    expect(windowOpenedAt(tokyo, now)?.getTime()).toBe(utc(11, 2, 14, 0));
    expect(windowEndsAt(tokyo, now).getTime()).toBe(utc(11, 2, 22, 0));
  });

  it("ends a night when the clocks change at its time on the clock", () => {
    // Pacific time falls back at 2 am on Nov 1, 2026: that night is nine hours long, and still ends at 7 am.
    const night: NightWindow = { startAt: "23:00", endAt: "07:00", timeZone: PT };
    const midnight = utc(11, 1, 7, 30); // 12:30 am PDT
    expect(windowOpenedAt(night, midnight)?.getTime()).toBe(utc(11, 1, 6, 0));
    expect(windowEndsAt(night, midnight).getTime()).toBe(utc(11, 1, 15, 0));
    // It springs forward at 2 am on Mar 8, 2026: a window that starts at 2:30 am opens at 3:30 am that night.
    expect(nextWindowStart({ startAt: "02:30", endAt: "06:00", timeZone: PT }, utc(3, 8, 9, 0)).getTime()).toBe(utc(3, 8, 10, 30));
  });
});

describe("times on the engine's clock, in words", () => {
  const now = utc(11, 2, 8, 27); // 3:27 am EST, 12:27 am PST

  it("name the engine's zone where its clock is not this browser's, and say what time it is there", () => {
    const c = nightClock({ timeZone: PT }, now);
    expect(c.label).toBe("PT");
    expect(c.time("23:00")).toBe("11 pm PT");
    expect(c.at(utc(11, 2, 11, 40))).toBe("3:40 am PT");
    expect(c.at(new Date(utc(11, 2, 11, 40)))).toBe("3:40 am PT");
    expect(c.note).toBe("The night shift keeps Pacific Time, where Nightshift runs. It is 12:27 am there now.");
  });

  it("read as they always did where the clocks agree", () => {
    for (const zone of [undefined, "America/New_York", "America/Toronto"]) {
      const c = nightClock({ timeZone: zone }, now);
      expect(c.label).toBe("");
      expect(c.time("23:00")).toBe("11 pm");
      expect(c.at(utc(11, 2, 11, 40))).toBe("6:40 am");
      expect(c.note).toBeNull();
    }
    expect(nightClock(undefined, now).time("07:30")).toBe("7:30 am");
  });

  it("fall back to this browser's clock for a zone it does not know", () => {
    expect(knownZone("Mars/Olympus_Mons")).toBe("America/New_York");
    const odd: NightWindow = { startAt: "00:30", endAt: "06:00", timeZone: "Mars/Olympus_Mons" };
    expect(insideWindow(odd, now)).toBe(true);
    expect(nightClock(odd, now).label).toBe("");
  });

  it("use short zone names a judge reads at a glance", () => {
    expect(zoneShort(PT, now)).toBe("PT");
    expect(zoneShort("America/New_York", now)).toBe("ET");
    expect(zoneShort("UTC", now)).toBe("UTC");
    expect(zoneShort("Europe/Berlin", now)).toBe("Germany Time");
  });
});

describe("wall clocks in a zone", () => {
  it("read and set the same instant", () => {
    const t = utc(11, 2, 8, 27);
    expect(wallAt(t, PT)).toEqual({ year: 2026, month: 11, day: 2, hour: 0, minute: 27 });
    expect(instantAt({ year: 2026, month: 11, day: 2, hour: 0, minute: 27 }, PT)).toBe(t);
    // Midnight reads as 0, never 24.
    expect(wallAt(utc(11, 2, 8, 0), PT).hour).toBe(0);
  });

  it("take a time that comes twice as its first, as Date.setHours does", () => {
    // 1:30 am on Nov 1, 2026 in Pacific time comes once in PDT (8:30 UTC), again in PST (9:30 UTC).
    expect(instantAt({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, PT)).toBe(utc(11, 1, 8, 30));
  });

  it("agree with this browser when the zone keeps its offsets", () => {
    expect(sameClock("America/New_York", utc(11, 2, 8, 0))).toBe(true);
    expect(sameClock(PT, utc(11, 2, 8, 0))).toBe(false);
    // Phoenix keeps mountain standard time all year: two hours behind Eastern in winter.
    expect(sameClock("America/Phoenix", utc(11, 2, 8, 0))).toBe(false);
  });
});
