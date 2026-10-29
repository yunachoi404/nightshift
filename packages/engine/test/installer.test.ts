/**
 * The install plan's editor tools (whisper models, the export renderer), and mock installs as demos: simulated,
 * so they fit on any disk and write nothing.
 */
import type { Event, HardwareProfile, InstallPlan } from "@nightshift/contract";
import type { ToolReport } from "@nightshift/editor";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEditor, type EditorLib } from "../src/editorLib.js";
import { EventBus } from "../src/events.js";
import type { HardwareService } from "../src/hardware/service.js";
import { requirementsStamp } from "../src/install/comfyui.js";
import { planEditorTools, whisperModelFor } from "../src/install/editorTools.js";
import { Installer } from "../src/install/installer.js";
import { dataPaths } from "../src/paths.js";
import type { Runtime } from "../src/runtime/runtime.js";
import { MockRuntime } from "../src/runtime/runtime.js";
import { SettingsStore } from "../src/settings.js";
import { sleep } from "../src/util.js";
import { recipe } from "./helpers.js";

const lib = await loadEditor();
/** The editor as the installer sees it, finding exactly `report` on this machine. */
const withTools = (report: ToolReport): EditorLib => ({ ...lib, checkTools: () => report });

const NONE: ToolReport = { ok: false, ffmpeg: null, ffprobe: null, whisper: null, whisperModel: null, whisperVad: null, vadModel: null, chrome: null, notes: [] };
const ALL: ToolReport = { ...NONE, ok: true, ffmpeg: "/bin/ffmpeg", ffprobe: "/bin/ffprobe", whisper: "/bin/whisper-cli", whisperModel: "/m/ggml-large-v3-turbo.bin", whisperVad: "/bin/vad", vadModel: "/m/vad.bin", chrome: "/bin/chrome" };

const big = recipe("apple-64", { vendor: "apple", minVramGb: 64, minRamGb: 64 }, {
  models: [{ id: "ltx", folder: "diffusion_models", filename: "ltx.safetensors", url: "https://example.com/ltx", sizeGb: 20, license: { name: "x", url: "https://example.com/l" } }],
});
const small = recipe("apple-16", { vendor: "apple", minVramGb: 16, maxVramGb: 48, minRamGb: 16 });

