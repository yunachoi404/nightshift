/**
 * Models the user already has: the scan matches files by name and exact size (legacy folder names, subfolders, the
 * Hugging Face cache, linked folders), the install checks each one's sha256 and links to it, and never changes it.
 */
import type { Event, HardwareProfile, ModelFile } from "@nightshift/contract";
import { createHash } from "node:crypto";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEditor } from "../src/editorLib.js";
import { EventBus } from "../src/events.js";
import type { HardwareService } from "../src/hardware/service.js";
import { Installer } from "../src/install/installer.js";
import { planInstall } from "../src/install/plan.js";
import { exactBytes, inPlace, linkModel, pickedFolder, ReuseStore, scanFolders, useFound, usualPlaces, wantedFiles } from "../src/install/reuse.js";
import { dataPaths } from "../src/paths.js";
import { MockRuntime } from "../src/runtime/runtime.js";
import { SettingsStore } from "../src/settings.js";
import { sleep } from "../src/util.js";
import { recipe } from "./helpers.js";

const tmp = () => mkdtempSync(join(tmpdir(), "ns-reuse-"));
const lic = { name: "Apache-2.0", url: "https://example.com/l" };
const content = (seed: string, bytes: number) => Buffer.alloc(bytes, seed);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** A file of exactly `bytes`; sparse unless content is given. */
function put(path: string, bytes: number | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  if (typeof bytes === "number") {
    writeFileSync(path, "");
    truncateSync(path, bytes);
  } else writeFileSync(path, bytes);
}

const DIT = content("d", 4000);
const TE = content("t", 3000);
const VAE = content("v", 2000);
const model = (o: Partial<ModelFile> & Pick<ModelFile, "id" | "folder" | "filename">, data?: Buffer): ModelFile => ({
  url: `https://huggingface.co/org/repo/resolve/abc123/${o.filename}`,
  license: lic,
  sizeGb: (data?.length ?? 1000) / 1e9,
  ...(data ? { sha256: sha(data) } : {}),
  ...o,
});
const dit = model({ id: "dit", name: "Video model", folder: "diffusion_models", filename: "dit.safetensors" }, DIT);
const te = model({ id: "te", name: "Prompt reader", folder: "text_encoders", filename: "te.safetensors" }, TE);
const vae = model({ id: "vae", name: "Decoder", folder: "vae", filename: "vae.safetensors" }, VAE);
const cfg = model({ id: "cfg", name: "Settings", folder: "audio_vae/vocoder", filename: "config.json", url: "https://huggingface.co/nvidia/vocoder/resolve/95a9/config.json", sizeGb: 1403 / 1e9 });
const big = model({ id: "big", name: "Big model", folder: "diffusion_models", filename: "big.safetensors", sizeGb: 26.415, sha256: "ab".repeat(32) });
const tierRecipe = recipe("nvidia-8", { vendor: "nvidia", minVramGb: 8, minRamGb: 16 }, { models: [dit, te, vae, cfg, big] });

describe("what a recipe file is", () => {
  it("knows each file's exact size: sizeGb is bytes / 1e9", () => {
    expect(exactBytes(big)).toBe(26_415_000_000);
    expect(exactBytes(cfg)).toBe(1403);
    const shipped = JSON.parse(readFileSync(new URL("../../../recipes/nvidia-8.json", import.meta.url), "utf8")) as { models: ModelFile[] };
    for (const m of shipped.models) expect(Math.abs(m.sizeGb * 1e9 - exactBytes(m))).toBeLessThan(0.01);
  });

  it("lists every file once across recipes, with its Hugging Face place", () => {
    const other = recipe("apple-16", { vendor: "apple", minVramGb: 16, minRamGb: 16 }, { models: [dit, vae] });
    const wanted = wantedFiles([tierRecipe, other]);
    expect(wanted.map((w) => w.key)).toEqual(["diffusion_models/dit.safetensors:4000", "text_encoders/te.safetensors:3000", "vae/vae.safetensors:2000", "audio_vae/vocoder/config.json:1403", "diffusion_models/big.safetensors:26415000000"]);
    expect(wanted.find((w) => w.filename === "config.json")?.hf).toEqual({ repo: "nvidia/vocoder", path: "config.json" });
  });

  it("knows a file's exact place: its models folder, a legacy name, or the same path in a snapshot of its repo", () => {
    const [w] = wantedFiles([recipe("t", { vendor: "nvidia", minVramGb: 0, minRamGb: 0 }, { models: [cfg] })]);
    expect(inPlace("/x/ComfyUI/models/audio_vae/vocoder/config.json", w!)).toBe(true);
    expect(inPlace("/h/hub/models--nvidia--vocoder/snapshots/95a9/config.json", w!)).toBe(true);
    expect(inPlace("/h/hub/models--nvidia--other/snapshots/95a9/config.json", w!)).toBe(false);
    expect(inPlace("/x/stuff/config.json", w!)).toBe(false);
    const [t] = wantedFiles([recipe("t", { vendor: "nvidia", minVramGb: 0, minRamGb: 0 }, { models: [te] })]);
    expect(inPlace("/x/models/clip/te.safetensors", t!)).toBe(true);
  });
});

