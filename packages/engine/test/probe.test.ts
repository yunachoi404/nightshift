import { HardwareProfileSchema } from "@nightshift/contract";
import { mkdtempSync, readFileSync, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseLscpuModel,
  parseMacDisplays,
  parseMeminfoTotal,
  parseNvidiaSmi,
  parseRocmSmi,
  parseSizeGb,
  parseWindowsVideoControllers,
  vendorFromName,
} from "../src/hardware/parse.js";
import { detectHardware, freeDiskGb, type ProbeEnv } from "../src/hardware/probe.js";
import { execCapture } from "../src/util.js";
import type { ExecResult } from "../src/util.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/probe/${name}`, import.meta.url), "utf8");

describe("nvidia-smi", () => {
  it("treats [N/A] memory as unified memory (DGX Spark GB10) and uses system RAM", () => {
    expect(parseNvidiaSmi(fixture("nvidia-smi-gb10.csv"), 121.7)).toEqual([
      { vendor: "nvidia", name: "NVIDIA GB10", vramGb: 121.7, unifiedMemory: true, computeCapability: "12.1" },
    ]);
  });

  it("reads discrete cards in GiB", () => {
    const gpus = parseNvidiaSmi(fixture("nvidia-smi-4090-3060.csv"), 64);
    expect(gpus.map((g) => [g.name, g.vramGb, g.unifiedMemory, g.computeCapability])).toEqual([
      ["NVIDIA GeForce RTX 4090", 24, false, "8.9"],
      ["NVIDIA GeForce RTX 3060", 12, false, "8.6"],
    ]);
  });

  it("ignores blank lines and a header row", () => {
    expect(parseNvidiaSmi("name, memory.total [MiB], compute_cap\n\n", 32)).toEqual([]);
  });
});

describe("macOS system_profiler", () => {
  it("Apple Silicon shares all of RAM", () => {
    expect(parseMacDisplays(fixture("mac-m4max.json"), 128)).toEqual([{ vendor: "apple", name: "Apple M4 Max", vramGb: 128, unifiedMemory: true }]);
  });

  it("Intel Mac with an AMD card: dedicated VRAM, shared Intel graphics", () => {
    expect(parseMacDisplays(fixture("mac-intel-amd.json"), 32)).toEqual([
      { vendor: "intel", name: "Intel UHD Graphics 630", vramGb: 1.5, unifiedMemory: true },
      { vendor: "amd", name: "AMD Radeon Pro 5500M", vramGb: 8, unifiedMemory: false },
    ]);
  });

  it("returns nothing for garbage", () => {
    expect(parseMacDisplays("not json", 8)).toEqual([]);
  });
});

describe("small parsers", () => {
  it("meminfo, lscpu, sizes, vendors", () => {
    expect(parseMeminfoTotal(fixture("meminfo-spark.txt"))).toBe(127601388 * 1024);
    expect(parseLscpuModel(fixture("lscpu-spark.txt"))).toBe("Cortex-X925");
    expect(parseSizeGb("1536 MB")).toBe(1.5);
    expect(parseSizeGb("24 GB")).toBe(24);
    expect(parseSizeGb(undefined)).toBeUndefined();
    expect(vendorFromName("NVIDIA GeForce RTX 5090")).toBe("nvidia");
    expect(vendorFromName("AMD Radeon RX 7900 XTX")).toBe("amd");
    expect(vendorFromName("Intel(R) Arc(TM) A770")).toBe("intel");
    expect(vendorFromName("Microsoft Basic Display Adapter")).toBe("none");
  });

  it("rocm-smi json", () => {
    const json = JSON.stringify({ card0: { "Card Series": "Radeon RX 7900 XTX", "VRAM Total Memory (B)": String(24 * 1024 ** 3) }, system: {} });
    expect(parseRocmSmi(json)).toEqual([{ vendor: "amd", name: "Radeon RX 7900 XTX", vramGb: 24, unifiedMemory: false }]);
  });

  it("Windows WMI, single object or array", () => {
    expect(parseWindowsVideoControllers(JSON.stringify({ Name: "AMD Radeon RX 6800", AdapterRAM: 4293918720 }))).toEqual([
      { vendor: "amd", name: "AMD Radeon RX 6800", vramGb: 4, unifiedMemory: false },
    ]);
    expect(parseWindowsVideoControllers(JSON.stringify([{ Name: "Microsoft Basic Display Adapter", AdapterRAM: 0 }]))).toEqual([]);
  });
});

