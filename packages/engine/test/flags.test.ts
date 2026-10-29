import type { Recipe } from "@nightshift/contract";
import { describe, expect, it } from "vitest";
import { defaultRecipesDir, defaultWorkflowsDir } from "../src/paths.js";
import { defaultMemoryLimitGb, loadRecipes } from "../src/recipes.js";
import { launchPlan, removeFlag } from "../src/runtime/flags.js";
import { hw, recipe } from "./helpers.js";

const spark = hw({ vendor: "nvidia", name: "NVIDIA GB10", vramGb: 121.7, unifiedMemory: true }, 121.7);
const mac = hw({ vendor: "apple", name: "Apple M4 Max", vramGb: 128, unifiedMemory: true }, 128, { os: "macos" });
const macAir = hw({ vendor: "apple", name: "Apple M3", vramGb: 16, unifiedMemory: true }, 16, { os: "macos" });
const rtx4090 = hw({ vramGb: 24 }, 64);
const base = recipe("t", { vendor: "nvidia", minVramGb: 0, minRamGb: 0 }, { launch: { args: ["--disable-pinned-memory", "--disable-cuda-malloc"], env: { FOO: "1" } } });

describe("memory limit -> ComfyUI flags", () => {
  it("no limit keeps the recipe's flags", () => {
    expect(launchPlan(base, spark, null)).toMatchObject({ args: ["--disable-pinned-memory", "--disable-cuda-malloc"], env: { FOO: "1" } });
  });

  it("unified CUDA (Spark): reserve the rest of the shared pool and keep that much RAM free", () => {
    const plan = launchPlan(base, spark, 96);
    expect(plan.args).toEqual(["--disable-pinned-memory", "--disable-cuda-malloc", "--reserve-vram", "25.7", "--cache-ram", "25.7"]);
    expect(plan.env).toEqual({ FOO: "1" });
  });

  it("Apple Silicon: reserve plus MPS watermarks, low never above high", () => {
    const plan = launchPlan(base, mac, 96);
    expect(plan.args).toContain("--reserve-vram");
    expect(plan.args.slice(-4)).toEqual(["--reserve-vram", "32", "--cache-ram", "32"]);
    // 96 GB of a 0.75 * 128 = 96 GB working set
    expect(plan.env.PYTORCH_MPS_HIGH_WATERMARK_RATIO).toBe("1.00");
    expect(plan.env.PYTORCH_MPS_LOW_WATERMARK_RATIO).toBe("0.80");
    const small = launchPlan(base, macAir, 8);
    // 8 GB of 0.66 * 16 = 10.56 GB
    expect(small.env.PYTORCH_MPS_HIGH_WATERMARK_RATIO).toBe("0.76");
    expect(Number(small.env.PYTORCH_MPS_LOW_WATERMARK_RATIO)).toBeLessThanOrEqual(Number(small.env.PYTORCH_MPS_HIGH_WATERMARK_RATIO));
  });

  it("a limit at or above total memory adds nothing", () => {
    expect(launchPlan(base, mac, 200).args).toEqual(base.launch.args);
    expect(launchPlan(base, mac, 200).env.PYTORCH_MPS_HIGH_WATERMARK_RATIO).toBeUndefined();
  });

  it("discrete NVIDIA: the limit is system memory; the card is used in full", () => {
    expect(launchPlan(base, rtx4090, 16).args.slice(2)).toEqual(["--cache-ram", "48"]);
    expect(launchPlan(base, rtx4090, 48).args.slice(2)).toEqual(["--cache-ram", "16"]);
    // Never below ComfyUI's own minimum headroom.
    expect(launchPlan(base, rtx4090, 63).args.slice(2)).toEqual(["--cache-ram", "2"]);
    expect(launchPlan(base, rtx4090, 64).args).toEqual(base.launch.args);
    for (const l of [2, 16, 48]) expect(launchPlan(base, rtx4090, l).args.join(" ")).not.toMatch(/reserve-vram|novram/);
  });

  it("the limit's flags replace the recipe's own values", () => {
    const r = recipe("t", { vendor: "nvidia", minVramGb: 0, minRamGb: 0 }, { launch: { args: ["--reserve-vram", "4", "--cache-ram", "8", "12", "--fast"], env: {} } });
    expect(launchPlan(r, spark, 100).args).toEqual(["--fast", "--reserve-vram", "21.7", "--cache-ram", "21.7"]);
  });

  it("removeFlag takes the flag's numeric values with it", () => {
    const args = ["--a", "--cache-ram", "2", "3.5", "--b", "x"];
    removeFlag(args, "--cache-ram");
    expect(args).toEqual(["--a", "--b", "x"]);
  });
});

