import { RecipeSchema, StepIdSchema, type HardwareProfile, type ModelFile, type Recipe, type TierSummary } from "@nightshift/contract";

/**
 * The real hardware recipes from `recipes/`, so the mock and the browser demo show the same setups, download sizes,
 * models, licenses and measured times as the app. The tier logic below mirrors the engine's (packages/engine/src/recipes.ts):
 * the UI may not import the engine, only the contract.
 */
const files = import.meta.glob<unknown>("../../../../../recipes/*.json", { eager: true, import: "default" });

export const recipes: Recipe[] = Object.keys(files)
  .sort()
  .flatMap((file) => {
    const parsed = RecipeSchema.safeParse(files[file]);
    return parsed.success ? [parsed.data] : [];
  });

export type MockTier = TierSummary & { models: ModelFile[] };

/** Requirements match within 5%, as the engine matches them. */
const MATCH_TOLERANCE = 0.95;

function fits(recipe: Recipe, hw: HardwareProfile, ignoreMax = false): boolean {
  const gpu = hw.gpus[0];
  if (!gpu) return false;
  const m = recipe.match;
  if (m.vendor !== gpu.vendor) return false;
  if (m.unifiedMemory !== undefined && m.unifiedMemory !== gpu.unifiedMemory) return false;
  if (gpu.vramGb < m.minVramGb * MATCH_TOLERANCE) return false;
  if (!ignoreMax && m.maxVramGb !== undefined && gpu.vramGb > m.maxVramGb / MATCH_TOLERANCE) return false;
  return hw.ramGb >= m.minRamGb * MATCH_TOLERANCE;
}

/** The strongest setup that fits: the one that asks the most of the machine. A big card never ends up with none. */
export function recommendTier(hw: HardwareProfile | null): Recipe | undefined {
  if (!hw) return undefined;
  let candidates = recipes.filter((r) => fits(r, hw));
  if (candidates.length === 0) candidates = recipes.filter((r) => fits(r, hw, true));
  return [...candidates].sort((a, b) => b.match.minVramGb - a.match.minVramGb || b.match.minRamGb - a.match.minRamGb || a.tier.localeCompare(b.tier))[0];
}

function finishFacts(recipe: Recipe): Pick<TierSummary, "sameTake" | "longestShotSec"> {
  const facts: Pick<TierSummary, "sameTake" | "longestShotSec"> = {};
  const draft = recipe.steps.video_draft;
  const final = recipe.steps.video_final_same_take;
  if (final) {
    const [from, to] = [draft?.params.width, final.params.width];
    const scale = typeof from === "number" && typeof to === "number" && from > 0 ? Math.round((to / from) * 100) / 100 : undefined;
    facts.sameTake = { method: final.inputs.latent ? "rerender" : "upscale", ...(scale ? { scale } : {}) };
  }
  const maxFrames = draft?.params.maxFrames;
  const fps = draft?.params.fps ?? 24;
  if (typeof maxFrames === "number" && typeof fps === "number" && fps > 0) facts.longestShotSec = Math.floor((maxFrames / fps) * 100) / 100;
  return facts;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function summary(recipe: Recipe, hw: HardwareProfile | null, best: Recipe | undefined): MockTier {
  return {
    tier: recipe.tier,
    label: recipe.label,
    match: recipe.match,
    downloadGb: round1(recipe.models.reduce((sum, m) => sum + m.sizeGb, 0)),
    recommended: recipe.tier === best?.tier,
    estimates: recipe.estimates,
    referenceImageLimit: ["image", "image2", "image3"].filter((k) => (recipe.referenceStill ?? recipe.steps.still)?.inputs[k]).length,
    steps: StepIdSchema.options.filter((s) => recipe.steps[s]),
    defaultMemoryLimitGb: recipe.defaultMemoryLimitGb ?? (hw ? Math.round(hw.ramGb * 0.8) : undefined),
    ...finishFacts(recipe),
    models: recipe.models,
  };
}

/** Every setup, in the engine's order, with the best fit for this machine flagged. */
export function mockTiers(hw: HardwareProfile | null): MockTier[] {
  const best = recommendTier(hw);
  return [...recipes]
    .sort((a, b) => a.match.vendor.localeCompare(b.match.vendor) || b.match.minVramGb - a.match.minVramGb || b.match.minRamGb - a.match.minRamGb)
    .map((r) => summary(r, hw, best));
}

/** As `GET /api/tiers` answers: the summaries without their model lists. */
export function rankTiers(hw: HardwareProfile | null): TierSummary[] {
  return mockTiers(hw).map(({ models: _models, ...t }) => t);
}

export function mockTier(tier: string, hw: HardwareProfile | null = null): MockTier | undefined {
  return mockTiers(hw).find((t) => t.tier === tier);
}
