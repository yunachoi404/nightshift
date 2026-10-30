import type { Project, TierSummary } from "@nightshift/contract";
import { describe, expect, it } from "vitest";
import { actionLabel, initialPanel, makeRequests, roughShort, seedsFor, shownTools, toolBlocked, toolModel, videoLengths, whyNot } from "./tools";

const project = { aspect: "16:9", assets: [{ id: "img", kind: "image", path: "img.png", createdAt: "" }], references: [] } as unknown as Pick<Project, "aspect" | "assets" | "references">;
const tier = (more: Partial<TierSummary> = {}) => ({ steps: ["still", "video_draft", "effect_end_frame", "video_effect"], ...more }) as TierSummary;

describe("panel tools", () => {
  it("offers Edit only where the setup has its image edit step", () => {
    expect(shownTools(tier()).map((t) => t.tool)).toEqual(["image", "video", "edit", "effect", "camera_move"]);
    expect(shownTools(tier({ steps: ["still", "video_draft"] })).map((t) => t.tool)).toEqual(["image", "video", "effect", "camera_move"]);
    // Not known yet: no Edit, the others as before.
    expect(shownTools(null).map((t) => t.tool)).not.toContain("edit");
    expect(toolBlocked(null, "image")).toBeUndefined();
    expect(toolBlocked(tier({ steps: ["still"] }), "camera_move")).toBe("This setup cannot make camera moves.");
  });

  it("says exactly what the bar does", () => {
    expect([1, 3].map((n) => actionLabel("image", n))).toEqual(["Generate image", "Generate 3 images"]);
    expect(actionLabel("video", 1)).toBe("Make video");
    expect(actionLabel("edit", 1)).toBe("Make the edit");
    expect(actionLabel("effect", 1)).toBe("Apply effect");
    expect(actionLabel("camera_move", 2)).toBe("Make 2 camera moves");
    expect(roughShort(31)).toBe("About 30 s");
    expect(roughShort(150)).toBe("About 3 min");
  });

  it("names the model, both of them when a video draws its still first", () => {
    const t = tier({ models: { still: "Krea 2 Turbo", video_draft: "LTX-2.5" } });
    expect(toolModel(t, "image", false)).toBe("Krea 2 Turbo");
    expect(toolModel(t, "video", true)).toBe("LTX-2.5");
    expect(toolModel(t, "video", false)).toBe("Krea 2 Turbo, then LTX-2.5");
    expect(toolModel(tier(), "image", false)).toBeUndefined();
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
    expect(whyNot({ ...state, instruction: "" }, { project, tier: tier() })).toBe("Say what to change.");
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
