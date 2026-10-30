import type { TierSummary } from "@nightshift/contract";
import { describe, expect, it } from "vitest";
import { engineOnMac, isMac, machineName, tierFor } from "./tier";

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

  it("comes from the engine's own hardware when the work goes through a proxy, not from the browser", () => {
    // A judge's browser on a Mac, with the engine on a Linux box attached to its ComfyUI proxy.
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
    try {
      expect(engineOnMac("attach", "linux")).toBe(false);
      expect(engineOnMac("local", "linux")).toBe(false);
      expect(engineOnMac("attach", "macos")).toBe(true);
      // A GPU computer on the network: the hardware read is that computer's, so the browser decides.
      expect(engineOnMac("remote", "linux")).toBe(true);
    } finally {
      Object.defineProperty(navigator, "platform", { value: "", configurable: true });
    }
  });
});
