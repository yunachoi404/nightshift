import type { Gpu, HardwareProfile, Recipe, WorkflowRef } from "@nightshift/contract";

export function hw(gpu: Partial<Gpu> | null, ramGb: number, extra: Partial<HardwareProfile> = {}): HardwareProfile {
  const gpus: Gpu[] = gpu ? [{ vendor: "nvidia", name: "GPU", vramGb: 0, unifiedMemory: false, ...gpu }] : [];
  return { os: "linux", arch: "x64", cpu: "cpu", ramGb, gpus, freeDiskGb: 500, source: "manual", ...extra };
}

const ref = (workflow = "tests/echo_image.api.json"): WorkflowRef => ({ workflow, inputs: { image: { node: "1", field: "image" } }, params: {}, outputNodes: ["3"] });

export function recipe(tier: string, match: Recipe["match"], extra: Partial<Recipe> = {}): Recipe {
  return {
    tier,
    label: tier,
    match,
    models: [],
    launch: { args: [], env: {} },
    steps: { still: ref() },
    estimates: {},
    ...extra,
  };
}

/** A tier lineup shaped like the plan's table. */
export const LINEUP: Recipe[] = [
  recipe("unified-96-cuda", { vendor: "nvidia", unifiedMemory: true, minVramGb: 90, minRamGb: 90 }),
  recipe("nvidia-32", { vendor: "nvidia", unifiedMemory: false, minVramGb: 32, minRamGb: 32 }),
  recipe("nvidia-24-offload", { vendor: "nvidia", unifiedMemory: false, minVramGb: 24, minRamGb: 64 }),
  recipe("nvidia-12-offload", { vendor: "nvidia", unifiedMemory: false, minVramGb: 12, maxVramGb: 16, minRamGb: 64 }),
  recipe("nvidia-8", { vendor: "nvidia", unifiedMemory: false, minVramGb: 8, maxVramGb: 16, minRamGb: 16 }),
  recipe("apple-64", { vendor: "apple", minVramGb: 64, minRamGb: 64 }),
  recipe("apple-16", { vendor: "apple", minVramGb: 16, maxVramGb: 48, minRamGb: 16 }),
];
