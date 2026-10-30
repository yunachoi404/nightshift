/**
 * Models the user already has outside Nightshift: in a ComfyUI install, the folders its extra_model_paths.yaml names,
 * the Hugging Face cache, or a folder they pick. A file matches a recipe file when its name and exact size match
 * (a recipe's sizeGb is bytes / 1e9, so it knows the byte count). Before an install uses a match it checks the file
 * against the recipe's sha256, then links to it from Nightshift's models folder, where ComfyUI and the plan find it
 * like any other model. The user's files are only ever read: never copied, moved, changed or deleted.
 */
import type { InstallPlan, ModelFile, ModelScanInfo, Recipe, ReuseSkipped } from "@nightshift/contract";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, readdir, readFile, readlink, realpath, stat, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { abortError, errorMessage, nowIso, readJson, sleep, writeJsonAtomic, type Logger } from "../util.js";
import { expand, folderNames, parseExtraModelPaths } from "./modelDirs.js";

/** One file a recipe needs, by where Nightshift puts it and its exact size. Two recipes may share it. */
export interface WantedFile {
  key: string;
  folder: string;
  filename: string;
  bytes: number;
  sha256?: string;
  /** Its place in a Hugging Face repo, read from its download URL: "org/repo" and the path in the repo. */
  hf?: { repo: string; path: string };
}

export interface FoundFile {
  path: string;
  bytes: number;
  mtimeMs: number;
}

/** A found file as the data folder keeps it. */
export interface ReuseEntry extends FoundFile {
  /** The file passed the check (sha256, or the exact place for a file without one) at this size and date. */
  checked?: Stamp;
  /** The file failed the sha256 check at this size and date. */
  mismatch?: Stamp;
  /** Linking to it failed: why, in plain words. */
  unlinkable?: string;
}

interface Stamp {
  bytes: number;
  mtimeMs: number;
}

interface ReuseState {
  /** By WantedFile key. */
  found: Record<string, ReuseEntry>;
  scan?: ModelScanInfo;
}

/** The exact size of a recipe file: sizeGb is bytes / 1e9. */
export const exactBytes = (m: ModelFile): number => Math.round(m.sizeGb * 1e9);

/** Where Nightshift puts a model, plus its size: one recipe file, whichever recipe lists it. */
export const fileKey = (m: ModelFile): string => `${m.folder}/${m.filename}:${exactBytes(m)}`;

function hfPlace(url: string): WantedFile["hf"] {
  const m = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/[^/]+\/(.+)$/.exec(url);
  return m ? { repo: m[1]!, path: decodeURIComponent(m[2]!) } : undefined;
}

/** Every file the recipes need, once each. */
export function wantedFiles(recipes: Recipe[]): WantedFile[] {
  const out = new Map<string, WantedFile>();
  for (const recipe of recipes) {
    for (const m of recipe.models) {
      const key = fileKey(m);
      if (out.has(key)) continue;
      const hf = hfPlace(m.url);
      out.set(key, { key, folder: m.folder, filename: m.filename, bytes: exactBytes(m), ...(m.sha256 ? { sha256: m.sha256.toLowerCase() } : {}), ...(hf ? { hf } : {}) });
    }
  }
  return [...out.values()];
}

const slashes = (p: string) => p.split(sep).join("/");

/**
 * Whether a file sits exactly where its recipe puts it: under the same models folder (or its legacy name), or at the
 * same path in a Hugging Face snapshot of the same repo. A file without a sha256 counts only then.
 */
export function inPlace(path: string, w: WantedFile): boolean {
  const p = slashes(path);
  if (folderNames(w.folder).some((f) => p.endsWith(`/${f}/${w.filename}`))) return true;
  if (!w.hf) return false;
  const [org, repo] = w.hf.repo.split("/");
  const marker = `/models--${org}--${repo}/snapshots/`;
  const at = p.indexOf(marker);
  if (at < 0) return false;
  const rest = p.slice(at + marker.length);
  return rest.slice(rest.indexOf("/") + 1) === w.hf.path;
}

