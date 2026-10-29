/**
 * POST /api/remote/check: what a GPU computer on the network is, read from its ComfyUI. /system_stats gives the
 * hardware (matched to a tier like this machine's would be), /object_info what the tier's workflows need that it lacks.
 * Nothing here runs a job: generation still goes only through the Comfy SDK and comfy-api-proxy.
 */
import type { Gpu, HardwareProfile, Recipe, RemoteCheck } from "@nightshift/contract";
import { basename, join } from "node:path";
import { bindWorkflow, FILE_INPUTS, type Graph } from "../comfy/bind.js";
import { badRequest } from "../errors.js";
import { vendorFromName } from "../hardware/parse.js";
import { primaryGpu } from "../hardware/probe.js";
import { workflowNodeClasses } from "../install/nodes.js";
import { recommendTier } from "../recipes.js";
import { errorMessage, GIB, readJson, round1 } from "../util.js";

/** Where Nightshift's ComfyUI listens on a GPU computer (scripts/spark/serve.sh). */
export const DEFAULT_REMOTE_PORT = 8190;

/**
 * "spark", "spark:8190", "192.168.1.20" or "http://spark:8190/" -> "http://spark:8190". Without a scheme it is http on
 * port 8190 unless a port is given; a full URL is used as it is (https://comfy.example.com means port 443).
 */
export function normalizeRemoteUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw badRequest("Type the GPU computer's name or address, like spark or 192.168.1.20");
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let url: URL;
  try {
    url = new URL(hasScheme ? raw : `http://${raw}`);
  } catch {
    throw badRequest(`"${raw}" is not a computer name or address`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw badRequest("Use an http or https address");
  if (url.username || url.password || url.search || url.hash) throw badRequest("Use an address without a password, a ? or a #");
  if (!url.hostname) throw badRequest(`"${raw}" is not a computer name or address`);
  if (!hasScheme && !url.port) url.port = String(DEFAULT_REMOTE_PORT);
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** "spark:8190", how messages name the remote. */
export function remoteLabel(url: string): string {
  return new URL(url).host;
}

export interface SystemStats {
  system?: { os?: string; ram_total?: number; comfyui_version?: string };
  devices?: { name?: string; type?: string; vram_total?: number; torch_vram_total?: number }[];
}

/** The address answers, but not as ComfyUI does. */
export class NotComfyError extends Error {
  override name = "NotComfyError";
}

/** GET a ComfyUI JSON route. Throws NotComfyError when the answer is not what ComfyUI sends. */
async function getJson<T>(url: string, timeoutMs: number): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  if (!res.ok) {
    await res.body?.cancel();
    throw new NotComfyError(`HTTP ${res.status}`);
  }
  try {
    return (await res.json()) as T;
  } catch (err) {
    if ((err as Error).name === "TimeoutError") throw err;
    throw new NotComfyError("not JSON");
  }
}

export async function readSystemStats(url: string, timeoutMs = 8000): Promise<SystemStats> {
  const stats = await getJson<SystemStats>(`${url}/system_stats`, timeoutMs);
  if (typeof stats?.system !== "object" || !Array.isArray(stats.devices)) throw new NotComfyError("no system stats");
  return stats;
}

export type ObjectInfo = Record<string, { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } }>;

export async function readObjectInfo(url: string, timeoutMs = 60_000): Promise<ObjectInfo> {
  const info = await getJson<ObjectInfo>(`${url}/object_info`, timeoutMs);
  if (typeof info !== "object" || info === null || Array.isArray(info)) throw new NotComfyError("no node list");
  return info;
}

