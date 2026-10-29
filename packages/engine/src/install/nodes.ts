/**
 * Node packs: the ComfyUI nodes a recipe's workflows use besides core ComfyUI (its `customNodes`), and Nightshift's
 * own pack, which every recipe uses.
 *
 * A pack is unpacked once into <comfy>/node-sources/<name>-<key>. The key hashes everything that shapes those files
 * (repository, ref, folder, the bytes of our patch), so a new pin or a changed patch gets a fresh copy and an unchanged
 * one is never touched again: a patch runs exactly once on pristine upstream files. custom_nodes/<dir> links to the
 * node folder inside (a junction on Windows, a marked copy where links fail).
 *
 * Linking also runs before every ComfyUI start, so custom_nodes holds exactly the running tier's packs. It only
 * removes what Nightshift put there: links into node-sources, its marked copies, and the plain folders older engines
 * installed. Anything else is left alone, and a pack whose folder is taken by something else fails with a clear
 * message instead of overwriting it.
 */
import type { NodePack, Recipe } from "@nightshift/contract";
import { createHash, randomBytes } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { execCapture, exists, readJson, runStreaming, type Logger } from "../util.js";
import { downloadFile } from "./download.js";

/** Our own pack's folder inside the engine's nodesDir (the repo's comfy_nodes/), and its name in custom_nodes. */
export const NIGHTSHIFT_PACK = "nightshift";
export const SOURCES_DIR = "node-sources";
const SOURCE_MARKER = ".nightshift-source.json";
const COPY_MARKER = ".nightshift-pack.json";
/** What scripts/setup_model_lab_nodes.sh (comfy_nodes/nightshift/install_upstream.py) records it installed. */
const LAB_MARKER = ".nightshift-model-nodes.json";
/** Fish Audio's code is restricted, so no recipe may list it. DRAMA-3 was evaluated and dropped; Breeze is the voice. */
const REFUSED_SOURCES = /^https?:\/\/(www\.)?github\.com\/fishaudio\//i;

export class NodePackMissingError extends Error {
  override name = "NodePackMissingError";
}

export function packDir(pack: NodePack): string {
  return pack.dir ?? pack.name;
}

/** What is wrong with a recipe's node list: restricted code, or two packs (or one and ours) wanting one folder. */
export function nodePackProblems(recipe: Recipe): string[] {
  const problems: string[] = [];
  const dirs = new Set<string>([NIGHTSHIFT_PACK]);
  for (const pack of recipe.customNodes ?? []) {
    if (REFUSED_SOURCES.test(pack.url)) problems.push(`node pack ${pack.name}: Fish Audio code is never installed`);
    const dir = packDir(pack);
    if (dirs.has(dir)) problems.push(`node pack ${pack.name}: custom_nodes/${dir} is taken by another pack`);
    dirs.add(dir);
  }
  return problems;
}

/** The recipe's node packs. Throws on a list loadRecipes would have refused. */
export function recipeNodePacks(recipe: Recipe): NodePack[] {
  const problems = nodePackProblems(recipe);
  if (problems.length) throw new Error(`Recipe ${recipe.tier}: ${problems.join("; ")}`);
  return recipe.customNodes ?? [];
}

export function patchFile(nodesDir: string, patch: string): string {
  return join(nodesDir, NIGHTSHIFT_PACK, "install", `patch_${patch}.py`);
}

/** The Nightshift pack itself, checked: a pack folder must have its __init__.py or ComfyUI skips it. */
export async function nightshiftPack(nodesDir: string | undefined): Promise<string> {
  if (!nodesDir) throw new Error("The Nightshift node pack (comfy_nodes/nightshift) was not found. Every recipe uses its nodes.");
  const dir = join(nodesDir, NIGHTSHIFT_PACK);
  if (!(await exists(join(dir, "__init__.py")))) throw new Error(`The Nightshift node pack is incomplete: ${dir} has no __init__.py`);
  return dir;
}