function fakeEnv(platform: NodeJS.Platform, outputs: Record<string, string>, files: Record<string, string> = {}, totalmemGb = 16): ProbeEnv {
  return {
    platform,
    arch: platform === "darwin" ? "arm64" : "x64",
    totalmemBytes: totalmemGb * 1024 ** 3,
    cpuModel: "fallback cpu",
    exec: async (cmd, args): Promise<ExecResult> => {
      const key = [cmd, ...args].join(" ");
      const hit = Object.entries(outputs).find(([k]) => key.startsWith(k));
      return hit ? { stdout: hit[1], stderr: "", code: 0 } : { stdout: "", stderr: "not found", code: 127 };
    },
    readText: async (path) => files[path],
    freeDiskGb: async () => 512,
  };
}

describe("detectHardware", () => {
  it("M4 Max MacBook", async () => {
    const hw = await detectHardware(
      "/tmp",
      fakeEnv("darwin", {
        "sysctl -n machdep.cpu.brand_string": "Apple M4 Max\n",
        "sysctl -n hw.memsize": `${128 * 1024 ** 3}\n`,
        "system_profiler SPDisplaysDataType -json": fixture("mac-m4max.json"),
      }),
    );
    expect(HardwareProfileSchema.parse(hw)).toEqual(hw);
    expect(hw).toMatchObject({ os: "macos", cpu: "Apple M4 Max", ramGb: 128, freeDiskGb: 512, source: "detected" });
    expect(hw.gpus[0]).toMatchObject({ vendor: "apple", vramGb: 128, unifiedMemory: true });
  });

  it("DGX Spark: nvidia-smi says N/A, so VRAM is MemTotal", async () => {
    const hw = await detectHardware(
      "/tmp",
      fakeEnv("linux", { "nvidia-smi": fixture("nvidia-smi-gb10.csv"), lscpu: fixture("lscpu-spark.txt") }, { "/proc/meminfo": fixture("meminfo-spark.txt") }),
    );
    expect(hw).toMatchObject({ os: "linux", cpu: "Cortex-X925", ramGb: 121.7 });
    expect(hw.gpus).toEqual([{ vendor: "nvidia", name: "NVIDIA GB10", vramGb: 121.7, unifiedMemory: true, computeCapability: "12.1" }]);
  });

  it("Linux with no GPU tools reports no GPUs and the fallback CPU", async () => {
    const hw = await detectHardware("/tmp", fakeEnv("linux", {}, {}, 32));
    expect(hw).toMatchObject({ gpus: [], ramGb: 32, cpu: "fallback cpu" });
  });

  it("Windows: nvidia-smi wins for NVIDIA, WMI fills in others", async () => {
    const hw = await detectHardware(
      "C:\\data",
      fakeEnv(
        "win32",
        {
          "nvidia-smi": "NVIDIA GeForce RTX 4070 Ti, 12282, 8.9\n",
          powershell: JSON.stringify([
            { Name: "NVIDIA GeForce RTX 4070 Ti", AdapterRAM: 4293918720 },
            { Name: "Intel(R) UHD Graphics 770", AdapterRAM: 1073741824 },
          ]),
        },
        {},
        64,
      ),
    );
    expect(hw.os).toBe("windows");
    expect(hw.gpus.map((g) => [g.vendor, g.vramGb])).toEqual([
      ["nvidia", 12],
      ["intel", 1],
    ]);
  });
});

describe("free disk", () => {
  // Model sizes are GB of 10^9 bytes. Free disk in GiB, without the space macOS frees on demand, put a Mac with 87 GB
  // available in Finder at 72 and refused a 63 GB setup that fit.
  it("is in GB, like the model sizes, and on macOS counts what Finder counts as available", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-disk-"));
    const s = statfsSync(dir);
    const statfsGb = (s.bavail * s.bsize) / 1e9;
    const free = await freeDiskGb(dir);
    expect(free).toBeGreaterThanOrEqual(Math.floor(statfsGb * 10) / 10 - 1);
    if (process.platform !== "darwin") {
      expect(free).toBeLessThanOrEqual(statfsGb + 1);
      return;
    }
    const finder = await execCapture("/usr/bin/osascript", ["-l", "JavaScript", "-e", 'ObjC.import("Foundation"); function run(a) { const v = Ref(); $.NSURL.fileURLWithPath(a[0]).getResourceValueForKeyError(v, $.NSURLVolumeAvailableCapacityForImportantUsageKey, null); return String(ObjC.unwrap(v[0])); }', dir]);
    expect(free).toBeCloseTo(Math.max(statfsGb, Number(finder.stdout) / 1e9), -0.5);
  });
});
