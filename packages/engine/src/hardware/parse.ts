/**
 * Pure parsers for the tools the hardware probe shells out to. Kept free of I/O so tests can feed them
 * real captured output (see test/fixtures/probe).
 */
import type { Gpu } from "@nightshift/contract";
import { round1 } from "../util.js";

type Vendor = Gpu["vendor"];

export function vendorFromName(name: string): Vendor {
  if (/nvidia|geforce|quadro|tesla|\brtx\b|\bgtx\b/i.test(name)) return "nvidia";
  if (/apple/i.test(name)) return "apple";
  if (/\bamd\b|radeon|\bati\b|instinct/i.test(name)) return "amd";
  if (/intel|\barc\b|iris|uhd graphics|hd graphics/i.test(name)) return "intel";
  return "none";
}

/**
 * `nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv,noheader,nounits`.
 * Unified-memory boxes (DGX Spark GB10, Jetson) report memory as "[N/A]": the GPU shares system RAM,
 * so its usable memory is the machine's RAM.
 */
export function parseNvidiaSmi(csv: string, ramGb: number): Gpu[] {
  const gpus: Gpu[] = [];
  for (const line of csv.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [name = "", mem = "", cc = ""] = line.split(",").map((s) => s.trim());
    if (!name || /^name$/i.test(name)) continue;
    const mib = Number(mem);
    const unified = !Number.isFinite(mib) || mib <= 0;
    const gpu: Gpu = { vendor: "nvidia", name, vramGb: unified ? ramGb : round1(mib / 1024), unifiedMemory: unified };
    if (/^\d+\.\d+$/.test(cc)) gpu.computeCapability = cc;
    gpus.push(gpu);
  }
  return gpus;
}

/** "8 GB", "1536 MB", "24 GB" -> GB. */
export function parseSizeGb(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const m = /([\d.]+)\s*(TB|GB|MB)/i.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2]!.toUpperCase();
  return round1(unit === "TB" ? n * 1024 : unit === "MB" ? n / 1024 : n);
}

interface MacDisplay {
  _name?: string;
  sppci_model?: string;
  spdisplays_vendor?: string;
  spdisplays_vram?: string;
  _spdisplays_vram?: string;
  spdisplays_vram_shared?: string;
}

/** `system_profiler SPDisplaysDataType -json`. Apple Silicon GPUs share all of RAM. */
export function parseMacDisplays(json: string, ramGb: number): Gpu[] {
  let data: { SPDisplaysDataType?: MacDisplay[] };
  try {
    data = JSON.parse(json) as typeof data;
  } catch {
    return [];
  }
  const gpus: Gpu[] = [];
  for (const d of data.SPDisplaysDataType ?? []) {
    const name = d.sppci_model ?? d._name ?? "Unknown GPU";
    const vendorText = `${d.spdisplays_vendor ?? ""} ${name}`;
    const vendor = /apple/i.test(vendorText) ? "apple" : vendorFromName(vendorText.replace(/sppci_vendor_/i, ""));
    if (vendor === "apple") {
      gpus.push({ vendor, name, vramGb: ramGb, unifiedMemory: true });
      continue;
    }
    const dedicated = parseSizeGb(d.spdisplays_vram ?? d._spdisplays_vram);
    const shared = parseSizeGb(d.spdisplays_vram_shared);
    gpus.push({ vendor, name, vramGb: dedicated ?? shared ?? 0, unifiedMemory: dedicated === undefined && shared !== undefined });
  }
  return gpus;
}

/** /proc/meminfo MemTotal in bytes. */
export function parseMeminfoTotal(text: string): number | undefined {
  const m = /^MemTotal:\s+(\d+)\s*kB/m.exec(text);
  return m ? Number(m[1]) * 1024 : undefined;
}

/** First "Model name:" in lscpu output (big.LITTLE ARM chips list one per cluster). */
export function parseLscpuModel(text: string): string | undefined {
  const m = /^Model name:\s*(.+)$/m.exec(text);
  return m?.[1]?.trim() || undefined;
}

/** `rocm-smi --showproductname --showmeminfo vram --json`, best effort across rocm-smi versions. */
export function parseRocmSmi(json: string): Gpu[] {
  let data: Record<string, Record<string, string>>;
  try {
    data = JSON.parse(json) as typeof data;
  } catch {
    return [];
  }
  const gpus: Gpu[] = [];
  for (const [key, card] of Object.entries(data)) {
    if (!/^card\d+/.test(key) || typeof card !== "object") continue;
    const name = card["Card Series"] ?? card["Card series"] ?? card["Card model"] ?? "AMD GPU";
    const bytes = Number(card["VRAM Total Memory (B)"]);
    gpus.push({ vendor: "amd", name, vramGb: Number.isFinite(bytes) ? round1(bytes / 1024 ** 3) : 0, unifiedMemory: false });
  }
  return gpus;
}

/** `Get-CimInstance Win32_VideoController | Select Name,AdapterRAM | ConvertTo-Json`. AdapterRAM caps at 4 GB. */
export function parseWindowsVideoControllers(json: string): Gpu[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const list = (Array.isArray(data) ? data : [data]) as { Name?: string; AdapterRAM?: number }[];
  return list
    .filter((c) => c && typeof c.Name === "string")
    .map((c) => {
      const vendor = vendorFromName(c.Name!);
      const vramGb = typeof c.AdapterRAM === "number" && c.AdapterRAM > 0 ? round1(c.AdapterRAM / 1024 ** 3) : 0;
      return { vendor, name: c.Name!, vramGb, unifiedMemory: vendor === "intel" } satisfies Gpu;
    })
    .filter((g) => g.vendor !== "none");
}

/** Best GPU first: discrete before integrated, then by memory. */
export function sortGpus(gpus: Gpu[]): Gpu[] {
  const rank = (g: Gpu) => (g.vendor === "intel" ? 0 : 1);
  return [...gpus].sort((a, b) => rank(b) - rank(a) || b.vramGb - a.vramGb);
}
