import { RecipeSchema, StepIdSchema, type HardwareProfile, type Recipe, type TierSummary } from "@nightshift/contract";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { frameRule, longestClipSec, type Graph } from "./comfy/bind.js";
import { primaryGpu } from "./hardware/probe.js";
import { nodePackProblems } from "./install/nodes.js";
import { round1 } from "./util.js";

/** The memory slider's starting point: the recipe's own default, else 80% of system memory. */
export function defaultMemoryLimitGb(recipe: Recipe, hw: HardwareProfile): number {
  return recipe.defaultMemoryLimitGb ?? Math.round(hw.ramGb * 0.8);
}

export interface RecipeProblem {
  file: string;
  message: string;
  /** Errors drop the recipe; warnings keep it (the step fails with a clear message when used). */
  severity: "error" | "warning";
}

export interface RecipeSet {
  dir: string;
  recipes: Recipe[];
  problems: RecipeProblem[];
}

/** Loads and validates every recipes/*.json. Also checks each step's workflow file and node ids. */
export async function loadRecipes(dir: string, workflowsDir?: string): Promise<RecipeSet> {
  const problems: RecipeProblem[] = [];
  const recipes: Recipe[] = [];
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return { dir, recipes, problems };
  }
  const seen = new Set<string>();
  for (const file of files) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(dir, file), "utf8"));
    } catch (err) {
      problems.push({ file, message: `not valid JSON: ${(err as Error).message}`, severity: "error" });
      continue;
    }
    const parsed = RecipeSchema.safeParse(raw);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      problems.push({ file, message: msg, severity: "error" });
      continue;
    }
    if (seen.has(parsed.data.tier)) {
      problems.push({ file, message: `duplicate tier "${parsed.data.tier}"`, severity: "error" });
      continue;
    }
    seen.add(parsed.data.tier);
    const packProblems = nodePackProblems(parsed.data);
    if (packProblems.length) {
      problems.push({ file, message: packProblems.join("; "), severity: "error" });
      continue;
    }
    if (workflowsDir) problems.push(...(await checkWorkflows(file, parsed.data, workflowsDir)));
    recipes.push(parsed.data);
  }
  return { dir, recipes, problems };
}

async function checkWorkflows(file: string, recipe: Recipe, workflowsDir: string): Promise<RecipeProblem[]> {
  const problems: RecipeProblem[] = [];
  for (const [step, ref] of [...Object.entries(recipe.steps), ["referenceStill", recipe.referenceStill]] as const) {
    if (!ref) continue;
    let graph: Record<string, unknown>;
    try {
      graph = JSON.parse(await readFile(join(workflowsDir, ref.workflow), "utf8")) as Record<string, unknown>;
    } catch {
      problems.push({ file, message: `${step}: workflow ${ref.workflow} not found or not JSON`, severity: "warning" });
      continue;
    }
    for (const [name, target] of Object.entries(ref.inputs)) {
      if (!(target.node in graph)) problems.push({ file, message: `${step}: input "${name}" points at missing node ${target.node}`, severity: "warning" });
    }
    for (const node of ref.outputNodes) {
      if (!(node in graph)) problems.push({ file, message: `${step}: output node ${node} is not in ${ref.workflow}`, severity: "warning" });
    }
    const max = ref.params.maxFrames;
    if (max !== undefined) {
      const { grid } = frameRule(graph as Graph);
      const shortest = grid.step + grid.offset;
      if (typeof max !== "number" || !Number.isFinite(max) || max < shortest) {
        problems.push({ file, message: `${step}: maxFrames ${JSON.stringify(max)} is not a clip length this model makes (at least ${shortest} frames); the measured limit is used instead`, severity: "warning" });
      }
    }
  }
  return problems;
}

/**
 * Reported sizes run a little under the marketing number (a "24 GB" card reports 23.99 GiB, a 5090 31.8,
 * a 64 GB Linux box about 62.7 after the kernel's share), so requirements match within 5%.
 */
export const MATCH_TOLERANCE = 0.95;

export interface FitOptions {
  /** Ignore maxVramGb. Used as a fallback so a big card never ends up with no tier at all. */
  ignoreMax?: boolean;
}

export function fitsRecipe(recipe: Recipe, hw: HardwareProfile, opts: FitOptions = {}): boolean {
  const gpu = primaryGpu(hw);
  const m = recipe.match;
  if (m.vendor !== gpu.vendor) return false;
  if (m.unifiedMemory !== undefined && m.unifiedMemory !== gpu.unifiedMemory) return false;
  if (gpu.vramGb < m.minVramGb * MATCH_TOLERANCE) return false;
  if (!opts.ignoreMax && m.maxVramGb !== undefined && gpu.vramGb > m.maxVramGb / MATCH_TOLERANCE) return false;
  if (hw.ramGb < m.minRamGb * MATCH_TOLERANCE) return false;
  return true;
}

/** Bigger requirements mean a stronger lineup: prefer the tier that asks the most of the machine and still fits. */
function capability(recipe: Recipe): [number, number] {
  return [recipe.match.minVramGb, recipe.match.minRamGb];
}

export function recommendTier(recipes: Recipe[], hw: HardwareProfile): Recipe | undefined {
  let candidates = recipes.filter((r) => fitsRecipe(r, hw));
  if (candidates.length === 0) candidates = recipes.filter((r) => fitsRecipe(r, hw, { ignoreMax: true }));
  return candidates.sort((a, b) => {
    const [av, ar] = capability(a);
    const [bv, br] = capability(b);
    return bv - av || br - ar || a.tier.localeCompare(b.tier);
  })[0];
}

export function downloadGb(recipe: Recipe): number {
  return round1(recipe.models.reduce((sum, m) => sum + m.sizeGb, 0));
}

export function tierSummaries(recipes: Recipe[], hw: HardwareProfile): TierSummary[] {
  const best = recommendTier(recipes, hw);
  return [...recipes]
    .sort((a, b) => a.match.vendor.localeCompare(b.match.vendor) || b.match.minVramGb - a.match.minVramGb || b.match.minRamGb - a.match.minRamGb)
    .map((r) => ({
      tier: r.tier,
      label: r.label,
      match: r.match,
      downloadGb: downloadGb(r),
      recommended: r.tier === best?.tier,
      estimates: r.estimates,
      referenceImageLimit: ["image", "image2", "image3"].filter(k => (r.referenceStill ?? r.steps.still)?.inputs[k]).length,
      steps: StepIdSchema.options.filter((s) => r.steps[s]),
      defaultMemoryLimitGb: defaultMemoryLimitGb(r, hw),
      ...finishFacts(r),
    }));
}

/**
 * What the UI may say about a tier's drafts and finals. A same-take final that takes the draft's latent renders the take
 * again at full size; one that only takes the draft's video resizes its frames. The longest shot is the draft step's
 * `maxFrames` over its frame rate, as the engine clamps shots (the recipe validator makes every video step set it).
 */
export function finishFacts(recipe: Recipe): Pick<TierSummary, "sameTake" | "longestShotSec"> {
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
  if (typeof maxFrames === "number" && typeof fps === "number" && fps > 0) facts.longestShotSec = longestClipSec(maxFrames, fps);
  return facts;
}