describe("the recipe's own launch settings", () => {
  const cacheOff = recipe("t", { vendor: "nvidia", minVramGb: 0, minRamGb: 0 }, { launch: { args: ["--disable-pinned-memory", "--cache-none"], env: {} } });

  it("a recipe's cache mode stays, and the limit adds no --cache-ram beside it (ComfyUI refuses two cache modes)", () => {
    expect(launchPlan(cacheOff, spark, 96).args).toEqual(["--disable-pinned-memory", "--cache-none", "--reserve-vram", "25.7"]);
    expect(launchPlan(cacheOff, rtx4090, 16).args).toEqual(["--disable-pinned-memory", "--cache-none"]);
    expect(launchPlan(cacheOff, spark, 96).notes.join(" ")).toContain("--cache-none");
    const lru = recipe("t", { vendor: "nvidia", minVramGb: 0, minRamGb: 0 }, { launch: { args: ["--cache-lru", "8"], env: {} } });
    expect(launchPlan(lru, rtx4090, 16).args).toEqual(["--cache-lru", "8"]);
  });

  it("a high MPS watermark alone gets a low one under it: PyTorch's default low (1.4) above it stops MPS from starting", () => {
    const apple = (env: Record<string, string>) => recipe("a", { vendor: "apple", minVramGb: 0, minRamGb: 0 }, { launch: { args: [], env } });
    expect(launchPlan(apple({ PYTORCH_MPS_HIGH_WATERMARK_RATIO: "1.0" }), mac, null).env).toEqual({ PYTORCH_MPS_HIGH_WATERMARK_RATIO: "1.0", PYTORCH_MPS_LOW_WATERMARK_RATIO: "0.80" });
    expect(launchPlan(apple({ PYTORCH_MPS_HIGH_WATERMARK_RATIO: "1.0", PYTORCH_MPS_LOW_WATERMARK_RATIO: "1.2" }), mac, null).env.PYTORCH_MPS_LOW_WATERMARK_RATIO).toBe("0.80");
    expect(launchPlan(apple({ PYTORCH_MPS_HIGH_WATERMARK_RATIO: "1.0", PYTORCH_MPS_LOW_WATERMARK_RATIO: "0.5" }), mac, null).env.PYTORCH_MPS_LOW_WATERMARK_RATIO).toBe("0.5");
    // 0 turns the limit off; then any low watermark is fine.
    expect(launchPlan(apple({ PYTORCH_MPS_HIGH_WATERMARK_RATIO: "0" }), mac, null).env).toEqual({ PYTORCH_MPS_HIGH_WATERMARK_RATIO: "0" });
    expect(launchPlan(apple({}), mac, null).env).toEqual({});
  });

  it("the recipe's MPS high watermark is the most the memory limit may allow", () => {
    const capped = recipe("a", { vendor: "apple", minVramGb: 0, minRamGb: 0 }, { launch: { args: [], env: { PYTORCH_MPS_HIGH_WATERMARK_RATIO: "1.0" } } });
    // 13 of 16 GB would be 1.23 of the 10.56 GB working set; the recipe stops at 1.0.
    expect(launchPlan(capped, macAir, 13).env).toEqual({ PYTORCH_MPS_HIGH_WATERMARK_RATIO: "1.00", PYTORCH_MPS_LOW_WATERMARK_RATIO: "0.80" });
    // A tighter limit still tightens it.
    expect(launchPlan(capped, macAir, 8).env.PYTORCH_MPS_HIGH_WATERMARK_RATIO).toBe("0.76");
  });
});

/** A machine each shipped tier is meant for. */
const MACHINES: Record<string, ReturnType<typeof hw>> = {
  "unified-128-cuda": spark,
  "apple-64": hw({ vendor: "apple", vramGb: 64, unifiedMemory: true }, 64, { os: "macos" }),
  "apple-16": macAir,
  "nvidia-32": hw({ vramGb: 31.8 }, 64),
  "nvidia-24-offload": rtx4090,
  "nvidia-12-offload": hw({ vramGb: 16 }, 64),
  "nvidia-8": hw({ vramGb: 8 }, 16),
};