describe("scanning folders", () => {
  it("finds files by name and exact size, in legacy folders, subfolders, linked folders and the Hugging Face cache", async () => {
    const root = tmp();
    const comfy = join(root, "ComfyUI", "models");
    put(join(comfy, "diffusion_models", "video", "dit.safetensors"), 4000); // a subfolder
    put(join(comfy, "clip", "te.safetensors"), 3000); // ComfyUI's legacy name for text_encoders
    put(join(comfy, "vae", "vae.safetensors"), 1999); // one byte short: not a match
    put(join(comfy, "vae", "other.safetensors"), 2000); // right size, wrong name
    // A models folder that links to another drive.
    put(join(root, "drive", "big.safetensors"), exactBytes(big));
    symlinkSync(join(root, "drive"), join(comfy, "checkpoints"));
    // The Hugging Face cache: snapshot files link to blobs.
    const hub = join(root, "hf", "hub", "models--nvidia--vocoder");
    put(join(hub, "blobs", "aa11"), 1403);
    mkdirSync(join(hub, "snapshots", "95a9"), { recursive: true });
    symlinkSync(join("..", "..", "blobs", "aa11"), join(hub, "snapshots", "95a9", "config.json"));
    // A loop of links must not hang the scan.
    symlinkSync(comfy, join(comfy, "diffusion_models", "loop"));

    const result = await scanFolders({ wanted: wantedFiles([tierRecipe]), roots: [join(root, "ComfyUI"), join(root, "hf", "hub"), join(root, "missing")], exclude: [] });
    expect([...result.found.keys()].sort()).toEqual(["audio_vae/vocoder/config.json:1403", "diffusion_models/big.safetensors:26415000000", "diffusion_models/dit.safetensors:4000", "text_encoders/te.safetensors:3000"]);
    expect(result.found.get("text_encoders/te.safetensors:3000")?.path).toBe(join(comfy, "clip", "te.safetensors"));
    expect(result.found.get("audio_vae/vocoder/config.json:1403")?.path).toBe(join(hub, "snapshots", "95a9", "config.json"));
    expect(result.searched).toEqual([join(root, "ComfyUI"), join(root, "hf", "hub")]);
    expect(result.unreadable).toEqual([]);
  });

  it("trusts a file without a checksum only exactly where its recipe puts it", async () => {
    const root = tmp();
    put(join(root, "models", "vocoder", "config.json"), 1403); // not under audio_vae/vocoder
    put(join(root, "elsewhere", "config.json"), 1403);
    expect((await scanFolders({ wanted: wantedFiles([tierRecipe]), roots: [root], exclude: [] })).found.size).toBe(0);
  });

  it("skips Nightshift's own models folder, and lists folders it cannot read", async () => {
    const root = tmp();
    put(join(root, "nightshift", "comfyui", "models", "vae", "vae.safetensors"), 2000);
    put(join(root, "locked", "vae", "vae.safetensors"), 2000);
    chmodSync(join(root, "locked", "vae"), 0o000);
    try {
      const result = await scanFolders({ wanted: wantedFiles([tierRecipe]), roots: [root], exclude: [join(root, "nightshift", "comfyui", "models")] });
      expect(result.found.size).toBe(0);
      // Root can read anything; the folder only counts as unreadable for a normal user.
      if (process.getuid?.() !== 0) expect(result.unreadable).toEqual([join(root, "locked", "vae")]);
      expect(result.searched).toEqual([root]);
    } finally {
      chmodSync(join(root, "locked", "vae"), 0o755);
    }
  });

  it("looks where ComfyUI Desktop, ComfyUI installs, their extra_model_paths.yaml and the Hugging Face cache keep models", async () => {
    const home = tmp();
    const appData = join(home, "Library", "Application Support");
    put(join(appData, "ComfyUI", "config.json"), Buffer.from(JSON.stringify({ basePath: join(home, "Comfy Desktop") })));
    put(join(appData, "ComfyUI", "extra_models_config.yaml"), Buffer.from(`comfyui_desktop:\n  base_path: ${join(home, "Comfy Desktop")}\n  is_default: true\n  checkpoints: models/checkpoints/\n  custom_nodes: custom_nodes/\n`));
    put(join(home, "ComfyUI", "extra_model_paths.yaml"), Buffer.from(`shared:\n  base_path: /mnt/models\n  text_encoders: |\n    clip/\n    text_encoders/\n`));
    const places = await usualPlaces({ home, platform: "darwin", env: { HF_HOME: join(home, "hf") } });
    expect(places).toEqual(
      expect.arrayContaining([
        join(home, "Comfy Desktop", "models", "checkpoints"),
        join(home, "Comfy Desktop", "models"),
        join(home, "Documents", "ComfyUI", "models"),
        join(home, "ComfyUI", "models"),
        "/mnt/models/clip",
        "/mnt/models/text_encoders",
        join(home, "ComfyUI_windows_portable", "ComfyUI", "models"),
        join(home, ".nightshift", "comfyui", "models"),
        join(appData, "Nightshift", "comfyui", "models"),
        join(home, "hf", "hub"),
      ]),
    );
    expect(places.some((p) => p.includes("custom_nodes"))).toBe(false);
    const linux = await usualPlaces({ home, platform: "linux", env: {} });
    expect(linux).toContain(join(home, ".cache", "huggingface", "hub"));
    expect(linux).toContain(join(home, ".config", "Nightshift", "comfyui", "models"));
  });

  it("takes a full path or one from the home folder for a folder the user types", () => {
    expect(pickedFolder("~/ComfyUI/", "/home/me")).toBe("/home/me/ComfyUI");
    expect(pickedFolder(" /mnt/models ", "/home/me")).toBe("/mnt/models");
    expect(pickedFolder("ComfyUI", "/home/me")).toBeUndefined();
  });
});

