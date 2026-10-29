/**
 * Other programs on the graphics card ComfyUI renders on (RuntimeStatus.otherGpuUse). One holding a few GB of an 8 GB
 * card pushes the models out of VRAM, and renders run several times slower with nothing on screen to say why. nvidia-smi
 * names the programs and what each holds, so local mode on an NVIDIA card looks while a GPU job runs.
 *
 * Not looked at: unified memory (Apple Silicon, DGX Spark), where nothing spills out of VRAM; attach and remote mode,
 * where neither the Comfy SDK nor the proxy says anything about the GPU. The remote ComfyUI's /system_stats only has
 * PyTorch's own figure, which misses what dynamic VRAM holds, so "the rest" would count our own models as another
 * program's.
 */
import type { HardwareProfile, OtherGpuUse } from "@nightshift/contract";
import { primaryGpu } from "../hardware/probe.js";
import { execCapture, round1, type ExecResult } from "../util.js";

/** Other programs holding less than this together are left alone: a desktop, a browser's tabs. */
export const OTHER_GPU_MIN_GB = 1;
/** How often to look while a GPU job runs, ms. */
export const GPU_WATCH_MS = 15_000;

/** Only a card with VRAM of its own can be crowded by another program, and only nvidia-smi names them. */
export function watchesOtherGpuUse(hw: HardwareProfile): boolean {
  const gpu = primaryGpu(hw);
  return hw.os !== "macos" && gpu.vendor === "nvidia" && !gpu.unifiedMemory;
}

export interface ComputeApp {
  pid: number;
  /** The card's UUID: on a machine with several, only the one ComfyUI uses counts. */
  gpu: string;
  /** As nvidia-smi says it: a path, a bare name, or "[Not Found]" for a process it cannot see into. */
  name: string;
  usedMb: number;
}

export const COMPUTE_APPS_QUERY = ["--query-compute-apps=pid,gpu_uuid,process_name,used_memory", "--format=csv,noheader,nounits"];

/**
 * `nvidia-smi --query-compute-apps=pid,gpu_uuid,process_name,used_memory --format=csv,noheader,nounits`. A row without a
 * number for its memory is left out: Windows' WDDM driver says "[N/A]" there.
 */
export function parseComputeApps(csv: string): ComputeApp[] {
  const apps: ComputeApp[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const cols = line.split(",").map((s) => s.trim());
    if (cols.length < 4) continue;
    const pid = Number(cols[0]);
    const usedMb = Number(cols.at(-1));
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(usedMb)) continue;
    // A path may hold commas; the columns around it do not.
    apps.push({ pid, gpu: cols[1]!, name: cols.slice(2, -1).join(","), usedMb });
  }
  return apps;
}

/** "/usr/bin/python3" -> "python3", "C:\Program Files\Blender\blender.exe" -> "blender", "[Not Found]" -> "". */
export function appName(processName: string): string {
  if (/^\[.*\]$/.test(processName.trim())) return "";
  return (processName.split(/[\\/]/).pop() ?? "").replace(/\.exe$/i, "").trim();
}

/**
 * What programs other than ComfyUI (`pid`) hold on the card ComfyUI runs on, or null when it is less than 1 GB together.
 * Null too when ComfyUI is not in the list: then the process ids are not ones the engine can match (a container, WSL),
 * and its own ComfyUI would pass for another program.
 */
export function otherGpuUse(apps: ComputeApp[], pid: number): OtherGpuUse | null {
  const ours = new Set(apps.filter((a) => a.pid === pid).map((a) => a.gpu));
  if (ours.size === 0) return null;
  const others = apps.filter((a) => a.pid !== pid && ours.has(a.gpu)).sort((a, b) => b.usedMb - a.usedMb);
  const usedGb = round1(others.reduce((sum, a) => sum + a.usedMb, 0) / 1024);
  if (usedGb < OTHER_GPU_MIN_GB) return null;
  return { usedGb, apps: [...new Set(others.map((a) => appName(a.name)).filter(Boolean))] };
}

/** Worth an event: it came or went, the programs changed, or what they hold moved by half a GB or more. */
export function otherGpuUseChanged(before: OtherGpuUse | undefined, after: OtherGpuUse | null): boolean {
  if (!before || !after) return !before !== !after;
  return before.apps.join("\n") !== after.apps.join("\n") || Math.abs(before.usedGb - after.usedGb) >= 0.5;
}

/** nvidia-smi's compute apps, or null when it is missing or fails. */
export async function readComputeApps(exec: (cmd: string, args: string[]) => Promise<ExecResult> = (cmd, args) => execCapture(cmd, args, { timeoutMs: 10_000 })): Promise<ComputeApp[] | null> {
  const { code, stdout } = await exec("nvidia-smi", COMPUTE_APPS_QUERY);
  return code === 0 ? parseComputeApps(stdout) : null;
}

/**
 * NIGHTSHIFT_MOCK_OTHER_GPU for mock mode, "python:3.5" or "python:2.1,blender:1.4" (name:GB): the programs mock mode
 * reports beside its make-believe ComfyUI while a GPU job runs, under the same 1 GB rule. Null when unset or malformed.
 */
export function mockOtherGpu(spec: string | undefined): (() => OtherGpuUse | null) | null {
  const apps: ComputeApp[] = [{ pid: 1, gpu: "mock", name: "ComfyUI", usedMb: 6144 }];
  for (const part of (spec ?? "").split(",")) {
    const m = /^\s*([^:]+?)\s*:\s*([\d.]+)\s*$/.exec(part);
    if (m) apps.push({ pid: apps.length + 1, gpu: "mock", name: m[1]!, usedMb: Number(m[2]) * 1024 });
  }
  return apps.length > 1 ? () => otherGpuUse(apps, 1) : null;
}