describe("editor tools in the install plan", () => {
  it("lists what is missing with sizes and licenses, and says what it cannot download", () => {
    const plan = planEditorTools(lib, big, NONE, { platform: "darwin", arch: "arm64" });
    expect(plan.downloads.map((d) => [d.id, d.folder])).toEqual([
      ["editor-whisper-large-v3-turbo", "editor/whisper"],
      ["editor-whisper-vad", "editor/whisper"],
      ["editor-render-browser", "editor/chrome-headless-shell"],
    ]);
    expect(plan.downloads.map((d) => d.sizeGb)).toEqual([expect.closeTo(1.62, 2), expect.closeTo(0.0009, 4), 0.1]);
    for (const d of plan.downloads) expect(d.license.name).toMatch(/MIT|BSD/);
    expect(plan.downloads[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.notes.join(" ")).toMatch(/ffmpeg is missing.*whisper\.cpp is missing/);
    expect(plan.present).toEqual([]);
  });

  it("small-memory tiers get the small English model", () => {
    expect(whisperModelFor(small)).toBe("small.en");
    expect(planEditorTools(lib, small, NONE).downloads[0]!.id).toBe("editor-whisper-small.en");
  });

  it("nothing to fetch when the machine has it all", () => {
    expect(planEditorTools(lib, big, ALL)).toEqual({ downloads: [], present: ["editor-whisper-large-v3-turbo", "editor-whisper-vad", "editor-render-browser"], notes: [] });
  });

  it("says how to get whisper.cpp on each platform", () => {
    const note = (platform: NodeJS.Platform) => planEditorTools(lib, big, { ...ALL, whisper: null }, { platform, arch: "x64" }).notes.join(" ");
    expect(note("darwin")).toContain("brew install whisper-cpp");
    expect(note("linux")).not.toContain("brew");
    expect(note("linux")).toContain("whisper-cli on the PATH");
  });

  it("Linux on ARM has no Chrome download: a note says how to get Chromium", () => {
    const plan = planEditorTools(lib, big, { ...ALL, chrome: null }, { platform: "linux", arch: "arm64" });
    expect(plan.downloads).toEqual([]);
    expect(plan.notes).toEqual([expect.stringContaining("playwright install chromium-headless-shell")]);
  });
});

function installer(mode: Runtime["mode"], freeDiskGb: number, report: ToolReport, dataDir = mkdtempSync(join(tmpdir(), "ns-inst-"))) {
  const bus = new EventBus();
  const paths = dataPaths(dataDir);
  const settings = new SettingsStore(paths.settings);
  const hw: HardwareProfile = { os: "macos", arch: "arm64", cpu: "M4", ramGb: 128, gpus: [], freeDiskGb, source: "detected" };
  const runtime = new MockRuntime(bus, 0);
  const inst = new Installer({
    mode,
    paths,
    bus,
    runtime,
    recipes: () => ({ dir: "", recipes: [big], problems: [] }),
    hardware: { effective: async () => hw } as unknown as HardwareService,
    settings,
    log: () => undefined,
    mockSpeed: 0,
    exclusive: (fn) => fn(),
    runningJob: () => undefined,
    editor: async () => withTools(report),
  });
  return { inst, bus, runtime, settings, dataDir };
}

describe("installer plans", () => {
  it("mock mode is a simulated install: it fits on a nearly full disk and shows what a real one would fetch", async () => {
    const plan: InstallPlan = await installer("mock", 2, NONE).inst.plan("apple-64");
    expect(plan).toMatchObject({ simulated: true, fits: true, freeDiskGb: 2 });
    expect(plan.downloads.map((d) => d.id)).toEqual(["ltx", "editor-whisper-large-v3-turbo", "editor-whisper-vad", "editor-render-browser"]);
    expect(plan.totalDownloadGb).toBe(21.7);
    expect(plan.notes).toHaveLength(2);
  });

  it("local mode counts the editor's downloads against the disk", async () => {
    const tight = await installer("local", 20 + 9 + 5 + 0.5, NONE).inst.plan("apple-64");
    expect(tight).toMatchObject({ fits: false, totalDownloadGb: 21.7 });
    expect(tight.simulated).toBeUndefined();
    expect((await installer("local", 40, NONE).inst.plan("apple-64")).fits).toBe(true);
  });

  it("attach mode fetches only the editor's tools: the remote runtime has the models", async () => {
    const plan = await installer("attach", 50, { ...ALL, chrome: null }).inst.plan("apple-64");
    expect(plan.downloads.map((d) => d.id)).toEqual(["editor-render-browser"]);
    expect(plan.alreadyPresent).toEqual(["ltx", "editor-whisper-large-v3-turbo", "editor-whisper-vad"]);
  });

  it("a mock install on a nearly full disk finishes, reports every file and writes nothing", async () => {
    const { inst, bus, runtime, settings, dataDir } = installer("mock", 1, NONE);
    await settings.load();
    const events: Event[] = [];
    bus.subscribe((e) => events.push(e));
    inst.start("apple-64", null);
    for (let i = 0; i < 200 && runtime.status().phase !== "ready"; i++) await sleep(10);
    expect(runtime.status()).toMatchObject({ phase: "ready", tier: "apple-64", mode: "mock" });
    const progress = events.flatMap((e) => (e.type === "install" ? [e.progress] : []));
    expect(new Set(progress.map((p) => p.modelId).filter(Boolean))).toEqual(new Set(["ltx", "editor-whisper-large-v3-turbo", "editor-whisper-vad", "editor-render-browser"]));
    expect(progress.at(-1)).toMatchObject({ message: "Installed", doneGb: 21.7, totalGb: 21.7 });
    expect(progress.some((p) => p.message.startsWith("Downloading the speech recognition model"))).toBe(true);
    expect(existsSync(join(dataDir, "comfyui"))).toBe(false);
    expect(readdirSync(dataDir).sort()).toEqual(["install.json", "settings.json"]);
  });
});

describe("installer resume", () => {
  it("an installed tier reads as starting from the first moment, not as not installed while its files are checked", async () => {
    const { inst, runtime, settings, dataDir } = installer("local", 100, ALL);
    writeFileSync(join(dataDir, "install.json"), JSON.stringify({ installed: { "apple-64": new Date().toISOString() } }));
    await settings.load();
    await settings.update({ tier: "apple-64" });
    await inst.load();
    const resumed = inst.resume();
    // A client that connects now (a window opening on a restarted engine) must not be told to set up again.
    expect(runtime.status()).toMatchObject({ phase: "starting", tier: "apple-64" });
    await resumed;
    // The check still runs: this machine lacks the tier's model, so it says what is missing.
    expect(runtime.status()).toMatchObject({ phase: "not_installed", tier: "apple-64", error: expect.stringContaining("missing") });
  });

  it("Python packages an older engine installed before today's holds ask for an install again; current ones start", async () => {
    const { inst, runtime, settings, dataDir } = installer("local", 100, ALL);
    writeFileSync(join(dataDir, "install.json"), JSON.stringify({ installed: { "apple-64": new Date().toISOString() } }));
    const model = join(dataDir, "comfyui", "models", "diffusion_models", "ltx.safetensors");
    mkdirSync(dirname(model), { recursive: true });
    writeFileSync(model, "");
    truncateSync(model, 20 * 1024 ** 3); // sparse: the plan reads the size, not the bytes
    const marker = join(dataDir, "comfyui", ".nightshift-install.json");
    // What an engine before the holds recorded: only the ComfyUI version.
    writeFileSync(marker, JSON.stringify({ comfyRef: "v0.41.3", requirements: "v0.41.3" }));
    await settings.load();
    await settings.update({ tier: "apple-64" });
    await inst.load();
    await inst.resume();
    expect(runtime.status()).toMatchObject({ phase: "not_installed", tier: "apple-64", error: "ComfyUI's Python packages need an update. Install again to update them." });

    writeFileSync(marker, JSON.stringify({ comfyRef: "v0.41.3", requirements: requirementsStamp("v0.41.3") }));
    await inst.resume();
    expect(runtime.status()).toMatchObject({ phase: "ready", tier: "apple-64" });
  });
});
