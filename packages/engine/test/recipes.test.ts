import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Graph } from "../src/comfy/bind.js";
import { defaultRecipesDir, defaultWorkflowsDir, REPO_ROOT, SAMPLE_RECIPES_DIR } from "../src/paths.js";
import { fitsRecipe, loadRecipes, recommendTier, tierSummaries } from "../src/recipes.js";
import { hw, LINEUP, recipe } from "./helpers.js";

const best = (h: ReturnType<typeof hw>) => recommendTier(LINEUP, h)?.tier;

describe("tier matching", () => {
  it("DGX Spark (unified, 121.7 GB reported) gets the unified CUDA tier", () => {
    expect(best(hw({ vendor: "nvidia", vramGb: 121.7, unifiedMemory: true }, 121.7))).toBe("unified-96-cuda");
  });

  it("RTX 5090 reports 31.8 GB and still matches a 32 GB tier", () => {
    expect(best(hw({ vramGb: 31.8 }, 64))).toBe("nvidia-32");
  });

  it("small VRAM with lots of RAM gets the offload tier", () => {
    expect(best(hw({ vramGb: 24 }, 128))).toBe("nvidia-24-offload");
    expect(best(hw({ vramGb: 16 }, 64))).toBe("nvidia-12-offload");
  });

  it("the same card with little RAM falls back to the plain tier", () => {
    expect(best(hw({ vramGb: 16 }, 32))).toBe("nvidia-8");
    expect(best(hw({ vramGb: 12 }, 16))).toBe("nvidia-8");
  });

  it("a 24 GB card with 32 GB RAM fits no tier strictly, so maxVramGb is relaxed rather than leave it with nothing", () => {
    expect(LINEUP.filter((r) => fitsRecipe(r, hw({ vramGb: 24 }, 32))).map((r) => r.tier)).toEqual([]);
    expect(best(hw({ vramGb: 24 }, 32))).toBe("nvidia-8");
  });

  it("unifiedMemory must match when the recipe sets it", () => {
    expect(fitsRecipe(LINEUP[0]!, hw({ vramGb: 96 }, 128))).toBe(false);
  });

  it("Apple Silicon by memory size", () => {
    expect(best(hw({ vendor: "apple", vramGb: 128, unifiedMemory: true }, 128, { os: "macos" }))).toBe("apple-64");
    expect(best(hw({ vendor: "apple", vramGb: 64, unifiedMemory: true }, 64, { os: "macos" }))).toBe("apple-64");
    expect(best(hw({ vendor: "apple", vramGb: 24, unifiedMemory: true }, 24, { os: "macos" }))).toBe("apple-16");
    expect(best(hw({ vendor: "apple", vramGb: 8, unifiedMemory: true }, 8, { os: "macos" }))).toBeUndefined();
  });

  it("CPU-only machines match nothing unless a 'none' tier exists", () => {
    expect(best(hw(null, 32))).toBeUndefined();
    const cpu = recipe("cpu", { vendor: "none", minVramGb: 0, minRamGb: 16 });
    expect(recommendTier([...LINEUP, cpu], hw(null, 32))?.tier).toBe("cpu");
  });

  it("summaries flag exactly one recommended tier and total the downloads", () => {
    const withModels = LINEUP.map((r) =>
      r.tier === "apple-64"
        ? {
            ...r,
            models: [
              { id: "a", folder: "x", filename: "a", url: "https://example.com/a", sizeGb: 10.25, license: { name: "MIT", url: "https://example.com/l" } },
              { id: "b", folder: "x", filename: "b", url: "https://example.com/b", sizeGb: 2.1, license: { name: "MIT", url: "https://example.com/l" } },
            ],
          }
        : r,
    );
    const list = tierSummaries(withModels, hw({ vendor: "apple", vramGb: 128, unifiedMemory: true }, 128));
    expect(list.filter((t) => t.recommended).map((t) => t.tier)).toEqual(["apple-64"]);
    expect(list.find((t) => t.tier === "apple-64")?.downloadGb).toBe(12.4);
    const apple = list.find((t) => t.tier === "apple-64")!;
    expect(apple.steps).toEqual(["still"]);
    expect(apple.defaultMemoryLimitGb).toBe(102); // 80% of 128 GB, the recipe sets none
    expect(apple.estimates).toEqual({});
  });

  it("summaries say how each shipped tier finishes a take and how long one shot can be", async () => {
    const { recipes } = await loadRecipes(defaultRecipesDir(), defaultWorkflowsDir());
    const facts = Object.fromEntries(tierSummaries(recipes, hw({ vramGb: 8 }, 30)).map((t) => [t.tier, [t.sameTake, t.longestShotSec]]));
    // Kandinsky 6 Lite drafts 49 frames at 384x256; its "same take" resizes them to 768x512 and adds no detail.
    const upscale = [{ method: "upscale", scale: 2 }, 2.04];
    // LTX 2.5 drafts 97 frames at 640x384 and renders the saved latent again at 1280x768.
    const rerender = [{ method: "rerender", scale: 2 }, 4.04];
    expect(facts).toEqual({
      "unified-128-cuda": rerender,
      "apple-64": rerender,
      "nvidia-32": rerender,
      "nvidia-24-offload": rerender,
      "nvidia-12-offload": rerender,
      "nvidia-8": upscale,
      "apple-16": upscale,
    });
  });
});

