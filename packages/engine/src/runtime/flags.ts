/**
 * Turns the user's memory limit into ComfyUI launch flags (ComfyUI v0.41.3).
 *
 * In v0.41.3 dynamic VRAM is on by default, so ComfyUI already streams weights that do not fit, and
 * `--lowvram` does nothing. The levers that matter:
 * - `--reserve-vram GB`: memory ComfyUI must leave to the OS and other apps. On unified-memory machines
 *   (Apple Silicon, DGX Spark) ComfyUI's "VRAM" is all of RAM, so this is the main cap.
 * - `--cache-ram GB`: RAM-pressure caching. ComfyUI drops cached models when free RAM falls below GB.
 * - On macOS the MPS allocator is capped by PYTORCH_MPS_HIGH_WATERMARK_RATIO, a fraction of Metal's
 *   recommended working set (about 75% of RAM on 36 GB+ Macs, about 66% below). The low watermark must
 *   not exceed the high one or PyTorch refuses to start, so both are set.
 *
 * The limit is system memory on every machine, which is what the UI's slider sends. On unified-memory
 * machines that is the whole pool, so it caps everything. Next to a discrete card it caps RAM (offloaded
 * weights, the model cache) and the card itself is used in full: other apps rarely compete for it, and
 * ComfyUI's dynamic VRAM already keeps it from overflowing.
 *
 * The recipe's own flags come first and win where they choose: `--cache-ram` is one of ComfyUI's cache modes,
 * which exclude each other, so a recipe that picks another (`--cache-none` on the Spark tier) gets no cache flag.
 * A recipe's MPS high watermark is the most the limit may allow (the Apple recipes stop at Metal's working set).
 */
import type { HardwareProfile, Recipe } from "@nightshift/contract";
import { primaryGpu } from "../hardware/probe.js";
import { round1 } from "../util.js";

export interface LaunchPlan {
  args: string[];
  env: Record<string, string>;
  /** Plain-words summary for logs and the UI. */
  notes: string[];
}

/** ComfyUI's own minimum sensible cache headroom. */
const MIN_CACHE_HEADROOM_GB = 2;

/** ComfyUI's cache modes: one mutually exclusive argparse group, so only one of them may be passed. */
const CACHE_MODES = ["--cache-ram", "--cache-classic", "--cache-lru", "--cache-none", "--high-ram"];

/** PyTorch's default low watermark on unified memory. It must not exceed the high one, or MPS refuses to start. */
const MPS_DEFAULT_LOW_WATERMARK = 1.4;

export function launchPlan(recipe: Recipe, hw: HardwareProfile, memoryLimitGb: number | null): LaunchPlan {
  const args = [...recipe.launch.args];
  const env: Record<string, string> = { ...recipe.launch.env };
  const notes: string[] = [];
  const fmt = (n: number) => String(round1(n));
  // A recipe that chose its own cache mode keeps it: the memory limit then caps memory without a cache flag.
  const recipeCache = CACHE_MODES.find((flag) => flag !== "--cache-ram" && args.includes(flag));
  const cacheRam = (gb: number) => {
    if (!recipeCache) setFlag(args, "--cache-ram", [fmt(Math.max(MIN_CACHE_HEADROOM_GB, gb))]);
  };

  if (memoryLimitGb === null) {
    notes.push("No memory limit: recipe defaults.");
  } else {
    const gpu = primaryGpu(hw);
    const limit = Math.max(1, memoryLimitGb);
    if (gpu.unifiedMemory || gpu.vendor === "apple" || gpu.vendor === "none") {
      const pool = hw.ramGb;
      const keepFree = round1(Math.max(0, pool - limit));
      if (keepFree > 0) {
        setFlag(args, "--reserve-vram", [fmt(keepFree)]);
        cacheRam(keepFree);
        notes.push(`Use at most ${fmt(limit)} GB of ${fmt(pool)} GB shared memory, keep ${fmt(keepFree)} GB free.`);
      } else {
        notes.push(`Limit ${fmt(limit)} GB is at or above the ${fmt(pool)} GB of memory: no cap needed.`);
      }
      if (gpu.vendor === "apple" && keepFree > 0) {
        const workingSet = pool * (pool >= 36 ? 0.75 : 0.66);
        const recipeHigh = Number(recipe.launch.env.PYTORCH_MPS_HIGH_WATERMARK_RATIO);
        const high = clamp(limit / workingSet, 0.1, recipeHigh > 0 ? Math.min(1.7, recipeHigh) : 1.7);
        env.PYTORCH_MPS_HIGH_WATERMARK_RATIO = high.toFixed(2);
        env.PYTORCH_MPS_LOW_WATERMARK_RATIO = (high * 0.8).toFixed(2);
        notes.push(`MPS allocator capped at ${high.toFixed(2)} of the Metal working set.`);
      }
    } else {
      const ramFree = round1(Math.max(0, hw.ramGb - limit));
      if (ramFree > 0) {
        cacheRam(ramFree);
        notes.push(`Use at most ${fmt(limit)} of ${fmt(hw.ramGb)} GB system RAM, keep ${fmt(ramFree)} GB free. The ${fmt(gpu.vramGb)} GB card is used in full.`);
      } else {
        notes.push(`Limit ${fmt(limit)} GB is at or above the ${fmt(hw.ramGb)} GB of system RAM: no cap needed.`);
      }
    }
  }
  if (recipeCache) notes.push(`The recipe sets ${recipeCache}, so ComfyUI keeps no cache to limit.`);
  fixMpsWatermarks(env);
  return { args, env, notes };
}

/** A high watermark alone (the recipe's "1.0") is below PyTorch's default low one: bring the low one under it. */
function fixMpsWatermarks(env: Record<string, string>): void {
  const high = Number(env.PYTORCH_MPS_HIGH_WATERMARK_RATIO);
  if (env.PYTORCH_MPS_HIGH_WATERMARK_RATIO === undefined || !Number.isFinite(high)) return;
  const low = env.PYTORCH_MPS_LOW_WATERMARK_RATIO === undefined ? MPS_DEFAULT_LOW_WATERMARK : Number(env.PYTORCH_MPS_LOW_WATERMARK_RATIO);
  // A high watermark of 0 turns the limit off, and then any low one is allowed.
  if (high > 0 && !(low <= high)) env.PYTORCH_MPS_LOW_WATERMARK_RATIO = (high * 0.8).toFixed(2);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Remove a flag and the numeric values that follow it. */
export function removeFlag(args: string[], flag: string): void {
  for (let i = args.indexOf(flag); i !== -1; i = args.indexOf(flag)) {
    let j = i + 1;
    while (j < args.length && /^-?\d+(\.\d+)?$/.test(args[j]!)) j++;
    args.splice(i, j - i);
  }
}

/** Replace a flag (and its values) so the memory limit wins over the recipe's own setting. */
export function setFlag(args: string[], flag: string, values: string[]): void {
  removeFlag(args, flag);
  args.push(flag, ...values);
}