describe("links", () => {
  it("links to the user's file, replaces only its own earlier link, and never a real file", async () => {
    const root = tmp();
    const theirs = join(root, "theirs", "vae.safetensors");
    const moved = join(root, "theirs2", "vae.safetensors");
    put(theirs, VAE);
    put(moved, VAE);
    const dest = join(root, "comfyui", "models", "vae", "vae.safetensors");
    expect(await linkModel(theirs, dest)).toBe("symlink");
    expect(readlinkSync(dest)).toBe(theirs);
    expect(await linkModel(theirs, dest)).toBe("symlink");
    expect(await linkModel(moved, dest)).toBe("symlink");
    expect(readlinkSync(dest)).toBe(moved);
    // Their files are untouched.
    expect(readFileSync(theirs).equals(VAE) && readFileSync(moved).equals(VAE)).toBe(true);

    const own = join(root, "comfyui", "models", "vae", "own.safetensors");
    put(own, 10);
    await expect(linkModel(theirs, own)).rejects.toThrow(/already there/);
    expect(lstatSync(own).isSymbolicLink()).toBe(false);
    // A hard link made before (Windows without Developer Mode) is recognized as the same file.
    const hard = join(root, "comfyui", "models", "vae", "hard.safetensors");
    linkSync(theirs, hard);
    expect(await linkModel(theirs, hard)).toBe("hardlink");
  });
});

/** Their folder with dit (right), te (right bytes in the legacy folder), vae (same size, wrong bytes) and the config. */
function theirComfy(root: string) {
  const models = join(root, "their", "ComfyUI", "models");
  put(join(models, "diffusion_models", "dit.safetensors"), DIT);
  put(join(models, "clip", "te.safetensors"), TE);
  put(join(models, "vae", "vae.safetensors"), content("x", 2000));
  put(join(models, "audio_vae", "vocoder", "config.json"), 1403);
  return models;
}