// ---------------------------------------------------------------- where to look

const COMFY_INSTALLS = ["Documents/ComfyUI", "ComfyUI", "comfyui", "Desktop/ComfyUI", "ComfyUI_windows_portable/ComfyUI", "Downloads/ComfyUI_windows_portable/ComfyUI", "Desktop/ComfyUI_windows_portable/ComfyUI"];

export interface Places {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

/** Folders a ComfyUI install keeps models in: its models folder and the folders its extra_model_paths.yaml names. */
async function comfyFolders(root: string): Promise<string[]> {
  const out = [join(root, "models")];
  const text = await readFile(join(root, "extra_model_paths.yaml"), "utf8").catch(() => undefined);
  if (text) out.push(...yamlFolders(text, root));
  return out;
}

function yamlFolders(text: string, dir: string): string[] {
  const out: string[] = [];
  for (const [folder, dirs] of parseExtraModelPaths(text, dir)) if (folder !== "custom_nodes" && folder !== "download_model_base") out.push(...dirs);
  return out;
}

/**
 * The usual places for models on this computer: ComfyUI Desktop (its settings name its folder), ComfyUI in the home
 * folder or a portable layout, the folders their extra_model_paths.yaml files name, other Nightshift installs, and the
 * Hugging Face cache. Folders that do not exist are skipped by the scan.
 */
export async function usualPlaces(o: Places): Promise<string[]> {
  const { home, platform, env } = o;
  const appData = platform === "darwin" ? join(home, "Library", "Application Support") : platform === "win32" ? (env.APPDATA ?? join(home, "AppData", "Roaming")) : (env.XDG_CONFIG_HOME ?? join(home, ".config"));
  const roots: string[] = [];
  const out: string[] = [];

  // ComfyUI Desktop keeps its folder in config.json and its model folders in extra_models_config.yaml.
  const desktop = join(appData, "ComfyUI");
  const config = await readJson<{ basePath?: unknown }>(join(desktop, "config.json")).catch(() => undefined);
  if (typeof config?.basePath === "string" && config.basePath) roots.push(config.basePath);
  const desktopYaml = await readFile(join(desktop, "extra_models_config.yaml"), "utf8").catch(() => undefined);
  if (desktopYaml) out.push(...yamlFolders(desktopYaml, desktop));

  roots.push(...COMFY_INSTALLS.map((p) => join(home, p)));
  if (platform === "win32") roots.push("C:\\ComfyUI_windows_portable\\ComfyUI", "D:\\ComfyUI_windows_portable\\ComfyUI");
  else roots.push("/opt/ComfyUI", "/workspace/ComfyUI");
  // Other Nightshift installs: the command line's default and the app's.
  roots.push(join(home, ".nightshift", "comfyui"), join(appData, "Nightshift", "comfyui"));
  for (const root of roots) out.push(...(await comfyFolders(root)));

  const hub = env.HF_HUB_CACHE ?? (env.HF_HOME ? join(env.HF_HOME, "hub") : join(home, ".cache", "huggingface", "hub"));
  out.push(hub);
  return [...new Set(out)];
}

/** A folder the user picked: the folder itself, and the model folders named in its extra_model_paths.yaml if it has one. */
export async function pickedPlaces(folders: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const folder of folders) {
    out.push(folder);
    const text = await readFile(join(folder, "extra_model_paths.yaml"), "utf8").catch(() => undefined);
    if (text) out.push(...yamlFolders(text, folder));
  }
  return out;
}

/** "~/ComfyUI" or a full path; undefined for a relative one. */
export function pickedFolder(input: string, home: string): string | undefined {
  const p = expand(input.trim().replace(/^~(?=$|[/\\])/, home));
  return isAbsolute(p) ? resolve(p) : undefined;
}

// ---------------------------------------------------------------- scan