/** Why a remote did not answer, in plain words. */
export function describeRemoteError(err: unknown, url: string, timeoutMs: number): string {
  const { hostname, port } = new URL(url);
  const at = remoteLabel(url);
  if (err instanceof NotComfyError) return `${at} answers, but it is not ComfyUI. Check the address and the port.`;
  if ((err as Error)?.name === "TimeoutError") {
    const secs = Math.max(1, Math.round(timeoutMs / 1000));
    return `${at} did not answer within ${secs} second${secs === 1 ? "" : "s"}. Check that the computer is on and on this network.`;
  }
  const cause = (err as { cause?: { code?: string } })?.cause;
  const code = cause?.code ?? (err as { code?: string })?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `No computer named ${hostname} was found on this network.`;
  if (code === "ECONNREFUSED") return `${hostname} is there, but nothing answers on port ${port || "80"}. Check that Nightshift's ComfyUI is running on it.`;
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "EHOSTDOWN") return `${hostname} cannot be reached from this computer. Check that it is on and on this network.`;
  return `Could not reach ${at}: ${errorMessage(err)}`;
}

/** "cuda:0 NVIDIA GB10 : native" -> "NVIDIA GB10". */
function deviceName(raw: string): string {
  return raw.replace(/^[a-z]+:\d+\s+/i, "").replace(/\s+:\s+\S+$/, "").trim();
}

/** A GPU whose memory is within this share of system memory shares it (DGX Spark's GB10 reports RAM as VRAM). */
const UNIFIED_TOLERANCE = 0.05;

/**
 * The remote's hardware as ComfyUI reports it. ComfyUI does not say the CPU, the architecture or free disk, so those are
 * "unknown", "unknown" and 0.
 */
export function hardwareFromStats(stats: SystemStats): HardwareProfile {
  const ramGb = round1((stats.system?.ram_total ?? 0) / GIB);
  const sys = (stats.system?.os ?? "").toLowerCase();
  const os = sys === "darwin" ? "macos" : sys === "nt" || sys.startsWith("win") ? "windows" : "linux";
  const gpus: Gpu[] = [];
  for (const d of stats.devices ?? []) {
    const type = (d.type ?? "").toLowerCase();
    if (type === "cpu" || !type) continue;
    if (type === "mps") {
      gpus.push({ vendor: "apple", name: "Apple Silicon GPU", vramGb: ramGb, unifiedMemory: true });
      continue;
    }
    const name = deviceName(d.name ?? type) || type;
    const named = vendorFromName(name);
    const vendor = named !== "none" ? named : type === "cuda" ? "nvidia" : type === "xpu" ? "intel" : "none";
    const vramGb = round1((d.vram_total ?? 0) / GIB);
    const unified = vendor === "nvidia" && ramGb > 0 && Math.abs(vramGb - ramGb) <= ramGb * UNIFIED_TOLERANCE;
    gpus.push({ vendor, name, vramGb: unified ? ramGb : vramGb, unifiedMemory: unified });
  }
  gpus.sort((a, b) => b.vramGb - a.vramGb);
  return { os, arch: "unknown", cpu: "unknown", ramGb, gpus, freeDiskGb: 0, source: "remote" };
}

/** What to call the remote: its GPU ("NVIDIA GB10"), else its host name. */
export function remoteName(hw: HardwareProfile | null, url: string): string {
  const gpu = hw?.gpus.length ? primaryGpu(hw) : undefined;
  return gpu?.name ?? new URL(url).hostname;
}

/** The options of a list input (a combo), in either of /object_info's formats. */
function comboOptions(spec: unknown): string[] | undefined {
  if (!Array.isArray(spec)) return undefined;
  const [head, extra] = spec as [unknown, { options?: unknown } | undefined];
  const list = Array.isArray(head) ? head : head === "COMBO" && Array.isArray(extra?.options) ? extra.options : undefined;
  return list?.filter((v): v is string => typeof v === "string");
}

const MODEL_FILE = /\.(safetensors|sft|ckpt|pt|pth|bin|gguf|onnx)$/i;

/**
 * Node types the tier's workflows use that the remote lacks, and model files they load that its loaders do not list. A
 * model counts when a loader's list input names it (the value the workflow sends, after the recipe's params); inputs the
 * engine uploads (image, video, latent, voice) are not models.
 */
