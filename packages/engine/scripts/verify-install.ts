/**
 * Proves a fresh local install. Installs the runtime for a tier the way the engine does (ComfyUI, the tier's node
 * packs with our fixes, comfy-api-proxy; no models), starts it the way the engine does, and checks that ComfyUI loaded
 * every node type the tier's workflows use. Exits non-zero when one is missing.
 *
 *   pnpm --filter @nightshift/engine verify-install -- --tier apple-16 --dir /tmp/ns-verify
 *   pnpm --filter @nightshift/engine verify-install -- --tier all --dir /tmp/ns-verify --write-fixture
 *
 * `--tier all` installs every pack any recipe pins and checks every recipe, launched with the flags of the tier this
 * machine would get (or `--launch <tier>`). `--write-fixture` saves which module each node type comes from as
 * test/fixtures/comfyui-node-modules.json, which the recipe tests read.
 */
import type { NodePack, Recipe } from "@nightshift/contract";
import { checkTools } from "@nightshift/editor";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EventBus } from "../src/events.js";
import { detectHardware } from "../src/hardware/probe.js";
import { COMFY_REF, installComfyUI } from "../src/install/comfyui.js";
import { missingNodeClasses, workflowNodeClasses } from "../src/install/nodes.js";
import { dataPaths, defaultNodesDir, defaultRecipesDir, defaultWorkflowsDir } from "../src/paths.js";
import { loadRecipes, recommendTier } from "../src/recipes.js";
import { LocalRuntime } from "../src/runtime/runtime.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const tierArg = arg("tier");
const dirArg = arg("dir");
if (!tierArg || !dirArg) throw new Error("usage: verify-install --tier <tier|all> --dir <folder> [--launch <tier>] [--write-fixture]");
const dir = resolve(dirArg);
const started = Date.now();
const say = (m: string) => console.log(`[${String(Math.round((Date.now() - started) / 1000)).padStart(4)} s] ${m}`);

const { recipes, problems } = await loadRecipes(defaultRecipesDir(), defaultWorkflowsDir());
if (problems.length) throw new Error(`recipe problems: ${JSON.stringify(problems)}`);
const byTier = (id: string) => recipes.find((r) => r.tier === id) ?? (() => { throw new Error(`no recipe ${id}`); })();
const checked = tierArg === "all" ? recipes : [byTier(tierArg)];
const hardware = await detectHardware(dir);
const launchTier = arg("launch") ?? (tierArg === "all" ? recommendTier(recipes, hardware)?.tier : tierArg) ?? checked[0]!.tier;
const packs = [...new Map(checked.flatMap((r) => r.customNodes ?? []).map((p): [string, NodePack] => [p.name, p])).values()];
// The tier ComfyUI starts as: its launch flags and steps, with every pack being checked.
const runAs: Recipe = { ...byTier(launchTier), customNodes: packs };
say(`checking ${checked.map((r) => r.tier).join(", ")}; node packs ${packs.map((p) => p.name).join(", ")}; launched as ${launchTier}`);

const paths = dataPaths(dir);
await installComfyUI({
  comfyDir: paths.comfy,
  proxyVenv: paths.proxyVenv,
  workDir: join(paths.work, "install"),
  nodesDir: defaultNodesDir(),
  recipe: runAs,
  hardware,
  log: () => undefined,
  onStep: say,
});
say("installed");

const runtime = new LocalRuntime(new EventBus(), {
  paths,
  recipe: () => runAs,
  hardware: async () => hardware,
  settings: () => ({ ...DEFAULT_SETTINGS, tier: launchTier, memoryLimitGb: null }),
  log: (m) => (/^(starting ComfyUI|ComfyUI .*ready|ComfyUI is missing|custom_nodes)/.test(m) ? say(m) : undefined),
  nodesDir: defaultNodesDir(),
  workflowsDir: defaultWorkflowsDir(),
  toolDirs: async () => {
    const ffmpeg = checkTools().ffmpeg;
    return ffmpeg ? [dirname(ffmpeg)] : [];
  },
});
let failed = false;
try {
  await runtime.start(launchTier);
  const url = runtime.comfyUiUrl();
  if (!url) throw new Error(`ComfyUI did not come up: ${JSON.stringify(runtime.status())}; see ${paths.logs}/comfyui.log`);
  const info = (await (await fetch(`${url}/object_info`)).json()) as Record<string, { python_module?: string }>;
  for (const r of checked) {
    const missing = missingNodeClasses(await workflowNodeClasses(r, defaultWorkflowsDir()), Object.keys(info));
    say(`${r.tier}: ${missing ?? "every node type its workflows use is loaded"}`);
    if (missing) failed = true;
  }
  if (process.argv.includes("--write-fixture")) {
    const modules = Object.fromEntries(Object.keys(info).sort().map((cls) => [cls, info[cls]!.python_module ?? "?"]));
    const file = join(import.meta.dirname, "..", "test", "fixtures", "comfyui-node-modules.json");
    const fixture = { comfyui: COMFY_REF, packs: packs.map((p) => `${p.name}@${p.ref}`), madeBy: "pnpm --filter @nightshift/engine verify-install -- --tier all --write-fixture", modules };
    writeFileSync(file, JSON.stringify(fixture, null, 1) + "\n");
    say(`wrote ${Object.keys(modules).length} node types to ${file}`);
  }
} finally {
  await runtime.stop();
}
say(failed ? "FAILED: node types are missing" : "OK");
process.exit(failed ? 1 : 0);