const shipped = await loadRecipes(defaultRecipesDir(), defaultWorkflowsDir());
const tier = (id: string): Recipe => shipped.recipes.find((r) => r.tier === id)!;
const CACHE_MODES = ["--cache-ram", "--cache-classic", "--cache-lru", "--cache-none", "--high-ram"];

describe("the shipped recipes' launch flags", () => {
  it("every tier launches with the settings the model lab measured, with no limit and at the slider's default", () => {
    const at = (id: string, limit: "none" | "default") => {
      const r = tier(id);
      const machine = MACHINES[id]!;
      return launchPlan(r, machine, limit === "none" ? null : defaultMemoryLimitGb(r, machine));
    };
    // The Spark tier: serve.sh's memory flags. A user's own machine keeps models warm, so the limit adds --cache-ram
    // (our shared Spark keeps --cache-none in scripts/spark/serve.sh instead).
    expect(at("unified-128-cuda", "none").args).toEqual(["--disable-pinned-memory", "--disable-cuda-malloc"]);
    expect(at("unified-128-cuda", "default").args.slice(0, 4)).toEqual(["--disable-pinned-memory", "--disable-cuda-malloc", "--reserve-vram", "24.7"]);
    expect(at("unified-128-cuda", "default").args).toContain("--cache-ram");
    // MOSS's GPTQ encoder crashed with Comfy's compiler on; these tiers turn it off. DynamicVRAM stays on (the default).
    expect(at("nvidia-8", "default").args).toEqual(["--lowvram", "--reserve-vram", "1", "--force-fp16", "--disable-pinned-memory", "--disable-comfy-compiler", "--cache-ram", "3"]);
    expect(at("apple-16", "default")).toMatchObject({
      args: ["--force-fp16", "--disable-pinned-memory", "--disable-comfy-compiler", "--reserve-vram", "3", "--cache-ram", "3"],
      env: { PYTORCH_MPS_HIGH_WATERMARK_RATIO: "1.00", PYTORCH_MPS_LOW_WATERMARK_RATIO: "0.80" },
    });
    expect(at("apple-64", "none").env).toEqual({ PYTORCH_MPS_HIGH_WATERMARK_RATIO: "1.0", PYTORCH_MPS_LOW_WATERMARK_RATIO: "0.8" });
    expect(at("apple-64", "default").args).toEqual(["--disable-pinned-memory", "--reserve-vram", "13", "--cache-ram", "13"]);
    expect(at("nvidia-12-offload", "default").args).toEqual(["--lowvram", "--reserve-vram", "2", "--disable-pinned-memory", "--cache-ram", "13"]);
    expect(at("nvidia-24-offload", "default").args).toEqual(["--lowvram", "--reserve-vram", "2", "--cache-ram", "13"]);
    expect(at("nvidia-32", "default").args).toEqual(["--lowvram", "--reserve-vram", "3", "--cache-ram", "13"]);
  });

  it("no tier and limit gives ComfyUI two cache modes, an MPS low watermark above the high one, or static loading", () => {
    expect(shipped.recipes.map((r) => r.tier).sort()).toEqual(Object.keys(MACHINES).sort());
    for (const r of shipped.recipes) {
      const machine = MACHINES[r.tier]!;
      for (const limit of [null, 4, defaultMemoryLimitGb(r, machine), machine.ramGb * 0.5, machine.ramGb + 8]) {
        const plan = launchPlan(r, machine, limit);
        const label = `${r.tier} at ${limit} GB`;
        expect(plan.args.filter((a) => CACHE_MODES.includes(a)).length, label).toBeLessThanOrEqual(1);
        for (const flag of r.launch.args.filter((a) => a.startsWith("--"))) expect(plan.args, label).toContain(flag);
        // MOSS stalled loading its VAE with static loading.
        expect(plan.args, label).not.toContain("--disable-dynamic-vram");
        const high = plan.env.PYTORCH_MPS_HIGH_WATERMARK_RATIO;
        if (high !== undefined) expect(Number(plan.env.PYTORCH_MPS_LOW_WATERMARK_RATIO), label).toBeLessThanOrEqual(Number(high));
      }
    }
  });
});
