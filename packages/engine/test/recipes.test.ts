import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StepIdSchema, type StepId } from "@nightshift/contract";
import { describe, expect, it } from "vitest";
import type { Graph } from "../src/comfy/bind.js";
import { defaultRecipesDir, defaultWorkflowsDir, REPO_ROOT, SAMPLE_RECIPES_DIR } from "../src/paths.js";
import { fitsRecipe, loadRecipes, recommendTier, tierSummaries, workflowModel } from "../src/recipes.js";
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

  it("summaries flag exactly one recommended tier and total the downloads", async () => {
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
    const list = await tierSummaries(withModels, hw({ vendor: "apple", vramGb: 128, unifiedMemory: true }, 128));
    expect(list.filter((t) => t.recommended).map((t) => t.tier)).toEqual(["apple-64"]);
    expect(list.find((t) => t.tier === "apple-64")?.downloadGb).toBe(12.4);
    const apple = list.find((t) => t.tier === "apple-64")!;
    expect(apple.steps).toEqual(["still"]);
    expect(apple.defaultMemoryLimitGb).toBe(102); // 80% of 128 GB, the recipe sets none
    expect(apple.estimates).toEqual({});
    // Without the workflows the models are not known, so no tier names them.
    expect(list.every((t) => t.models === undefined)).toBe(true);
  });

  it("summaries say how each shipped tier finishes a take and how long one shot can be", async () => {
    const { recipes } = await loadRecipes(defaultRecipesDir(), defaultWorkflowsDir());
    const facts = Object.fromEntries((await tierSummaries(recipes, hw({ vramGb: 8 }, 30))).map((t) => [t.tier, [t.sameTake, t.longestShotSec]]));
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

describe("tier models", () => {
  it("summaries name the main model of every step a shipped tier has, in plain words", async () => {
    const { recipes } = await loadRecipes(defaultRecipesDir(), defaultWorkflowsDir());
    const list = await tierSummaries(recipes, hw({ vendor: "nvidia", vramGb: 121.7, unifiedMemory: true }, 121.7), defaultWorkflowsDir());
    const models = (tier: string) => list.find((t) => t.tier === tier)!.models!;
    // The same names `workflowModel` gives the queue, one per step that loads a model of the recipe.
    for (const r of recipes) {
      const expected = Object.fromEntries(
        StepIdSchema.options.flatMap((step) => {
          const ref = r.steps[step];
          const model = ref && workflowModel(r, ref, JSON.parse(readFileSync(join(defaultWorkflowsDir(), ref.workflow), "utf8")) as Graph);
          return model ? [[step, model]] : [];
        }),
      );
      expect(models(r.tier)).toEqual(expected);
      expect(Object.keys(models(r.tier)).every((step) => r.steps[step as StepId])).toBe(true);
    }
    const spark = models("unified-128-cuda");
    expect(spark).toMatchObject({ still: "Krea 2 Turbo", video_draft: "LTX-2.5", video_final_remaster: "MiniMax H3" });
    expect(spark.effect_end_frame).toMatch(/Klein/);
    // The small tiers' same take resizes the draft's frames: it loads no model, so it names none.
    expect(models("nvidia-8").video_final_same_take).toBeUndefined();
    expect(models("nvidia-8").video_draft).toBe("Kandinsky 6 Lite");
    expect(models("nvidia-8").effect_end_frame).toBeUndefined();
  });

  it("a step whose workflow is missing names no model, and a changed workflow is read again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-models-"));
    const r = recipe("test", { vendor: "nvidia", minVramGb: 8, minRamGb: 16 }, {
      models: [
        { id: "a", name: "Model A, image model", folder: "diffusion_models", filename: "a.safetensors", url: "https://example.com/a", sizeGb: 1, license: { name: "MIT", url: "https://example.com/l" } },
        { id: "b", name: "Model B", folder: "diffusion_models", filename: "b.safetensors", url: "https://example.com/b", sizeGb: 1, license: { name: "MIT", url: "https://example.com/l" } },
      ],
      steps: {
        still: { workflow: "still.json", inputs: {}, params: {}, outputNodes: ["9"] },
        video_draft: { workflow: "missing.json", inputs: {}, params: {}, outputNodes: ["9"] },
      },
    });
    const write = (unet: string, mtime: number) => {
      writeFileSync(join(dir, "still.json"), JSON.stringify({ "1": { class_type: "UNETLoader", inputs: { unet_name: unet } } }));
      utimesSync(join(dir, "still.json"), mtime, mtime);
    };
    write("a.safetensors", 1_000);
    const [first] = await tierSummaries([r], hw({ vramGb: 8 }, 16), dir);
    expect(first!.models).toEqual({ still: "Model A" });
    write("b.safetensors", 2_000);
    const [second] = await tierSummaries([r], hw({ vramGb: 8 }, 16), dir);
    expect(second!.models).toEqual({ still: "Model B" });
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

  it("names the main model a step loads, so finals for the night can be grouped by it", async () => {
    const { recipes } = await loadRecipes(defaultRecipesDir(), defaultWorkflowsDir());
    const model = (tier: string, step: StepId) => {
      const r = recipes.find((x) => x.tier === tier)!;
      const ref = r.steps[step];
      return ref && workflowModel(r, ref, JSON.parse(readFileSync(join(defaultWorkflowsDir(), ref.workflow), "utf8")) as Graph);
    };
    // The web app's mock names them the same way (apps/web/src/api/mock/recipes.test.ts).
    expect(Object.fromEntries(recipes.map((r) => [r.tier, [model(r.tier, "video_final_same_take"), model(r.tier, "video_final_remaster")]]))).toEqual({
      // The small tiers' same take resizes the draft's frames: it loads no model.
      "apple-16": [undefined, undefined],
      "apple-64": ["LTX-2.5", undefined],
      "nvidia-12-offload": ["LTX-2.5", undefined],
      "nvidia-24-offload": ["LTX-2.5", "MiniMax H3"],
      "nvidia-32": ["LTX-2.5", "MiniMax H3"],
      "nvidia-8": [undefined, undefined],
      "unified-128-cuda": ["LTX-2.5", "MiniMax H3"],
    });
    expect(model("apple-16", "video_draft")).toBe("Kandinsky 6 Lite");
  });

  it("a step's params can name the model its workflow loads", () => {
    const r = recipe("test", { vendor: "nvidia", minVramGb: 8, minRamGb: 16 }, {
      models: [
        { id: "a", name: "Model A, video model", folder: "diffusion_models", filename: "a.safetensors", url: "https://example.com/a", sizeGb: 1, license: { name: "MIT", url: "https://example.com/l" } },
        { id: "b", folder: "diffusion_models", filename: "sub/b-int8.safetensors", url: "https://example.com/b", sizeGb: 1, license: { name: "MIT", url: "https://example.com/l" } },
        { id: "v", name: "A VAE", folder: "vae", filename: "v.safetensors", url: "https://example.com/v", sizeGb: 1, license: { name: "MIT", url: "https://example.com/l" } },
      ],
    });
    const graph: Graph = { "1": { class_type: "VAELoader", inputs: { vae_name: "v.safetensors" } }, "2": { class_type: "UNETLoader", inputs: { unet_name: "a.safetensors" } } };
    const ref = { workflow: "w.json", inputs: {}, params: {}, outputNodes: ["9"] };
    expect(workflowModel(r, ref, graph)).toBe("Model A");
    // A model without a plain name goes by its file name.
    expect(workflowModel(r, { ...ref, params: { "2.unet_name": "sub/b-int8.safetensors" } }, graph)).toBe("b-int8");
    expect(workflowModel(r, ref, { "1": graph["1"]! })).toBe("A VAE");
    expect(workflowModel(r, ref, {})).toBeUndefined();
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
