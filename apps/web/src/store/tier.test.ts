import type { TierSummary } from "@nightshift/contract";
import { describe, expect, it } from "vitest";
import { isMac, machineName, tierFor } from "./tier";

const tier = (match: TierSummary["match"], label = "internal note; unverified"): TierSummary => ({ tier: "t", label, match, downloadGb: 10 }) as TierSummary;

describe("tierFor", () => {
  it("says what a setup is for in plain words, never the recipe's own note", () => {
    expect(tierFor(tier({ vendor: "apple", unifiedMemory: true, minVramGb: 16, minRamGb: 16, maxVramGb: 64 }, "Apple Silicon 16-32 GB, experimental estimate; quantized MPS unverified"))).toBe("Apple Silicon with 16 GB or more");
    expect(tierFor(tier({ vendor: "nvidia", unifiedMemory: false, minVramGb: 8, minRamGb: 16, maxVramGb: 24 }))).toBe("NVIDIA graphics with 8 GB or more");
    expect(tierFor(tier({ vendor: "nvidia", unifiedMemory: false, minVramGb: 12, minRamGb: 64, maxVramGb: 24 }))).toBe("NVIDIA graphics with 12 GB or more, and 64 GB of memory");
    expect(tierFor(tier({ vendor: "nvidia", unifiedMemory: true, minVramGb: 96, minRamGb: 96 }))).toBe("Machines like a DGX Spark, 96 GB or more of shared memory");
  });
});

describe("the machine's name", () => {
  it("is This Mac only on macOS", () => {
    expect(machineName(isMac("macos"))).toBe("This Mac");
    expect(machineName(isMac("linux"))).toBe("This computer");
    expect(machineName(isMac("windows"), true)).toBe("this computer");
    expect(machineName(true, true)).toBe("this Mac");
  });
});