describe("the plan and the install with found files", () => {
  it("counts found files as present, checks them, links the good ones and downloads the rest", async () => {
    const root = tmp();
    const models = theirComfy(root);
    const comfyDir = join(root, "data", "comfyui");
    const store = new ReuseStore(join(root, "data", "found-models.json"));
    await store.load();
    const scan = await scanFolders({ wanted: wantedFiles([tierRecipe]), roots: [join(root, "their")], exclude: [] });
    await store.record(scan, [join(root, "their")]);
    const plan = async () => planInstall({ recipe: tierRecipe, dirs: new Map(), comfyDir, freeDiskGb: 100, runtimeInstalled: true, reuse: store });

    const before = await plan();
    expect(before.reused?.map((r) => [r.id, r.checked])).toEqual([["dit", false], ["te", false], ["vae", false], ["cfg", false]]);
    expect(before.alreadyPresent).toEqual(["dit", "te", "vae", "cfg"]);
    expect(before.downloads.map((d) => d.id)).toEqual(["big"]);
    expect(before.scan).toMatchObject({ folders: [join(root, "their")], searched: [join(root, "their")], unreadable: [] });

    const steps: string[] = [];
    await useFound({ plan: before, recipe: tierRecipe, store, comfyDir, link: true, log: () => undefined, step: (m) => steps.push(m) });
    expect(steps).toEqual([
      "Checking Video model, already on this computer (1 of 4)",
      "Checking Prompt reader, already on this computer (2 of 4)",
      "Checking Decoder, already on this computer (3 of 4)",
      "Checking Settings, already on this computer (4 of 4)",
    ]);
    const after = await plan();
    expect(after.reused?.map((r) => [r.id, r.checked])).toEqual([["dit", true], ["te", true], ["cfg", true]]);
    // The decoder has the right name and size but other bytes: downloaded, and the plan says why.
    expect(after.reuseSkipped).toEqual([{ id: "vae", name: "Decoder", path: join(models, "vae", "vae.safetensors"), reason: "mismatch" }]);
    expect(after.downloads.map((d) => d.id)).toEqual(["vae", "big"]);
    expect(readlinkSync(join(comfyDir, "models", "diffusion_models", "dit.safetensors"))).toBe(join(models, "diffusion_models", "dit.safetensors"));
    expect(readlinkSync(join(comfyDir, "models", "text_encoders", "te.safetensors"))).toBe(join(models, "clip", "te.safetensors"));
    expect(lstatSync(join(comfyDir, "models", "vae", "vae.safetensors"), { throwIfNoEntry: false })).toBeUndefined();
    // Their files are as they were.
    expect(readFileSync(join(models, "diffusion_models", "dit.safetensors")).equals(DIT)).toBe(true);

    // A restart keeps the finds and their checks: nothing is hashed twice.
    const again = new ReuseStore(join(root, "data", "found-models.json"));
    await again.load();
    const restarted = await planInstall({ recipe: tierRecipe, dirs: new Map(), comfyDir, freeDiskGb: 100, runtimeInstalled: true, reuse: again });
    expect(restarted.reused?.every((r) => r.checked)).toBe(true);

    // A file that changes after its check is checked again before the next use.
    utimesSync(join(models, "diffusion_models", "dit.safetensors"), new Date(), new Date(Date.now() + 5000));
    expect((await plan()).reused?.find((r) => r.id === "dit")?.checked).toBe(false);

    // A file that is gone is downloaded again, and the plan says it is gone.
    rmSync(join(models, "clip", "te.safetensors"));
    const gone = await plan();
    expect(gone.reuseSkipped).toContainEqual({ id: "te", name: "Prompt reader", path: join(models, "clip", "te.safetensors"), reason: "missing" });
    expect(gone.downloads.map((d) => d.id)).toEqual(["te", "vae", "big"]);

    // Once Nightshift downloads it itself, the find is forgotten and its own file counts.
    const dest = join(comfyDir, "models", "text_encoders", "te.safetensors");
    rmSync(dest);
    put(dest, TE);
    await store.forget([te]);
    const own = await plan();
    expect(own.reuseSkipped?.some((s) => s.id === "te")).toBe(false);
    expect(own.alreadyPresent).toContain("te");
  });
});

