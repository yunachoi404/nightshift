/**
 * The mock and the browser demo show the real recipes: the same setups, sizes and measured times as the app, and the
 * same pick for each machine as the engine makes.
 */
import { describe, expect, it } from "vitest";
import { hardwarePresets } from "./data";
import { mockTier, rankTiers, recipes, recommendTier } from "./recipes";

const preset = (key: string) => hardwarePresets[key]!.profile;

describe("the mock's setups", () => {
  it("are the seven recipes in recipes/", () => {
    expect(recipes.map((r) => r.tier).sort()).toEqual(["apple-16", "apple-64", "nvidia-12-offload", "nvidia-24-offload", "nvidia-32", "nvidia-8", "unified-128-cuda"]);
  });

  it("pick for each sample machine what the engine picks, and one at most", () => {
    expect(recommendTier(preset("spark"))?.tier).toBe("unified-128-cuda");
    expect(recommendTier(preset("rtx2080"))?.tier).toBe("nvidia-8");
    expect(recommendTier(preset("m4max"))?.tier).toBe("apple-64");
    expect(recommendTier(preset("air16"))?.tier).toBe("apple-16");
    expect(recommendTier(preset("nogpu"))).toBeUndefined();
    expect(rankTiers(preset("spark")).filter((t) => t.recommended).map((t) => t.tier)).toEqual(["unified-128-cuda"]);
  });

  it("carry the recipes' sizes, measured times and finishing facts", () => {
    const spark = mockTier("unified-128-cuda")!;
    const recipe = recipes.find((r) => r.tier === "unified-128-cuda")!;
    expect(spark.downloadGb).toBe(Math.round(recipe.models.reduce((s, m) => s + m.sizeGb, 0) * 10) / 10);
    expect(spark.models).toEqual(recipe.models);
    expect(spark.estimates?.still).toEqual(recipe.estimates.still);
    expect(spark.estimates?.video_draft?.measured).toBe(true);
    expect(spark.steps).toContain("video_what_if");
    expect(spark.sameTake).toEqual({ method: "rerender", scale: 2 });
    expect(spark.longestShotSec).toBe(4.04);

    const small = mockTier("nvidia-8")!;
    expect(small.sameTake?.method).toBe("upscale");
    expect(small.longestShotSec).toBe(2.04);
    expect(small.steps).not.toContain("video_final_remaster");
  });
});
