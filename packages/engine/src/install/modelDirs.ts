/**
 * Where ComfyUI looks for model files: its own models/<folder>, plus every folder listed in
 * extra_model_paths.yaml (how a shared GPU box reads weights that are already there without copying them).
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";

/** ComfyUI accepts the legacy folder names for the same model type. */
const ALIASES: Record<string, string[]> = {
  text_encoders: ["clip"],
  clip: ["text_encoders"],
  diffusion_models: ["unet"],
  unet: ["diffusion_models"],
};

export type ModelDirs = Map<string, string[]>;

/** A recipe folder and the same folder under ComfyUI's other name for its top level: "clip/x" for "text_encoders/x". */
export function folderNames(folder: string): string[] {
  const [top = "", ...rest] = folder.split("/");
  return [folder, ...(ALIASES[top] ?? []).map((alias) => [alias, ...rest].join("/"))];
}

export function expand(p: string): string {
  return p.replace(/^~(?=$|[/\\])/, homedir()).replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, name: string) => process.env[name] ?? "");
}

/** Parse the YAML text. Each top-level entry has base_path plus folder: path (or several, one per line). */
export function parseExtraModelPaths(text: string, yamlDir: string): ModelDirs {
  const dirs: ModelDirs = new Map();
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return dirs;
  }
  if (!doc || typeof doc !== "object") return dirs;
  for (const section of Object.values(doc as Record<string, unknown>)) {
    if (!section || typeof section !== "object") continue;
    const entries = section as Record<string, unknown>;
    let base = typeof entries.base_path === "string" ? expand(entries.base_path) : "";
    if (base && !isAbsolute(base)) base = resolve(yamlDir, base);
    for (const [folder, value] of Object.entries(entries)) {
      if (folder === "base_path" || folder === "is_default" || typeof value !== "string") continue;
      for (const line of value.split(/\r?\n/)) {
        const rel = expand(line.trim());
        if (!rel) continue;
        const full = isAbsolute(rel) ? rel : resolve(base || yamlDir, rel);
        addDir(dirs, folder, full);
      }
    }
  }
  return dirs;
}

function addDir(dirs: ModelDirs, folder: string, dir: string): void {
  const list = dirs.get(folder) ?? [];
  if (!list.includes(dir)) list.push(dir);
  dirs.set(folder, list);
}

/** Every directory a model of `folder` may live in, the install target first. */
export function searchDirs(dirs: ModelDirs, comfyDir: string, folder: string): string[] {
  const out = [join(comfyDir, "models", folder)];
  for (const name of [folder, ...(ALIASES[folder] ?? [])]) {
    for (const d of dirs.get(name) ?? []) if (!out.includes(d)) out.push(d);
  }
  return out;
}

export async function loadModelDirs(comfyDir: string): Promise<ModelDirs> {
  const yamlPath = join(comfyDir, "extra_model_paths.yaml");
  const text = await readFile(yamlPath, "utf8").catch(() => undefined);
  return text ? parseExtraModelPaths(text, comfyDir) : new Map();
}

/** Write extra_model_paths.yaml pointing at existing model folders (like setup_comfyui.sh's MODELS_BASE). */
export function extraModelPathsYaml(bases: string[]): string {
  const folders = ["checkpoints", "diffusion_models", "text_encoders", "loras", "vae", "latent_upscale_models", "upscale_models", "audio_encoders"];
  return bases
    .map((base, i) => [`shared_${i + 1}:`, `  base_path: ${base}`, ...folders.map((f) => `  ${f}: models/${f}/`)].join("\n"))
    .join("\n");
}