describe("the installer with found files", () => {
  function installer(dataDir: string, scanRoots: string[], mode: "mock" | "local" = "mock") {
    const bus = new EventBus();
    const paths = dataPaths(dataDir);
    const settings = new SettingsStore(paths.settings);
    const hw: HardwareProfile = { os: "linux", arch: "x64", cpu: "i7", ramGb: 32, gpus: [], freeDiskGb: 500, source: "detected" };
    const runtime = new MockRuntime(bus, 0);
    const inst = new Installer({
      mode,
      paths,
      bus,
      runtime,
      recipes: () => ({ dir: "", recipes: [tierRecipe], problems: [] }),
      hardware: { effective: async () => hw } as unknown as HardwareService,
      settings,
      log: () => undefined,
      mockSpeed: 0,
      exclusive: (fn) => fn(),
      runningJob: () => undefined,
      editor: loadEditor,
      editorTools: {},
      scanPlaces: async () => scanRoots,
    });
    return { inst, bus, runtime, settings };
  }

  it("a scan finds the usual places and added folders, keeps the finds over a restart, and the install downloads only the rest", async () => {
    const root = tmp();
    theirComfy(root);
    const hub = join(root, "hub", "models--org--repo", "snapshots", "abc123");
    put(join(hub, "big.safetensors"), 50); // a sparse stand-in would be 26 GB; this one is the wrong size
    const dataDir = join(root, "data");
    const { inst, bus, runtime, settings } = installer(dataDir, [join(root, "hub")]);
    await settings.load();
    await inst.load();
    expect((await inst.plan("nvidia-8")).scan).toBeUndefined();

    await expect(inst.scan("nvidia-8", ["relative/path"])).rejects.toThrow(/full path/);
    await expect(inst.scan("nvidia-8", [join(root, "nope")])).rejects.toThrow(/no folder/);
    const plan = await inst.scan("nvidia-8", [join(root, "their", "ComfyUI")]);
    expect(plan.reused?.map((r) => r.id)).toEqual(["dit", "te", "vae", "cfg"]);
    expect(plan.scan?.searched).toEqual([join(root, "their", "ComfyUI"), join(root, "hub")]);
    expect(plan.downloads.filter((d) => !d.id.startsWith("editor-")).map((d) => d.id)).toEqual(["big"]);

    // Restarted: the finds and the added folder are still there, and a new scan searches it again.
    const restarted = installer(dataDir, [join(root, "hub")]).inst;
    await restarted.load();
    expect((await restarted.plan("nvidia-8")).reused?.length).toBe(4);
    expect((await restarted.scan("nvidia-8")).scan?.folders).toEqual([join(root, "their", "ComfyUI")]);

    const events: Event[] = [];
    bus.subscribe((e) => events.push(e));
    inst.start("nvidia-8", null);
    for (let i = 0; i < 300 && runtime.status().phase !== "ready"; i++) await sleep(10);
    expect(runtime.status()).toMatchObject({ phase: "ready", tier: "nvidia-8" });
    const progress = events.flatMap((e) => (e.type === "install" ? [e.progress] : []));
    // A mock install shows the checks, then downloads only what was not found.
    expect(progress.filter((p) => p.message.startsWith("Checking ") && p.message.includes("already on this computer")).map((p) => p.message)).toHaveLength(4);
    expect(new Set(progress.map((p) => p.modelId).filter((id) => id && !id.startsWith("editor-")))).toEqual(new Set(["big"]));
    expect(progress.at(-1)).toMatchObject({ message: "Installed", totalGb: plan.totalDownloadGb });
  });

  it("a scan is refused while an install runs", async () => {
    const root = tmp();
    const { inst, settings } = installer(join(root, "data"), []);
    await settings.load();
    await inst.load();
    inst.start("nvidia-8", null);
    await expect(inst.scan("nvidia-8")).rejects.toThrow(/Already installing/);
    await inst.stop();
  });

  it("the size check uses bytes: a file one byte off is never used", async () => {
    const root = tmp();
    put(join(root, "m", "diffusion_models", "dit.safetensors"), DIT.length + 1);
    const { inst, settings } = installer(join(root, "data"), []);
    await settings.load();
    await inst.load();
    const plan = await inst.scan("nvidia-8", [join(root, "m")]);
    expect(plan.reused).toBeUndefined();
    expect(statSync(join(root, "m", "diffusion_models", "dit.safetensors")).size).toBe(DIT.length + 1);
  });

  it("on start, a found file that needs a check, or is gone, asks for setup again in plain words", async () => {
    const root = tmp();
    const models = theirComfy(root);
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "install.json"), JSON.stringify({ installed: { "nvidia-8": new Date().toISOString() } }));
    const { inst, runtime, settings } = installer(dataDir, [], "local");
    await settings.load();
    await settings.update({ tier: "nvidia-8" });
    await inst.load();
    await inst.scan("nvidia-8", [join(root, "their")]);
    await inst.resume();
    expect(runtime.status()).toMatchObject({ phase: "not_installed", error: "4 model files found in another folder need a check before use. Set up again to check them." });
    rmSync(join(models, "diffusion_models", "dit.safetensors"));
    await inst.resume();
    expect(runtime.status()).toMatchObject({ phase: "not_installed", error: "A model file Nightshift used from another folder is gone. Set up again to download it, or scan again if you moved it." });
  });
});
