import type { HardwareProfile } from "@nightshift/contract";

/** Machines the mock can pretend to be. Picked from the dev panel or `?mock=hw:<key>`. */
export const hardwarePresets: Record<string, { label: string; profile: HardwareProfile }> = {
  spark: {
    label: "DGX Spark (GB10, 128 GB unified)",
    profile: {
      os: "linux",
      arch: "aarch64",
      cpu: "NVIDIA Grace, 20 cores",
      ramGb: 128,
      gpus: [{ vendor: "nvidia", name: "NVIDIA GB10", vramGb: 128, computeCapability: "12.1", unifiedMemory: true }],
      freeDiskGb: 186,
      source: "detected",
    },
  },
  rtx2080: {
    label: "PC, RTX 2080 Super 8 GB, 30 GB RAM",
    profile: {
      os: "linux",
      arch: "x64",
      cpu: "Intel Core i7-7700, 4 cores",
      ramGb: 30,
      gpus: [{ vendor: "nvidia", name: "NVIDIA GeForce RTX 2080 SUPER", vramGb: 8, computeCapability: "7.5", unifiedMemory: false }],
      freeDiskGb: 214,
      source: "detected",
    },
  },
  m4max: {
    label: "MacBook Pro, M4 Max 128 GB",
    profile: {
      os: "macos",
      arch: "arm64",
      cpu: "Apple M4 Max, 16 cores",
      ramGb: 128,
      gpus: [{ vendor: "apple", name: "Apple M4 Max, 40 core GPU", vramGb: 128, unifiedMemory: true }],
      freeDiskGb: 412,
      source: "detected",
    },
  },
  rtx5090: {
    label: "Desktop, RTX 5090 32 GB, 64 GB RAM",
    profile: {
      os: "windows",
      arch: "x64",
      cpu: "AMD Ryzen 9 9950X, 16 cores",
      ramGb: 64,
      gpus: [{ vendor: "nvidia", name: "NVIDIA GeForce RTX 5090", vramGb: 32, computeCapability: "12.0", unifiedMemory: false }],
      freeDiskGb: 910,
      source: "detected",
    },
  },
  rtx4090: {
    label: "Desktop, RTX 4090 24 GB, 64 GB RAM",
    profile: {
      os: "windows",
      arch: "x64",
      cpu: "Intel Core i9-13900K, 24 cores",
      ramGb: 64,
      gpus: [{ vendor: "nvidia", name: "NVIDIA GeForce RTX 4090", vramGb: 24, computeCapability: "8.9", unifiedMemory: false }],
      freeDiskGb: 240,
      source: "detected",
    },
  },
  rtx4070ti: {
    label: "Desktop, RTX 4070 Ti 12 GB, 64 GB RAM",
    profile: {
      os: "windows",
      arch: "x64",
      cpu: "AMD Ryzen 7 7800X3D, 8 cores",
      ramGb: 64,
      gpus: [{ vendor: "nvidia", name: "NVIDIA GeForce RTX 4070 Ti", vramGb: 12, computeCapability: "8.9", unifiedMemory: false }],
      freeDiskGb: 170,
      source: "detected",
    },
  },
  rtx3060: {
    label: "Laptop, RTX 3060 12 GB, 16 GB RAM",
    profile: {
      os: "windows",
      arch: "x64",
      cpu: "Intel Core i7-11800H, 8 cores",
      ramGb: 16,
      gpus: [{ vendor: "nvidia", name: "NVIDIA GeForce RTX 3060 Laptop", vramGb: 12, computeCapability: "8.6", unifiedMemory: false }],
      freeDiskGb: 88,
      source: "detected",
    },
  },
  air16: {
    label: "MacBook Air, M2 16 GB",
    profile: {
      os: "macos",
      arch: "arm64",
      cpu: "Apple M2, 8 cores",
      ramGb: 16,
      gpus: [{ vendor: "apple", name: "Apple M2, 10 core GPU", vramGb: 16, unifiedMemory: true }],
      freeDiskGb: 61,
      source: "detected",
    },
  },
  lowdisk: {
    label: "M4 Max with 30 GB free disk",
    profile: {
      os: "macos",
      arch: "arm64",
      cpu: "Apple M4 Max, 16 cores",
      ramGb: 128,
      gpus: [{ vendor: "apple", name: "Apple M4 Max, 40 core GPU", vramGb: 128, unifiedMemory: true }],
      freeDiskGb: 30,
      source: "detected",
    },
  },
  nogpu: {
    label: "Office laptop, no usable GPU",
    profile: {
      os: "windows",
      arch: "x64",
      cpu: "Intel Core i5-1235U, 10 cores",
      ramGb: 16,
      gpus: [{ vendor: "intel", name: "Intel Iris Xe", vramGb: 0, unifiedMemory: true }],
      freeDiskGb: 120,
      source: "detected",
    },
  },
};

export { mockTier, mockTiers, rankTiers, recommendTier, type MockTier } from "./recipes";
