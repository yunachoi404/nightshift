/**
 * Installs ComfyUI, the recipe's node packs and comfy-api-proxy (a TypeScript port of scripts/setup_comfyui.sh and
 * comfy_nodes/nightshift/install_upstream.py). Uses release tarballs instead of git, so a fresh Mac without the Xcode
 * tools works. Idempotent: a marker file records what is installed and only missing or changed parts are redone.
 */
import type { HardwareProfile, NodePack, Recipe } from "@nightshift/contract";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { primaryGpu } from "../hardware/probe.js";
import { exists, readJson, runStreaming, which, writeJsonAtomic, type Logger } from "../util.js";
import { downloadFile } from "./download.js";
import { extraModelPathsYaml } from "./modelDirs.js";
import { installNodePacks, PYTHON_HOLDS, recipeNodePacks } from "./nodes.js";

export const COMFY_REF = process.env.NIGHTSHIFT_COMFY_REF ?? "v0.41.3";
export const COMFY_REPO = "https://github.com/Comfy-Org/ComfyUI";
export const PROXY_PACKAGE = "comfy-api-proxy==0.1.6";

interface Marker {
  comfyRef?: string;
  torchIndex?: string;
  requirements?: string;
  /** sha256 of each node pack's requirements.txt installed into the venv. */
  nodeRequirements?: Record<string, string>;
  /** Older engines: node packs unpacked straight into custom_nodes from their default branches. */
  nodes?: Record<string, string>;
  proxy?: string;
}

export const MARKER_FILE = ".nightshift-install.json";

/** custom_nodes folders an older engine installed unpinned, which the node linker may remove. */
export async function legacyNodeDirs(comfyDir: string): Promise<string[]> {
  const marker = await readJson<Marker>(join(comfyDir, MARKER_FILE)).catch(() => undefined);
  return Object.keys(marker?.nodes ?? {});
}

export interface ComfyInstallOptions {
  comfyDir: string;
  proxyVenv: string;
  /** Scratch space for tarballs. */
  workDir: string;
  /** The repo's comfy_nodes/: our node pack (linked into custom_nodes) and the fixes for upstream packs. */
  nodesDir?: string;
  recipe: Recipe;
  hardware: HardwareProfile;
  /** Existing model folders to read through extra_model_paths.yaml (NIGHTSHIFT_MODELS_BASE, colon-separated). */
  modelsBases?: string[];
  log: Logger;
  onStep(message: string): void;
  signal?: AbortSignal;
  /** Where node pack archives come from. Default: GitHub's archive of the pinned ref. */
  archiveUrl?: (pack: NodePack) => string;
}