describe("loadRecipes", () => {
  it("shipping Breeze workflows use eager decode so model cycling cannot replay stale CUDA graphs", async () => {
    const { recipes } = await loadRecipes(defaultRecipesDir(), defaultWorkflowsDir());
    expect(recipes).toHaveLength(7);
    for (const recipe of recipes) {
      const workflow = JSON.parse(readFileSync(join(defaultWorkflowsDir(), recipe.steps.voice!.workflow), "utf8")) as Graph;
      const loader = Object.values(workflow).find((node) => node.class_type === "BreezeTTS2LoadModel");
      expect(loader?.inputs.decode_mode).toBe("eager");
    }
  });
  it("the 8 GB tier times what an RTX 2080 SUPER measured, and says they were measured", async () => {
    const { recipes } = await loadRecipes(defaultRecipesDir(), defaultWorkflowsDir());
    const record = JSON.parse(readFileSync(join(REPO_ROOT, "research/2026-10-29_nvidia8_measurements.json"), "utf8")) as { estimates: Record<string, unknown> };
    const nvidia8 = recipes.find((r) => r.tier === "nvidia-8")!;
    expect(nvidia8.estimates).toEqual(record.estimates);
    expect(Object.values(nvidia8.estimates).every((e) => e.measured)).toBe(true);
    // A draft took 47 to 63 s and a still 141 to 175 s; the napkin math had said 13 and 5.5 minutes.
    expect(nvidia8.estimates.video_draft?.seconds).toBe(60);
    expect(nvidia8.estimates.still?.seconds).toBe(150);
  });

  it("loads the engine's sample recipes cleanly", async () => {
    const set = await loadRecipes(SAMPLE_RECIPES_DIR, defaultWorkflowsDir());
    expect(set.recipes.length).toBeGreaterThanOrEqual(4);
    expect(set.problems).toEqual([]);
    for (const r of set.recipes) for (const m of r.models) expect(m.license.name).toBeTruthy();
  });

  it("drops invalid and duplicate recipes, warns about missing workflow nodes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-recipes-"));
    const good = recipe("good", { vendor: "apple", minVramGb: 8, minRamGb: 8 });
    writeFileSync(join(dir, "a.json"), JSON.stringify(good));
    writeFileSync(join(dir, "b.json"), JSON.stringify(good));
    writeFileSync(join(dir, "c.json"), "{ nope");
    writeFileSync(join(dir, "d.json"), JSON.stringify({ tier: "Bad Tier!", label: "x" }));
    const badNode = recipe("bad-node", { vendor: "apple", minVramGb: 8, minRamGb: 8 }, {
      steps: { still: { workflow: "tests/echo_image.api.json", inputs: { prompt: { node: "99", field: "text" } }, params: {}, outputNodes: ["3"] } },
    });
    writeFileSync(join(dir, "e.json"), JSON.stringify(badNode));
    const set = await loadRecipes(dir, defaultWorkflowsDir());
    expect(set.recipes.map((r) => r.tier)).toEqual(["good", "bad-node"]);
    expect(set.problems.map((p) => [p.file, p.severity])).toEqual([
      ["b.json", "error"],
      ["c.json", "error"],
      ["d.json", "error"],
      ["e.json", "warning"],
    ]);
    expect(set.problems[3]!.message).toContain("missing node 99");
  });

  it("warns about a maxFrames the step's model cannot make, and keeps the recipe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-recipes-"));
    const ltx = (maxFrames: unknown) => ({
      workflow: "ltx25_draft.api.json",
      inputs: { frames: { node: "28", field: "value" } },
      params: { maxFrames },
      outputNodes: ["25"],
    });
    writeFileSync(join(dir, "a.json"), JSON.stringify(recipe("short", { vendor: "apple", minVramGb: 8, minRamGb: 8 }, { steps: { video_draft: ltx(5) } })));
    writeFileSync(join(dir, "b.json"), JSON.stringify(recipe("fine", { vendor: "apple", minVramGb: 16, minRamGb: 16 }, { steps: { video_draft: ltx(49) } })));
    const set = await loadRecipes(dir, defaultWorkflowsDir());
    expect(set.recipes.map((r) => r.tier)).toEqual(["short", "fine"]);
    expect(set.problems).toEqual([
      { file: "a.json", severity: "warning", message: "video_draft: maxFrames 5 is not a clip length this model makes (at least 9 frames); the measured limit is used instead" },
    ]);
  });

  it("a missing folder is simply empty", async () => {
    expect((await loadRecipes("/nonexistent/recipes")).recipes).toEqual([]);
  });
});
