import type { TierSummary } from "@nightshift/contract";
import { describe, expect, it } from "vitest";
import { sampleEstimates, sampleTimeLine } from "./firstShot";

/** The 8 GB setup's times, as recipes/nvidia-8.json has them: a three-shot list 480 s, a still 150 s, a draft 60 s. */
const nvidia8 = {
  tier: "nvidia-8",
  estimates: {
    text: { peakGb: 5.4, seconds: 480, measured: true },
    still: { peakGb: 6.8, seconds: 150, measured: true },
    video_draft: { peakGb: 7.2, seconds: 60, measured: true },
  },
} as unknown as TierSummary;

describe("the First shot's time", () => {
  const estimates = sampleEstimates(nvidia8, "video_draft");

  it("adds a one-shot list, the still and the draft from the recipe", () => {
    // A one-shot list is about 43% of the recipe's three-shot one: 208 s.
    expect(estimates).toEqual({ text: expect.closeTo(208, 0), still: 150, draft: 60 });
  });

  it("says the whole of it before anything is done, wherever it runs", () => {
    expect(sampleTimeLine({ estimates, done: [], elapsedSec: 0, where: "this machine" })).toBe("About 7 minutes on this machine");
    // The shot list taking longer than planned does not change the whole.
    expect(sampleTimeLine({ estimates, done: [], elapsedSec: 300, where: "Studio Spark" })).toBe("About 7 minutes on Studio Spark");
  });

  it("then what is left: the steps to come, less the time the current one has had", () => {
    expect(sampleTimeLine({ estimates, done: ["text"], elapsedSec: 0, where: "this machine" })).toBe("About 4 minutes left");
    expect(sampleTimeLine({ estimates, done: ["text"], elapsedSec: 90, where: "this machine" })).toBe("About 2 minutes left");
    // A still that runs long leaves the draft's time, never less.
    expect(sampleTimeLine({ estimates, done: ["text"], elapsedSec: 400, where: "this machine" })).toBe("About a minute left");
    expect(sampleTimeLine({ estimates, done: ["text", "still"], elapsedSec: 30, where: "this machine" })).toBe("About 30 seconds left");
    expect(sampleTimeLine({ estimates, done: ["text", "still"], elapsedSec: 58, where: "this machine" })).toBe("Almost done");
    expect(sampleTimeLine({ estimates, done: ["text", "still", "draft"], elapsedSec: 0, where: "this machine" })).toBeNull();
  });

  it("says nothing when the recipe has no time for a step", () => {
    const noDraft = { ...nvidia8, estimates: { text: nvidia8.estimates!.text, still: nvidia8.estimates!.still } } as TierSummary;
    expect(sampleEstimates(noDraft, "video_draft")).toBeNull();
    expect(sampleEstimates(null, "video_draft")).toBeNull();
    expect(sampleTimeLine({ estimates: null, done: [], elapsedSec: 0, where: "this machine" })).toBeNull();
  });
});