/** Never worth reading: hidden folders, Python environments, ComfyUI's own inputs and outputs, a node pack's code. */
const SKIP = new Set(["node_modules", "__pycache__", "venv", "site-packages", "custom_nodes", "output", "input", "temp", "blobs"]);
const skipDir = (name: string) => name.startsWith(".") || SKIP.has(name);

export interface ScanOptions {
  wanted: WantedFile[];
  roots: string[];
  /** Nightshift's own models folder: its files are not "found", they are already installed. */
  exclude: string[];
  maxDepth?: number;
  maxDirs?: number;
  signal?: AbortSignal;
}

export interface ScanResult {
  found: Map<string, FoundFile>;
  searched: string[];
  unreadable: string[];
}

/**
 * Walk the roots for files with a wanted name and exact size. Symlinked folders are followed once (a models folder
 * that links to another drive is common). Folders that cannot be read are listed, not fatal.
 */
export async function scanFolders(o: ScanOptions): Promise<ScanResult> {
  const byName = new Map<string, WantedFile[]>();
  for (const w of o.wanted) byName.set(w.filename, [...(byName.get(w.filename) ?? []), w]);
  const maxDepth = o.maxDepth ?? 10;
  let budget = o.maxDirs ?? 20_000;
  const exclude = await Promise.all(o.exclude.map((p) => realpath(p).catch(() => resolve(p))));
  const excluded = (real: string) => exclude.some((e) => real === e || real.startsWith(e + sep));
  const visited = new Set<string>();
  const found = new Map<string, FoundFile & { placed: boolean }>();
  const searched: string[] = [];
  const unreadable = new Set<string>();

  const consider = (path: string, s: { size: number; mtimeMs: number }, candidates: WantedFile[]) => {
    for (const w of candidates) {
      if (s.size !== w.bytes) continue;
      const placed = inPlace(path, w);
      // Without a checksum to check later, only a file exactly where its recipe puts it is trusted.
      if (!w.sha256 && !placed) continue;
      const had = found.get(w.key);
      if (!had || (placed && !had.placed)) found.set(w.key, { path, bytes: s.size, mtimeMs: s.mtimeMs, placed });
    }
  };

  for (const root of o.roots) {
    const rootStat = await stat(root).catch((err: NodeJS.ErrnoException) => err);
    if (rootStat instanceof Error) {
      if (rootStat.code === "EACCES" || rootStat.code === "EPERM") unreadable.add(root);
      continue;
    }
    if (!rootStat.isDirectory()) continue;
    const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
    let read = false;
    while (stack.length && budget > 0) {
      if (o.signal?.aborted) throw abortError(o.signal);
      const { dir, depth } = stack.pop()!;
      const real = await realpath(dir).catch(() => undefined);
      if (!real || visited.has(real) || excluded(real)) continue;
      visited.add(real);
      budget--;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        unreadable.add(dir);
        continue;
      }
      read = true;
      for (const e of entries) {
        const path = join(dir, e.name);
        const candidates = byName.get(e.name);
        if (e.isDirectory()) {
          if (!skipDir(e.name) && depth < maxDepth) stack.push({ dir: path, depth: depth + 1 });
        } else if (e.isFile() && candidates) {
          const s = await stat(path).catch(() => undefined);
          if (s) consider(path, s, candidates);
        } else if (e.isSymbolicLink() && (candidates || !skipDir(e.name))) {
          // A Hugging Face snapshot links each file to its blob; a models folder may link a folder on another drive.
          const s = await stat(path).catch(() => undefined);
          if (s?.isDirectory() && depth < maxDepth) stack.push({ dir: path, depth: depth + 1 });
          else if (s?.isFile() && candidates) consider(path, s, candidates);
        }
      }
    }
    if (read) searched.push(root);
  }
  return { found: new Map([...found].map(([k, { placed: _, ...f }]) => [k, f])), searched, unreadable: [...unreadable] };
}

// ---------------------------------------------------------------- check and link

