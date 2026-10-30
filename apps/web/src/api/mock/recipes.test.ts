/**
 * The mock and the browser demo show the real recipes: the same setups, sizes and measured times as the app, and the
 * same pick for each machine as the engine makes.
 */
import { StepIdSchema, type Recipe, type StepId, type WorkflowRef } from "@nightshift/contract";
import { describe, expect, it } from "vitest";
import { hardwarePresets } from "./data";
import { mockTier, rankTiers, recipes, recommendTier, stepModels } from "./recipes";

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
    expect(spark.files).toEqual(recipe.models);
    expect(rankTiers(null).every((t) => !("files" in t))).toBe(true);
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

  it("name the main model of each step, as the engine does", () => {
    expect(mockTier("unified-128-cuda")?.models).toEqual({
      text: "Qwen3-VL 4B",
      still: "Krea 2 Turbo",
      video_draft: "LTX-2.5",
      video_final_same_take: "LTX-2.5",
      video_final_remaster: "MiniMax H3",
      music: "MiniMax Music 3",
      camera_layout: "MoGe 2",
      video_camera_move: "LTX-2.5",
      effect_end_frame: "FLUX.2 Klein 4B",
      video_effect: "LTX-2.5",
      video_what_if: "LTX-2.5",
    });
    // A same take that resizes the frames loads no model, and a step the recipe lacks has none.
    expect(mockTier("nvidia-8")?.models).toEqual({ text: "Qwen3-VL 4B", still: "MOSS-Image", video_draft: "Kandinsky 6 Lite", music: "ACE-Step 1.5 Turbo" });
    expect(rankTiers(null).find((t) => t.tier === "nvidia-24-offload")?.models?.effect_end_frame).toBe("FLUX.2 Klein 4B");
  });

  it("name for every recipe and step the model the engine reads from the step's workflow", () => {
    for (const recipe of recipes) expect({ tier: recipe.tier, models: stepModels(recipe) }).toEqual({ tier: recipe.tier, models: modelsFromWorkflows(recipe) });
  });
});

// ---------------------------------------------------------------- the engine's rule, on the shipped workflows

type Graph = Record<string, { inputs?: Record<string, unknown> }>;
const workflows = import.meta.glob<Graph>("../../../../../workflows/*.api.json", { eager: true, import: "default" });
const workflow = (name: string) => workflows[`../../../../../workflows/${name}`];

/** Folders that hold a workflow's main model, as the engine counts them. */
const MAIN_MODEL_FOLDERS = new Set(["diffusion_models", "checkpoints", "unet"]);

/**
 * `workflowModel` (packages/engine/src/recipes.ts), which the UI may not import: the recipe model the step's workflow
 * names once its params are set, a diffusion model before any other, by the first part of its name.
 */
function modelsFromWorkflows(recipe: Recipe): Partial<Record<StepId, string>> {
  const out: Partial<Record<StepId, string>> = {};
  for (const step of StepIdSchema.options) {
    const ref = recipe.steps[step];
    const source = ref && workflow(ref.workflow);
    if (!ref) continue;
    expect(source, `${recipe.tier} ${step}: ${ref.workflow}`).toBeDefined();
    const named = new Set<string>();
    for (const node of Object.values(withParams(source!, ref))) for (const value of Object.values(node.inputs ?? {})) if (typeof value === "string") named.add(value.replaceAll("\\", "/"));
    const base = (path: string) => path.split("/").at(-1)!;
    const names = new Set([...named].map(base));
    const used = recipe.models.filter((m) => named.has(m.filename) || names.has(base(m.filename)));
    const main = used.find((m) => MAIN_MODEL_FOLDERS.has(m.folder)) ?? used[0];
    const name = main && (main.name?.split(",")[0]?.trim() || base(main.filename).replace(/\.[^.]+$/, ""));
    if (name) out[step] = name;
  }
  return out;
}

/** The workflow with the step's params set, as the engine's binder sets them. */
function withParams(source: Graph, ref: WorkflowRef): Graph {
  const graph = structuredClone(source);
  const set = (node: string, field: string, value: unknown) => {
    const target = graph[node];
    if (target) target.inputs = { ...target.inputs, [field]: value };
  };
  for (const [key, value] of Object.entries(ref.params ?? {})) {
    const dot = key.indexOf(".");
    const input = ref.inputs[key];
    if (dot > 0) set(key.slice(0, dot), key.slice(dot + 1), value);
    else if (input) set(input.node, input.field, value);
  }
  return graph;
}
