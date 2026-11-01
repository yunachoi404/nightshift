/** When a final queued for tonight starts, said truly: at the window's start, or once the GPU is free inside it. */
import { describe, expect, it } from "vitest";
import { tonightStart, windowEndsAt } from "./overnight";

// Local times, as the night window is set on the user's clock.
const at = (hour: number, minute = 0) => new Date(2026, 10, 1, hour, minute).getTime();

describe("tonight's start", () => {
  it("names the window's start while it is closed", () => {
    expect(tonightStart({ startAt: "23:00", endAt: "07:00" }, at(21, 30))).toEqual({ open: false, text: "Starts at 11 pm." });
    expect(tonightStart({ startAt: "03:05", endAt: "09:00" }, at(2, 50))).toEqual({ open: false, text: "Starts at 3:05 am." });
  });

  it("inside the window, never a start time already gone by", () => {
    // The dogfood night: the window opened at 3:05 and it was 3:45.
    expect(tonightStart({ startAt: "03:05", endAt: "09:00" }, at(3, 45))).toEqual({ open: true, text: "Starts once the GPU is free. The night shift runs until 9 am." });
    // A window across midnight, after midnight.
    expect(tonightStart({ startAt: "23:00", endAt: "07:00" }, at(1, 10)).open).toBe(true);
  });
});

describe("when the night ends", () => {
  it("the window open now, or the next one", () => {
    expect(windowEndsAt("23:00", "07:00", at(1, 10))).toEqual(new Date(2026, 10, 1, 7, 0));
    expect(windowEndsAt("23:00", "07:00", at(21, 0))).toEqual(new Date(2026, 10, 2, 7, 0));
    expect(windowEndsAt("03:05", "09:00", at(3, 45))).toEqual(new Date(2026, 10, 1, 9, 0));
  });
});