/** sha256 of a file, read once from start to end. `onBytes` gets the running count. */
export async function sha256File(path: string, signal?: AbortSignal, onBytes?: (done: number) => void): Promise<string> {
  const hash = createHash("sha256");
  let done = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 4 * 1024 * 1024, signal })) {
    hash.update(chunk as Buffer);
    done += (chunk as Buffer).length;
    onBytes?.(done);
  }
  return hash.digest("hex");
}

/**
 * Put a link to the user's file at `dest`, Nightshift's own place for the model. A symbolic link where the system
 * allows one; Windows without Developer Mode refuses those, so a hard link (same drive only). The only thing ever
 * replaced at `dest` is a symbolic link, one this function made for an earlier find. A real file there is left alone.
 */
export async function linkModel(source: string, dest: string): Promise<"symlink" | "hardlink"> {
  await mkdir(dirname(dest), { recursive: true });
  const here = await lstat(dest).catch(() => undefined);
  if (here?.isSymbolicLink()) {
    if ((await readlink(dest)) === source) return "symlink";
    await unlink(dest);
  } else if (here) {
    const s = await stat(source);
    if (here.ino === s.ino && here.dev === s.dev) return "hardlink";
    throw new Error(`${dest} is already there`);
  }
  try {
    await symlink(source, dest, "file");
    return "symlink";
  } catch (err) {
    if (!["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
  }
  try {
    await link(source, dest);
    return "hardlink";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(code === "EXDEV" ? "It is on another drive, and this system allows no links there" : `This system could not link to it (${code ?? "error"})`);
  }
}

// ---------------------------------------------------------------- what the data folder keeps

const sameStamp = (a: Stamp | undefined, b: Stamp) => !!a && a.bytes === b.bytes && a.mtimeMs === b.mtimeMs;

export type ReuseStatus =
  | { kind: "reuse"; path: string; checked: boolean }
  | { kind: "skip"; path: string; reason: ReuseSkipped["reason"] };

/** The models found outside Nightshift, kept in the data folder so a restart keeps them. */
export class ReuseStore {
  private state: ReuseState = { found: {} };

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    this.state = (await readJson<ReuseState>(this.file).catch(() => undefined)) ?? { found: {} };
    this.state.found ??= {};
  }

  private save(): Promise<void> {
    return writeJsonAtomic(this.file, this.state);
  }

  get scan(): ModelScanInfo | undefined {
    return this.state.scan;
  }

  entry(model: ModelFile): ReuseEntry | undefined {
    return this.state.found[fileKey(model)];
  }

  /** Take a scan's finds. A file found again unchanged keeps its check. */
  async record(result: ScanResult, folders: string[]): Promise<void> {
    const found: Record<string, ReuseEntry> = {};
    for (const [key, f] of result.found) {
      const old = this.state.found[key];
      const same = old?.path === f.path && sameStamp(old, f);
      found[key] = { ...f, ...(same && old.checked ? { checked: old.checked } : {}), ...(same && old.mismatch ? { mismatch: old.mismatch } : {}) };
    }
    this.state = { found, scan: { at: nowIso(), folders, searched: result.searched, unreadable: result.unreadable } };
    await this.save();
  }

  async update(model: ModelFile, change: Partial<ReuseEntry>): Promise<void> {
    const key = fileKey(model);
    const entry = this.state.found[key];
    if (!entry) return;
    this.state.found[key] = { ...entry, ...change };
    await this.save();
  }

  /** Nightshift downloaded the file itself: the find is no longer needed. */
  async forget(models: ModelFile[]): Promise<void> {
    const keys = models.map(fileKey).filter((k) => k in this.state.found);
    if (!keys.length) return;
    for (const k of keys) delete this.state.found[k];
    await this.save();
  }

  /**
   * Whether the install uses the user's file for this model. Undefined when there is no find, or when `dest` holds a
   * file of Nightshift's own: then the usual checks decide.
   */
  async status(model: ModelFile, dest: string): Promise<ReuseStatus | undefined> {
    const entry = this.entry(model);
    if (!entry) return undefined;
    const here = await lstat(dest).catch(() => undefined);
    const s = await stat(entry.path).catch(() => undefined);
    // A real file at dest is Nightshift's own download, or the hard link it made to this very file.
    if (here && !here.isSymbolicLink() && !(s && here.ino === s.ino && here.dev === s.dev)) return undefined;
    if (!s?.isFile() || s.size !== entry.bytes) return { kind: "skip", path: entry.path, reason: "missing" };
    const now = { bytes: s.size, mtimeMs: s.mtimeMs };
    if (sameStamp(entry.mismatch, now)) return { kind: "skip", path: entry.path, reason: "mismatch" };
    if (entry.unlinkable) return { kind: "skip", path: entry.path, reason: "unlinkable" };
    return { kind: "reuse", path: entry.path, checked: sameStamp(entry.checked, now) };
  }

  /**
   * Check a found file before its first use: its sha256 against the recipe's. A file without one was found exactly
   * where its recipe puts it, at its exact size, which is all a fresh download of it would be checked for.
   */
  async check(model: ModelFile, signal?: AbortSignal, onBytes?: (done: number) => void): Promise<boolean> {
    const entry = this.entry(model);
    if (!entry) return false;
    const s = await stat(entry.path);
    const now = { bytes: s.size, mtimeMs: s.mtimeMs };
    const ok = !model.sha256 || (await sha256File(entry.path, signal, onBytes)) === model.sha256.toLowerCase();
    await this.update(model, ok ? { checked: now, mismatch: undefined } : { mismatch: now, checked: undefined });
    return ok;
  }
}

// ---------------------------------------------------------------- at install time

/**
 * Before an install uses the files found outside Nightshift: check each one not checked yet against its recipe's
 * sha256, then link the good ones into the models folder. A file that fails either way is downloaded instead (plan
 * again afterwards). A mock install only shows the checks (`simulate`: milliseconds each) and links nothing.
 */
export async function useFound(o: {
  plan: InstallPlan;
  recipe: Recipe;
  store: ReuseStore;
  comfyDir: string;
  link: boolean;
  simulate?: number;
  signal?: AbortSignal;
  log: Logger;
  step(message: string): void;
}): Promise<void> {
  const models = new Map(o.recipe.models.map((m) => [m.id, m]));
  const unchecked = (o.plan.reused ?? []).filter((r) => !r.checked);
  for (const [i, r] of unchecked.entries()) {
    const model = models.get(r.id);
    if (!model) continue;
    const label = `Checking ${model.name ?? model.filename}, already on this computer (${i + 1} of ${unchecked.length})`;
    o.step(label);
    if (o.simulate !== undefined) {
      await sleep(o.simulate, o.signal);
      continue;
    }
    let last = Date.now();
    const ok = await o.store.check(model, o.signal, (done) => {
      if (Date.now() - last < 500) return;
      last = Date.now();
      o.step(`${label}, ${Math.min(99, Math.floor((done / Math.max(1, exactBytes(model))) * 100))}%`);
    });
    if (!ok) o.log(`${r.path} does not match the recipe's sha256 for ${model.filename}; downloading it instead`);
  }
  if (!o.link) return;
  for (const r of o.plan.reused ?? []) {
    const model = models.get(r.id);
    if (!model) continue;
    const dest = join(o.comfyDir, "models", model.folder, model.filename);
    const now = await o.store.status(model, dest);
    if (now?.kind !== "reuse" || !now.checked) continue;
    try {
      const how = await linkModel(now.path, dest);
      o.log(`using ${now.path} for ${model.folder}/${model.filename} (${how})`);
    } catch (err) {
      o.log(`could not link ${now.path}: ${errorMessage(err)}; downloading it instead`);
      await o.store.update(model, { unlinkable: errorMessage(err) });
    }
  }
}