export async function findUv(): Promise<string | undefined> {
  if (process.env.NIGHTSHIFT_UV) return process.env.NIGHTSHIFT_UV;
  return which("uv", [join(homedir(), ".local", "bin"), join(homedir(), ".cargo", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]);
}

/** The PyTorch wheel index for this machine. Empty string means plain PyPI (macOS, MPS). */
export function torchIndex(hw: HardwareProfile): string {
  const gpu = primaryGpu(hw);
  if (hw.os === "macos") return "";
  if (gpu.vendor === "nvidia") return "https://download.pytorch.org/whl/cu130";
  if (gpu.vendor === "amd" && hw.os === "linux") return "https://download.pytorch.org/whl/rocm6.4";
  return "https://download.pytorch.org/whl/cpu";
}

/** What the marker records once ComfyUI's requirements are in: the ComfyUI they are for and the holds they kept. */
export function requirementsStamp(comfyRef: string | undefined): string {
  return [comfyRef ?? "git", ...PYTHON_HOLDS].join(" ");
}

/**
 * Whether this engine installed ComfyUI's Python packages under other holds than today's (an older engine, before a
 * hold was added). Installing again brings them in line. False when the engine never installed them.
 */
export async function comfyRequirementsStale(comfyDir: string): Promise<boolean> {
  const marker = await readJson<Marker>(join(comfyDir, MARKER_FILE)).catch(() => undefined);
  return marker?.requirements !== undefined && marker.requirements !== requirementsStamp(marker.comfyRef);
}

export const venvPython = (venv: string) => (process.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python"));

export async function installComfyUI(o: ComfyInstallOptions): Promise<void> {
  const uv = await findUv();
  if (!uv) throw new Error("uv is required to install ComfyUI. Install it from https://docs.astral.sh/uv/ or set NIGHTSHIFT_UV.");
  const markerPath = join(o.comfyDir, MARKER_FILE);
  const marker: Marker = (await readJson<Marker>(markerPath)) ?? {};
  const run = (args: string[], cwd?: string) => runStreaming(uv, args, { cwd, signal: o.signal, onLine: (l) => o.log(`uv: ${l}`) });
  await mkdir(o.comfyDir, { recursive: true });
  await mkdir(o.workDir, { recursive: true });

  const isGitCheckout = (await exists(join(o.comfyDir, ".git"))) && (await exists(join(o.comfyDir, "main.py")));
  if (!isGitCheckout && (marker.comfyRef !== COMFY_REF || !(await exists(join(o.comfyDir, "main.py"))))) {
    o.onStep(`Downloading ComfyUI ${COMFY_REF}`);
    await fetchTarball(`${COMFY_REPO}/archive/refs/tags/${COMFY_REF}.tar.gz`, o.comfyDir, o);
    marker.comfyRef = COMFY_REF;
    await writeJsonAtomic(markerPath, marker);
  }

  const py = venvPython(join(o.comfyDir, ".venv"));
  if (!(await exists(py))) {
    o.onStep("Creating the Python environment");
    await run(["venv", "--python", "3.12", join(o.comfyDir, ".venv")]);
    // A new environment has none of the packages the marker remembers.
    delete marker.torchIndex;
    delete marker.requirements;
    delete marker.nodeRequirements;
    await writeJsonAtomic(markerPath, marker);
  }

  const index = torchIndex(o.hardware);
  if (marker.torchIndex !== index) {
    o.onStep("Installing PyTorch");
    await run(["pip", "install", "--python", py, "torch", "torchvision", "torchaudio", ...(index ? ["--index-url", index] : [])]);
    marker.torchIndex = index;
    await writeJsonAtomic(markerPath, marker);
  }

  if (marker.requirements !== requirementsStamp(marker.comfyRef)) {
    o.onStep("Installing ComfyUI requirements");
    await run(["pip", "install", "--python", py, "-r", join(o.comfyDir, "requirements.txt"), ...PYTHON_HOLDS]);
    marker.requirements = requirementsStamp(marker.comfyRef);
    await writeJsonAtomic(markerPath, marker);
  }

  marker.nodeRequirements ??= {};
  await installNodePacks({
    comfyDir: o.comfyDir,
    nodesDir: o.nodesDir,
    packs: recipeNodePacks(o.recipe),
    python: py,
    uv,
    workDir: o.workDir,
    requirements: marker.nodeRequirements,
    save: () => writeJsonAtomic(markerPath, marker),
    legacy: Object.keys(marker.nodes ?? {}),
    log: o.log,
    onStep: o.onStep,
    signal: o.signal,
    archiveUrl: o.archiveUrl,
  });
  if (marker.nodes) {
    // The linker removed the unpinned packs; nothing installs them any more.
    delete marker.nodes;
    await writeJsonAtomic(markerPath, marker);
  }

  if (marker.proxy !== PROXY_PACKAGE || !(await exists(venvPython(o.proxyVenv)))) {
    o.onStep("Installing comfy-api-proxy");
    if (!(await exists(venvPython(o.proxyVenv)))) await run(["venv", "--python", "3.12", o.proxyVenv]);
    await run(["pip", "install", "--python", venvPython(o.proxyVenv), PROXY_PACKAGE]);
    marker.proxy = PROXY_PACKAGE;
    await writeJsonAtomic(markerPath, marker);
  }

  if (o.modelsBases?.length) {
    await writeFile(join(o.comfyDir, "extra_model_paths.yaml"), extraModelPathsYaml(o.modelsBases) + "\n");
    o.log(`extra_model_paths.yaml -> ${o.modelsBases.join(", ")}`);
  }
}

/** Download a GitHub archive and unpack it into `dest` (its top folder stripped). */
async function fetchTarball(url: string, dest: string, o: ComfyInstallOptions): Promise<void> {
  const tgz = join(o.workDir, `${Date.now()}.tar.gz`);
  try {
    await downloadFile({ url, dest: tgz, signal: o.signal });
    await mkdir(dest, { recursive: true });
    await runStreaming("tar", ["-xzf", tgz, "-C", dest, "--strip-components=1"], { signal: o.signal });
  } finally {
    await rm(tgz, { force: true });
  }
}