export async function missingOnRemote(recipe: Recipe, workflowsDir: string, info: ObjectInfo): Promise<{ nodes: string[]; models: string[] }> {
  const nodes = [...(await workflowNodeClasses(recipe, workflowsDir)).keys()].filter((c) => !(c in info)).sort();
  const recipeFiles = new Set(recipe.models.map((m) => m.filename));
  const models = new Set<string>();
  for (const ref of Object.values(recipe.steps)) {
    if (!ref) continue;
    const source = await readJson<Graph>(join(workflowsDir, ref.workflow)).catch(() => undefined);
    if (!source) continue;
    let graph = source;
    try {
      graph = bindWorkflow(source, ref, {}).graph;
    } catch {
      // A param the binder refuses: check the workflow as written.
    }
    const uploaded = new Set(Object.entries(ref.inputs).flatMap(([name, t]) => (FILE_INPUTS.has(name) ? [`${t.node}.${t.field}`] : [])));
    for (const [id, node] of Object.entries(graph)) {
      const spec = info[node.class_type ?? ""]?.input;
      if (!spec) continue;
      for (const [field, value] of Object.entries(node.inputs ?? {})) {
        if (typeof value !== "string" || uploaded.has(`${id}.${field}`)) continue;
        if (!MODEL_FILE.test(value) && !recipeFiles.has(basename(value))) continue;
        const options = comboOptions(spec.required?.[field] ?? spec.optional?.[field]);
        if (options && !options.includes(value)) models.add(value);
      }
    }
  }
  return { nodes, models: [...models].sort() };
}

/** "lacks node types A, B and model files c.safetensors" for the runtime's status, or undefined when nothing is missing. */
export function describeMissing(missing: { nodes: string[]; models: string[] }): string | undefined {
  const parts = [
    missing.nodes.length ? `node type(s) ${missing.nodes.join(", ")}` : "",
    missing.models.length ? `model file(s) ${missing.models.join(", ")}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" and ") : undefined;
}

export interface RemoteCheckOptions {
  recipes: Recipe[];
  workflowsDir: string;
  /** How long to wait for /system_stats, ms. /object_info gets longer: it is several MB. */
  timeoutMs?: number;
}

/** Reads a remote ComfyUI. Never throws for the remote's sake: what went wrong is in `error`. */
export async function checkRemote(url: string, o: RemoteCheckOptions): Promise<RemoteCheck> {
  const timeoutMs = o.timeoutMs ?? 8000;
  const result: RemoteCheck = { url, reachable: false, comfyuiVersion: null, hardware: null, recommendedTier: null, missingNodes: [], missingModels: [] };
  let stats: SystemStats;
  try {
    stats = await readSystemStats(url, timeoutMs);
  } catch (err) {
    return { ...result, error: describeRemoteError(err, url, timeoutMs) };
  }
  const hardware = hardwareFromStats(stats);
  const name = remoteName(hardware, url);
  const recipe = recommendTier(o.recipes, hardware);
  Object.assign(result, { reachable: true, name, comfyuiVersion: stats.system?.comfyui_version ?? null, hardware, recommendedTier: recipe?.tier ?? null });
  if (!recipe) {
    const gpu = hardware.gpus.length ? `${primaryGpu(hardware).name}, ${primaryGpu(hardware).vramGb} GB` : "no GPU";
    return { ...result, error: `No Nightshift tier fits ${name} (${gpu}, ${hardware.ramGb} GB of memory).` };
  }
  try {
    const missing = await missingOnRemote(recipe, o.workflowsDir, await readObjectInfo(url, Math.max(timeoutMs, 60_000)));
    return { ...result, missingNodes: missing.nodes, missingModels: missing.models };
  } catch (err) {
    return { ...result, error: `${remoteLabel(url)} answered, but listing its nodes and models failed: ${describeRemoteError(err, url, 60_000)}` };
  }
}