export interface PackSource {
  pack: NodePack;
  key: string;
  /** The unpacked repository. */
  root: string;
  /** The node folder inside it, which custom_nodes links to. */
  nodeDir: string;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const slug = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, "-");

/** Where a pack's sources go. Throws when the pack needs a patch that is not there. */
export async function packSource(comfyDir: string, pack: NodePack, nodesDir: string | undefined): Promise<PackSource> {
  let patchSha256: string | null = null;
  if (pack.patch) {
    if (!nodesDir) throw new Error(`${pack.name} needs Nightshift's "${pack.patch}" fix, but the Nightshift node pack was not found`);
    const file = patchFile(nodesDir, pack.patch);
    const bytes = await readFile(file).catch(() => undefined);
    if (!bytes) throw new Error(`Nightshift's "${pack.patch}" fix for ${pack.name} is missing: ${file}`);
    patchSha256 = sha256(bytes);
  }
  const key = sha256(JSON.stringify({ url: pack.url.replace(/(\.git)?\/*$/, ""), ref: pack.ref, subdir: pack.subdir ?? "", patchSha256 })).slice(0, 12);
  const root = join(comfyDir, SOURCES_DIR, `${slug(pack.name)}-${key}`);
  return { pack, key, root, nodeDir: pack.subdir ? join(root, ...pack.subdir.split("/")) : root };
}

/** GitHub's archive of a commit, tag or branch. */
export function githubArchive(pack: NodePack): string {
  return `${pack.url.replace(/(\.git)?\/*$/, "")}/archive/${encodeURIComponent(pack.ref)}.tar.gz`;
}

/**
 * Python packages held below releases that break the pinned stack. ComfyUI's requirements leave them open, so without
 * these a fresh install takes whatever is newest that day.
 * - transformers 5.21 (2026-10-26) moved MimiModel's encoder and decoder parts into submodules. The pinned Breeze
 *   pack's codec subclasses the old MimiModel and no longer loads ("property 'upsample' of
 *   'Qwen3TTSTokenizerV2Encoder' object has no setter"), so the voice fails on every tier.
 */
export const PYTHON_HOLDS = ["transformers<5.21"];

/** torch, torchvision and torchaudio at their installed versions, so a pack's requirements never swap PyTorch's build. */
export function torchConstraints(freeze: string): string {
  const pins: string[] = [];
  for (const line of freeze.split(/\r?\n/)) {
    // "torch==2.14.1+cu130" pins 2.14.1: a constraint without a local label accepts the installed +cu130 build.
    const m = /^(torch|torchvision|torchaudio)==([^\s+;]+)/i.exec(line.trim());
    if (m) pins.push(`${m[1]!.toLowerCase()}==${m[2]}`);
  }
  return pins.map((p) => `${p}\n`).join("");
}

export interface NodeInstallOptions {
  comfyDir: string;
  /** The repo's comfy_nodes/: our pack and its patches. */
  nodesDir?: string;
  packs: NodePack[];
  /** ComfyUI's Python, which runs our patches; requirements go into its environment. */
  python: string;
  uv: string;
  /** Scratch space for archives. */
  workDir: string;
  /** sha256 of each pack's requirements.txt last installed into this environment, by pack name. Updated in place. */
  requirements: Record<string, string>;
  /** Persist `requirements`. */
  save(): Promise<void>;
  /** Plain folders older engines put in custom_nodes, which go when no tier needs them. */
  legacy?: string[];
  log: Logger;
  onStep(message: string): void;
  signal?: AbortSignal;
  /** Where a pack's archive comes from. Default: GitHub's archive of `ref`. */
  archiveUrl?: (pack: NodePack) => string;
}

/** Fetch, patch and set up every pack the recipe lists, then link exactly those (and ours) into custom_nodes. */
export async function installNodePacks(o: NodeInstallOptions): Promise<void> {
  await nightshiftPack(o.nodesDir);
  const sources = join(o.comfyDir, SOURCES_DIR);
  await mkdir(sources, { recursive: true });
  await mkdir(o.workDir, { recursive: true });
  // An install that stopped halfway leaves a .partial folder and nothing else.
  for (const name of await readdir(sources)) if (name.startsWith(".partial-")) await rm(join(sources, name), { recursive: true, force: true });
  for (const pack of o.packs) {
    const src = await prepareNodePack(pack, o);
    await installRequirements(src, o);
    // Older pins or patches of this pack are not linked by any tier once this one is.
    const prefix = `${slug(pack.name)}-`;
    for (const name of await readdir(sources)) {
      if (name.startsWith(prefix) && name !== `${prefix}${src.key}` && /^[0-9a-f]{12}$/.test(name.slice(prefix.length))) {
        await rm(join(sources, name), { recursive: true, force: true });
      }
    }
  }
  await linkNodePacks({ comfyDir: o.comfyDir, nodesDir: o.nodesDir, packs: o.packs, legacy: o.legacy, log: o.log });
}

/** Download, unpack and patch a pack, unless the same pack (same key) is already there. */
async function prepareNodePack(pack: NodePack, o: NodeInstallOptions): Promise<PackSource> {
  const src = await packSource(o.comfyDir, pack, o.nodesDir);
  if (await exists(join(src.root, SOURCE_MARKER))) return src;
  const partial = join(o.comfyDir, SOURCES_DIR, `.partial-${randomBytes(4).toString("hex")}`);
  const archive = join(o.workDir, `${slug(pack.name)}-${src.key}.tar.gz`);
  try {
    o.onStep(`Installing node pack ${pack.name} (${pack.ref.slice(0, 12)}${pack.license ? `, ${pack.license.name}` : ""})`);
    await downloadFile({ url: (o.archiveUrl ?? githubArchive)(pack), dest: archive, signal: o.signal });
    await mkdir(partial, { recursive: true });
    await runStreaming("tar", ["-xzf", archive, "-C", partial, "--strip-components=1"], { signal: o.signal });
    const nodeDir = pack.subdir ? join(partial, ...pack.subdir.split("/")) : partial;
    if (!(await exists(join(nodeDir, "__init__.py")))) throw new Error(`${pack.name} at ${pack.ref.slice(0, 12)} has no ComfyUI node in ${pack.subdir ?? "its top folder"}`);
    if (pack.patch) {
      o.onStep(`Applying Nightshift's fix to ${pack.name}`);
      await runStreaming(o.python, [patchFile(o.nodesDir!, pack.patch), nodeDir], { onLine: (l) => o.log(`${pack.name} patch: ${l}`), signal: o.signal });
    }
    const record = { name: pack.name, url: pack.url, ref: pack.ref, subdir: pack.subdir ?? null, patch: pack.patch ?? null, license: pack.license ?? null, key: src.key };
    await writeFile(join(partial, SOURCE_MARKER), JSON.stringify(record, null, 2) + "\n");
    // A folder without its marker never finished: replace it.
    await rm(src.root, { recursive: true, force: true });
    await rename(partial, src.root);
    o.log(`node pack ${pack.name} ${pack.ref.slice(0, 12)} ready in ${relative(o.comfyDir, src.root)}`);
    return src;
  } finally {
    await rm(partial, { recursive: true, force: true });
    await rm(archive, { force: true });
  }
}

/** The node folder's requirements.txt (not the repository's top one, which can be for training), keeping PyTorch and the holds. */
async function installRequirements(src: PackSource, o: NodeInstallOptions): Promise<void> {
  const file = join(src.nodeDir, "requirements.txt");
  const text = await readFile(file, "utf8").catch(() => undefined);
  if (text === undefined) return;
  const stamp = sha256(text);
  if (o.requirements[src.pack.name] === stamp) return;
  o.onStep(`Installing the Python packages ${src.pack.name} needs`);
  const freeze = await execCapture(o.uv, ["pip", "freeze", "--python", o.python], { timeoutMs: 120_000 });
  if (freeze.code !== 0) o.log(`uv pip freeze failed (${freeze.code}); installing ${src.pack.name}'s packages without pinning PyTorch`);
  const constraints = join(o.workDir, "constraints.txt");
  await writeFile(constraints, torchConstraints(freeze.stdout) + PYTHON_HOLDS.map((h) => `${h}\n`).join(""));
  await runStreaming(o.uv, ["pip", "install", "--python", o.python, "-r", file, "-c", constraints], { onLine: (l) => o.log(`uv: ${l}`), signal: o.signal });
  o.requirements[src.pack.name] = stamp;
  await o.save();
}

export interface LinkOptions {
  comfyDir: string;
  nodesDir?: string;
  packs: NodePack[];
  /** Plain folders older engines put in custom_nodes, removed when no tier needs them. */
  legacy?: string[];
  log: Logger;
}

type Owner = "nightshift" | "lab" | "foreign";

/**
 * Make custom_nodes hold exactly these packs plus ours. Offline and quick, so it runs before every ComfyUI start.
 * Throws NodePackMissingError when a pack was never installed.
 */
export async function linkNodePacks(o: LinkOptions): Promise<void> {
  const comfy = resolve(o.comfyDir);
  const custom = join(comfy, "custom_nodes");
  await mkdir(custom, { recursive: true });
  const real = await realpath(custom);
  if (!isInside(await realpath(comfy), real)) throw new Error(`${custom} leads outside this ComfyUI (${real}). Nightshift does not install nodes there.`);
  const lab = new Set(Object.keys((await readJson<Record<string, unknown>>(join(comfy, LAB_MARKER)).catch(() => undefined)) ?? {}));

  const want = new Map<string, { target: string; key: string; labName?: string }>();
  want.set(NIGHTSHIFT_PACK, { target: await nightshiftPack(o.nodesDir), key: NIGHTSHIFT_PACK });
  for (const pack of o.packs) {
    const src = await packSource(comfy, pack, o.nodesDir);
    if (!(await exists(join(src.root, SOURCE_MARKER)))) throw new NodePackMissingError(`The ${pack.name} node pack is not installed. Install the tier again.`);
    want.set(packDir(pack), { target: src.nodeDir, key: src.key, ...(lab.has(pack.name) ? { labName: pack.name } : {}) });
  }

  for (const name of await readdir(custom)) {
    if (want.has(name)) continue;
    if ((await ownerOf(comfy, join(custom, name), name, o.legacy ?? [])) !== "nightshift") continue;
    await rm(join(custom, name), { recursive: true, force: true });
    o.log(`custom_nodes/${name} removed: the tier does not use it`);
  }

  for (const [dir, w] of want) {
    const path = join(custom, dir);
    if (await linked(path, w.target, w.key)) continue;
    const owner = w.labName ? "lab" : await ownerOf(comfy, path, dir, o.legacy ?? []);
    const st = await lstat(path).catch(() => undefined);
    if (st && owner === "foreign") {
      throw new Error(`custom_nodes/${dir} is already there and Nightshift did not put it there. Move ${path} somewhere else, then try again.`);
    }
    if (st && owner === "lab" && !st.isSymbolicLink()) {
      // The model lab's scripts installed it as a folder (a git checkout on the Spark). Keep it, out of ComfyUI's way.
      const aside = await freeName(`${path}.disabled`);
      await rename(path, aside);
      o.log(`custom_nodes/${dir} moved to ${aside}`);
    } else if (st) {
      await rm(path, { recursive: true, force: true });
    }
    await linkOrCopy(w.target, path, w.key);
    o.log(`custom_nodes/${dir} -> ${w.target}`);
  }
}

/** Whether the recipe's packs are installed, so ComfyUI can start with them. Returns the names that are missing. */
export async function missingNodePacks(comfyDir: string, packs: NodePack[], nodesDir: string | undefined): Promise<string[]> {
  const missing: string[] = [];
  for (const pack of packs) {
    const src = await packSource(comfyDir, pack, nodesDir).catch(() => undefined);
    if (!src || !(await exists(join(src.root, SOURCE_MARKER)))) missing.push(pack.name);
  }
  return missing;
}

async function linked(path: string, target: string, key: string): Promise<boolean> {
  const st = await lstat(path).catch(() => undefined);
  if (!st) return false;
  if (st.isSymbolicLink()) return resolve(dirname(path), await readlink(path)) === resolve(target) && (await exists(path));
  // A copy is current when it was made from the same pack. Ours is copied afresh every time: it changes with the app.
  const copy = await readJson<{ key?: string }>(join(path, COPY_MARKER)).catch(() => undefined);
  return key !== NIGHTSHIFT_PACK && copy?.key === key;
}

async function ownerOf(comfy: string, path: string, name: string, legacy: string[]): Promise<Owner> {
  const st = await lstat(path).catch(() => undefined);
  if (!st) return "nightshift";
  if (st.isSymbolicLink()) {
    const target = resolve(dirname(path), await readlink(path));
    // Our pack's link, wherever the app lived when it was made, and every link into node-sources.
    return name === NIGHTSHIFT_PACK || isInside(join(comfy, SOURCES_DIR), target) ? "nightshift" : "foreign";
  }
  if (!st.isDirectory()) return "foreign";
  if (await exists(join(path, COPY_MARKER))) return "nightshift";
  // Older engines unpacked LTXVideo, VideoHelperSuite and KJNodes here from their default branches. A git checkout
  // by that name is someone's own and stays.
  if (legacy.includes(name) && !(await exists(join(path, ".git")))) return "nightshift";
  return "foreign";
}

async function linkOrCopy(target: string, path: string, key: string): Promise<void> {
  try {
    // Junctions need no special rights on Windows; elsewhere this is a plain directory link.
    await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EINVAL") throw err;
    await cp(target, path, { recursive: true });
    await writeFile(join(path, COPY_MARKER), JSON.stringify({ key, from: target }) + "\n");
  }
}

async function freeName(path: string): Promise<string> {
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? path : path.replace(/\.disabled$/, `-${i}.disabled`);
    if (!(await lstat(candidate).catch(() => undefined))) return candidate;
  }
}

function isInside(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

/** Every node class a recipe's workflows use, with the workflows that use it. Unreadable workflows are skipped. */
export async function workflowNodeClasses(recipe: Recipe, workflowsDir: string): Promise<Map<string, string[]>> {
  const classes = new Map<string, string[]>();
  for (const ref of [...Object.values(recipe.steps), recipe.referenceStill]) {
    if (!ref) continue;
    const graph = await readJson<Record<string, { class_type?: unknown }>>(join(workflowsDir, ref.workflow)).catch(() => undefined);
    for (const node of Object.values(graph ?? {})) {
      if (typeof node?.class_type !== "string") continue;
      const users = classes.get(node.class_type) ?? [];
      if (!users.includes(ref.workflow)) users.push(ref.workflow);
      classes.set(node.class_type, users);
    }
  }
  return classes;
}

/** The node classes the recipe uses that ComfyUI's /object_info does not list, in plain words, or undefined. */
export function missingNodeClasses(used: Map<string, string[]>, available: Iterable<string>): string | undefined {
  const have = new Set(available);
  const missing = [...used.keys()].filter((c) => !have.has(c)).sort();
  if (!missing.length) return undefined;
  const steps = [...new Set(missing.flatMap((c) => used.get(c) ?? []))].sort();
  return `ComfyUI is missing ${missing.length} node type(s) this tier uses (${missing.join(", ")}), so ${steps.join(", ")} will fail. A node pack did not load: see logs/comfyui.log, then install the tier again.`;
}
