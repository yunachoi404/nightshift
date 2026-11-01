import type { Project, TierSummary } from "@nightshift/contract";
import { describe, expect, it } from "vitest";
import { actionLabel, initialPanel, makeRequests, roughShort, seedsFor, shownTools, toolBlocked, toolModel, toolSeconds, videoLengths, whyNot } from "./tools";

const project = { aspect: "16:9", assets: [{ id: "img", kind: "image", path: "img.png", createdAt: "" }], references: [] } as unknown as Pick<Project, "aspect" | "assets" | "references">;
const tier = (more: Partial<TierSummary> = {}) => ({ steps: ["still", "video_draft", "effect_end_frame", "video_effect"], ...more }) as TierSummary;

describe("panel tools", () => {
  it("offers Edit only where the setup has its image edit step", () => {
    expect(shownTools(tier()).map((t) => t.tool)).toEqual(["image", "video", "edit", "effect", "camera_move"]);
    expect(shownTools(tier({ steps: ["still", "video_draft"] })).map((t) => t.tool)).toEqual(["image", "video", "effect", "camera_move"]);
    // Not known yet: no Edit, the others as before.
    expect(shownTools(null).map((t) => t.tool)).not.toContain("edit");
    expect(toolBlocked(null, "image")).toBeUndefined();
    expect(toolBlocked(tier({ steps: ["still"] }), "camera_move")).toBe("This setup cannot make camera moves");
  });

  it("says exactly what the bar does", () => {
    expect([1, 3].map((n) => actionLabel("image", n))).toEqual(["Generate image", "Generate 3 images"]);
    expect(actionLabel("video", 1)).toBe("Make video");
    expect(actionLabel("edit", 1)).toBe("Make the edit");
    expect(actionLabel("effect", 1)).toBe("Apply effect");
    expect(actionLabel("camera_move", 2)).toBe("Make 2 camera moves");
    expect(roughShort(31)).toBe("About 30 s");
    expect(roughShort(80)).toBe("About 1.5 min");
    expect(roughShort(150)).toBe("About 3 min");
  });

  it("names the model, both of them when a video draws its still first", () => {
    const t = tier({ models: { still: "Krea 2 Turbo", video_draft: "LTX-2.5" } });
    expect(toolModel(t, "image", false)).toBe("Krea 2 Turbo");
    expect(toolModel(t, "video", true)).toBe("LTX-2.5");
    expect(toolModel(t, "video", false)).toBe("Krea 2 Turbo, then LTX-2.5");
    expect(toolModel(tier(), "image", false)).toBeUndefined();
  });

  it("names the reference model while a reference is on, where the setup has one", () => {
    // The dogfood night: "Model: Krea 2 Turbo" with a reference on, while FLUX.2 Klein 4B drew it.
    const t = tier({ models: { still: "Krea 2 Turbo", video_draft: "LTX-2.5" }, referenceStillModel: "FLUX.2 Klein 4B" });
    expect(toolModel(t, "image", false, true)).toBe("FLUX.2 Klein 4B");
    expect(toolModel(t, "image", false, false)).toBe("Krea 2 Turbo");
    expect(toolModel(t, "video", false, true)).toBe("FLUX.2 Klein 4B, then LTX-2.5");
    expect(toolModel(t, "video", true, true)).toBe("LTX-2.5");
    // A setup that draws references with its still workflow names that.
    expect(toolModel(tier({ models: { still: "Krea 2 Turbo" } }), "image", false, true)).toBe("Krea 2 Turbo");
  });

  it("times a make by the jobs it queues, from the Spark's measured night", () => {
    // research/2026-11-01_dogfood_job_times.json, through the recipe: each step's time is its whole job.
    const spark = tier({ estimates: { still: { peakGb: 33, seconds: 11.4, measured: true }, video_draft: { peakGb: 44, seconds: 56.2, measured: true }, effect_end_frame: { peakGb: 19, seconds: 9.1, measured: true }, video_effect: { peakGb: 45, seconds: 55.6, measured: true }, camera_layout: { peakGb: 3, seconds: 8.8, measured: true }, video_camera_move: { peakGb: 41, seconds: 79.6, measured: true } } });
    const said = (t: Parameters<typeof toolSeconds>[1], fromImage = true) => roughShort(toolSeconds(spark, t, fromImage)!);
    // The night measured 6 to 14 s a still, 9 s an edit, 54 to 58 s an effect and 80 s a camera move. The app said
    // about 30 s, 30 s, 2 min and a minute.
    expect(said("image", false)).toBe("About 10 s");
    expect(said("edit")).toBe("About 10 s");
    expect(said("effect")).toBe("About a minute");
    expect(said("camera_move")).toBe("About 1.5 min");
    // A video from words draws its still first: two jobs.
    expect(toolSeconds(spark, "video", false)).toBeCloseTo(67.6);
    expect(toolSeconds(spark, "video", true)).toBe(56.2);
  });

  it("offers the video lengths the model makes", () => {
    expect(videoLengths(null)).toEqual([2, 3, 4]);
    expect(videoLengths(tier({ longestShotSec: 4.04 }))).toEqual([2, 3, 4]);
    expect(videoLengths(tier({ longestShotSec: 2.04 }))).toEqual([2]);
  });

  it("seeds variations: none for one random make, distinct random ones, or counting up from a fixed one", () => {
    expect(seedsFor(1, null)).toEqual([undefined]);
    let n = 0;
    // A random source that repeats itself still yields distinct seeds.
    expect(seedsFor(3, null, () => [5, 5, 9, 12][n++]!)).toEqual([5, 9, 12]);
    expect(seedsFor(3, 7)).toEqual([7, 8, 9]);
  });

  it("builds the requests, with the shape only when it is not the project's", () => {
    const state = { ...initialPanel, tool: "edit" as const, source: "img", instruction: " Make it night ", aspect: "1:1" as const, variations: 2, seed: 10 };
    expect(whyNot({ ...state, instruction: "" }, { project, tier: tier() })).toBe("Say what to change");
    // An edit keeps its image's shape, whatever format was chosen for drawing from words.
    const square = { ...project, assets: [{ id: "img", kind: "image", path: "img.png", width: 1024, height: 1024, createdAt: "" }] } as unknown as typeof project;
    expect(makeRequests(state, { project: square, boardId: "b", tier: tier() })).toEqual([
      { tool: "edit", boardId: "b", prompt: "Make it night", aspect: "1:1", imageAssetId: "img", seed: 10 },
      { tool: "edit", boardId: "b", prompt: "Make it night", aspect: "1:1", imageAssetId: "img", seed: 11 },
    ]);
    // An image of the project's shape (or of no known shape) sends none.
    expect(makeRequests({ ...state, variations: 1, seed: null }, { project, boardId: "b", tier: tier() })).toEqual([{ tool: "edit", boardId: "b", prompt: "Make it night", imageAssetId: "img" }]);
    // Drawing from words takes the chosen format.
    expect(makeRequests({ ...initialPanel, tool: "image", prompt: "A cliff", aspect: "9:16", variations: 1, seed: null }, { project, boardId: "b", tier: tier() })[0]?.aspect).toBe("9:16");
  });
});
