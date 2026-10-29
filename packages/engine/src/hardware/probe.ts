import { HardwareProfileSchema, type Gpu, type HardwareProfile } from "@nightshift/contract";
import { mkdir, readFile, statfs } from "node:fs/promises";
import os from "node:os";
import { execCapture, round1, type ExecResult } from "../util.js";
import {
  parseLscpuModel,
  parseMacDisplays,
  parseMeminfoTotal,
  parseNvidiaSmi,
  parseRocmSmi,
  parseWindowsVideoControllers,
  sortGpus,
} from "./parse.js";

/** Everything the probe reads from the machine, injectable for tests. */
export interface ProbeEnv {
  platform: NodeJS.Platform;
  arch: string;
  totalmemBytes: number;
  cpuModel: string;
  exec(cmd: string, args: string[]): Promise<ExecResult>;
  readText(path: string): Promise<string | undefined>;
  freeDiskGb(path: string): Promise<number>;
}

export function systemProbeEnv(): ProbeEnv {
  return {
    platform: process.platform,
    arch: os.arch(),
    totalmemBytes: os.totalmem(),
    cpuModel: os.cpus()[0]?.model?.trim() ?? "unknown",
    exec: (cmd, args) => execCapture(cmd, args, { timeoutMs: 20_000 }),
    readText: async (path) => readFile(path, "utf8").catch(() => undefined),
    freeDiskGb,
  };
}

/**
 * Free disk where the data lives, in GB of 10^9 bytes, the unit of the recipes' model sizes and of Finder. On macOS it
 * counts what Finder counts: space the system frees on demand for a download the user asked for (purgeable caches,
 * local snapshots). statfs alone put a Mac that Finder said had 87 GB available at 72, in GiB, and refused a 63 GB
 * setup that fit.
 */
export async function freeDiskGb(path: string): Promise<number> {
  await mkdir(path, { recursive: true });
  const s = await statfs(path);
  const free = Number(s.bavail) * Number(s.bsize);
  const available = process.platform === "darwin" ? await macAvailableBytes(path) : undefined;
  return round1(Math.max(free, available ?? 0) / 1e9);
}

/** NSURLVolumeAvailableCapacityForImportantUsageKey, through osascript (on every Mac, no developer tools needed). */
const MAC_AVAILABLE_JXA = `ObjC.import("Foundation");
function run(argv) {
  const v = Ref();
  $.NSURL.fileURLWithPath(argv[0]).getResourceValueForKeyError(v, $.NSURLVolumeAvailableCapacityForImportantUsageKey, null);
  return String(ObjC.unwrap(v[0]));
}`;

async function macAvailableBytes(path: string): Promise<number | undefined> {
  const r = await execCapture("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_AVAILABLE_JXA, path], { timeoutMs: 5_000 });
  const bytes = Number(r.stdout.trim());
  return r.code === 0 && Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
}

const NVIDIA_QUERY = ["--query-gpu=name,memory.total,compute_cap", "--format=csv,noheader,nounits"];

/** Detects GPU, VRAM, RAM, CPU, OS and free disk. Runs before anything is installed; never throws on a missing tool. */
export async function detectHardware(dataDir: string, env: ProbeEnv = systemProbeEnv()): Promise<HardwareProfile> {
  let ramBytes = env.totalmemBytes;
  let cpu = env.cpuModel;
  let gpus: Gpu[] = [];
  let osName: HardwareProfile["os"];

  if (env.platform === "darwin") {
    osName = "macos";
    const brand = await env.exec("sysctl", ["-n", "machdep.cpu.brand_string"]);
    if (brand.code === 0 && brand.stdout.trim()) cpu = brand.stdout.trim();
    const mem = await env.exec("sysctl", ["-n", "hw.memsize"]);
    if (mem.code === 0 && Number(mem.stdout.trim()) > 0) ramBytes = Number(mem.stdout.trim());
    const sp = await env.exec("system_profiler", ["SPDisplaysDataType", "-json"]);
    if (sp.code === 0) gpus = parseMacDisplays(sp.stdout, round1(ramBytes / 1024 ** 3));
  } else if (env.platform === "win32") {
    osName = "windows";
    const ramGb = round1(ramBytes / 1024 ** 3);
    const smi = await env.exec("nvidia-smi", NVIDIA_QUERY);
    if (smi.code === 0) gpus = parseNvidiaSmi(smi.stdout, ramGb);
    const ps = await env.exec("powershell", [
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json",
    ]);
    if (ps.code === 0) {
      // nvidia-smi is authoritative for NVIDIA cards; take everything else from WMI.
      const others = parseWindowsVideoControllers(ps.stdout).filter((g) => g.vendor !== "nvidia" || gpus.length === 0);
      gpus.push(...others);
    }
  } else {
    osName = "linux";
    const meminfo = await env.readText("/proc/meminfo");
    const memTotal = meminfo ? parseMeminfoTotal(meminfo) : undefined;
    if (memTotal) ramBytes = memTotal;
    const lscpu = await env.exec("lscpu", []);
    const model = lscpu.code === 0 ? parseLscpuModel(lscpu.stdout) : undefined;
    if (model) cpu = model;
    const ramGb = round1(ramBytes / 1024 ** 3);
    const smi = await env.exec("nvidia-smi", NVIDIA_QUERY);
    if (smi.code === 0) gpus = parseNvidiaSmi(smi.stdout, ramGb);
    if (gpus.length === 0) {
      const rocm = await env.exec("rocm-smi", ["--showproductname", "--showmeminfo", "vram", "--json"]);
      if (rocm.code === 0) gpus = parseRocmSmi(rocm.stdout);
    }
  }

  const profile: HardwareProfile = {
    os: osName,
    arch: env.arch,
    cpu,
    ramGb: round1(ramBytes / 1024 ** 3),
    gpus: sortGpus(gpus),
    freeDiskGb: await env.freeDiskGb(dataDir).catch(() => 0),
    source: "detected",
  };
  return HardwareProfileSchema.parse(profile);
}

/** The GPU recipes are matched against: the best one, or a "none" stand-in on CPU-only machines. */
export function primaryGpu(hw: HardwareProfile): Gpu {
  return hw.gpus[0] ?? { vendor: "none", name: "CPU only", vramGb: 0, unifiedMemory: false };
}
