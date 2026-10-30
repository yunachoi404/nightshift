import { RecipeSchema, StepIdSchema, type HardwareProfile, type Recipe, type TierSummary, type WorkflowRef } from "@nightshift/contract";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { bindWorkflow, frameRule, longestClipSec, type Graph } from "./comfy/bind.js";
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

const graphs = new Map<string, { mtimeMs: number; graph: Graph }>();

/**
 * A workflow graph from its file, read again only when the file changes. Undefined when it is missing or not JSON.
 * The graph is shared: read it, or bind a copy (`bindWorkflow` clones it), never change it.
 */
export async function readGraph(path: string): Promise<Graph | undefined> {
  try {
    const { mtimeMs } = await stat(path);
    const hit = graphs.get(path);
    if (hit?.mtimeMs === mtimeMs) return hit.graph;
    const graph = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!graph || typeof graph !== "object" || Array.isArray(graph)) return undefined;
    graphs.set(path, { mtimeMs, graph: graph as Graph });
    return graph as Graph;
  } catch {
    return undefined;
  }
}

async function checkWorkflows(file: string, recipe: Recipe, workflowsDir: string): Promise<RecipeProblem[]> {
  const problems: RecipeProblem[] = [];
  for (const [step, ref] of [...Object.entries(recipe.steps), ["referenceStill", recipe.referenceStill]] as const) {
    if (!ref) continue;
    const graph = await readGraph(join(workflowsDir, ref.workflow));
    if (!graph) {
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
      const { grid } = frameRule(graph);
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

/**
 * What the UI shows of each tier, the recommended one flagged. With `workflowsDir`, each tier also names the main model
 * of every step it has (`models`), read from the step's workflow.
 */
export async function tierSummaries(recipes: Recipe[], hw: HardwareProfile, workflowsDir?: string): Promise<TierSummary[]> {
  const best = recommendTier(recipes, hw);
  const sorted = [...recipes].sort((a, b) => a.match.vendor.localeCompare(b.match.vendor) || b.match.minVramGb - a.match.minVramGb || b.match.minRamGb - a.match.minRamGb);
  return Promise.all(
    sorted.map(async (r) => ({
      tier: r.tier,
      label: r.label,
      match: r.match,
      downloadGb: downloadGb(r),
      recommended: r.tier === best?.tier,
      estimates: r.estimates,
      referenceImageLimit: ["image", "image2", "image3"].filter(k => (r.referenceStill ?? r.steps.still)?.inputs[k]).length,
      steps: StepIdSchema.options.filter((s) => r.steps[s]),
      ...(workflowsDir === undefined ? {} : { models: await stepModels(r, workflowsDir) }),
      defaultMemoryLimitGb: defaultMemoryLimitGb(r, hw),
      ...finishFacts(r),
    })),
  );
}

/** The main model of each step a recipe has, in plain words (`workflowModel`). A step whose model is unknown has none. */
export async function stepModels(recipe: Recipe, workflowsDir: string): Promise<NonNullable<TierSummary["models"]>> {
  const models: NonNullable<TierSummary["models"]> = {};
  for (const step of StepIdSchema.options) {
    const ref = recipe.steps[step];
    const graph = ref && (await readGraph(join(workflowsDir, ref.workflow)));
    const model = ref && graph ? workflowModel(recipe, ref, graph) : undefined;
    if (model) models[step] = model;
  }
  return models;
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

/** Model folders that hold a workflow's main model: the big one that takes the time to load. */
const MAIN_MODEL_FOLDERS = new Set(["diffusion_models", "checkpoints", "unet"]);

/**
 * The main model a step's workflow loads, in plain words: "LTX-2.5" for a model named "LTX-2.5, video model". It is the
 * recipe model the workflow's loaders name (after the step's params), a diffusion model before any other. Undefined
 * when the workflow loads none of the recipe's models, as a plain resize does.
 */
export function workflowModel(recipe: Recipe, ref: WorkflowRef, source: Graph): string | undefined {
  let graph = source;
  try {
    graph = bindWorkflow(source, ref, {}).graph;
  } catch {
    // A param the binder refuses: read the workflow as written.
  }
  const named = new Set<string>();
  for (const node of Object.values(graph)) {
    for (const value of Object.values(node.inputs ?? {})) if (typeof value === "string") named.add(value.replaceAll("\\", "/"));
  }
  const names = new Set([...named].map((v) => posix.basename(v)));
  const used = recipe.models.filter((m) => named.has(m.filename) || names.has(posix.basename(m.filename)));
  const main = used.find((m) => MAIN_MODEL_FOLDERS.has(m.folder)) ?? used[0];
  if (!main) return undefined;
  return main.name?.split(",")[0]?.trim() || posix.basename(main.filename).replace(/\.[^.]+$/, "");
}
