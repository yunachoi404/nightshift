/**
 * POST /api/install: check disk, install ComfyUI, the tier's models and the editor's tools, then start the runtime.
 * Local mode does it all for real; attach mode fetches only the editor's tools (the remote runtime has the models);
 * remote mode (a GPU computer on the network) fetches the editor's tools and comfy-api-proxy, which runs here;
 * mock mode fakes every download with progress events and writes nothing.
 */
import type { InstallPlan, ModelFile, Recipe } from "@nightshift/contract";
import type { ToolOverrides } from "@nightshift/editor";
import type { EditorLib } from "../editorLib.js";
import { join } from "node:path";
import { conflict, notFound } from "../errors.js";
import type { EventBus } from "../events.js";
import type { HardwareService } from "../hardware/service.js";
import type { DataPaths } from "../paths.js";
import type { RecipeSet } from "../recipes.js";
import type { Runtime } from "../runtime/runtime.js";
import type { SettingsStore } from "../settings.js";
import { errorMessage, exists, GIB, readJson, round1, sleep, writeJsonAtomic, type Logger } from "../util.js";
import { comfyRequirementsStale, installComfyUI } from "./comfyui.js";
import { downloadFile } from "./download.js";
import { installEditorItem, isEditorItem, planEditorTools } from "./editorTools.js";
import { loadModelDirs } from "./modelDirs.js";
import { missingNodePacks, recipeNodePacks } from "./nodes.js";
import { DISK_MARGIN_GB, planInstall, RUNTIME_INSTALL_GB } from "./plan.js";
import { installProxy } from "./proxy.js";

interface InstallState {
  installed: Record<string, string>;
}

export interface InstallerDeps {
  /** How the engine was started. The runtime's own mode wins while it is "remote". */
  mode: Runtime["mode"];
  paths: DataPaths;
  bus: EventBus;
  runtime: Runtime;
  recipes: () => RecipeSet;
  hardware: HardwareService;
  settings: SettingsStore;
  nodesDir?: string;
  log: Logger;
  mockSpeed: number;
  /** Run while no job is running (the queue's exclusive), so stopping ComfyUI never breaks a job. */
  exclusive: <T>(fn: () => Promise<T>) => Promise<T>;
  /** The job running right now, if any. */
  runningJob: () => { step: string } | undefined;
  /** The editor library; it fails to load only in a broken install, and then the plan says so. */
  editor: () => Promise<EditorLib>;
  /** Tool paths given to the engine (startEngine's editorTools). */
  editorTools?: ToolOverrides;
}

export class Installer {
  private state: InstallState = { installed: {} };
  private active?: { tier: string; controller: AbortController; done: Promise<void> };

  constructor(private readonly deps: InstallerDeps) {}

  async load(): Promise<void> {
    this.state = (await readJson<InstallState>(this.deps.paths.installState)) ?? { installed: {} };
    this.state.installed ??= {};
  }

  get busy(): boolean {
    return !!this.active;
  }

  isInstalled(tier: string): boolean {
    return tier in this.state.installed;
  }

  /** Tiers installed on this machine, the latest install first. */
  installedTiers(): string[] {
    return Object.entries(this.state.installed)
      .sort(([, a], [, b]) => b.localeCompare(a))
      .map(([tier]) => tier);
  }

  /** How models run right now: as the engine was started, or on a GPU computer on the network. */
  private get mode(): Runtime["mode"] {
    return this.deps.runtime.mode === "remote" ? "remote" : this.deps.mode;
  }

  recipe(tier: string): Recipe | undefined {
    return this.deps.recipes().recipes.find((r) => r.tier === tier);
  }

  private async runtimeInstalled(): Promise<boolean> {
    const py = process.platform === "win32" ? join(this.deps.paths.comfy, ".venv", "Scripts", "python.exe") : join(this.deps.paths.comfy, ".venv", "bin", "python");
    return exists(py);
  }

  /** The tier's models (except in attach and remote mode, where the remote runtime has them), then the editor's tools. */
  async plan(tier: string): Promise<InstallPlan> {
    const recipe = this.recipe(tier);
    if (!recipe) throw notFound(`No recipe for tier ${tier}`);
    const hw = await this.deps.hardware.effective();
    const attach = this.mode === "attach" || this.mode === "remote";
    const runtimeInstalled = attach || this.mode === "mock" || (await this.runtimeInstalled());
    const models: InstallPlan = attach
      ? { tier, downloads: [], alreadyPresent: recipe.models.map((m) => m.id), totalDownloadGb: 0, freeDiskGb: hw.freeDiskGb, fits: true }
      : await planInstall({ recipe, dirs: await loadModelDirs(this.deps.paths.comfy), comfyDir: this.deps.paths.comfy, freeDiskGb: hw.freeDiskGb, runtimeInstalled });
    const lib = await this.deps.editor().catch((err: unknown) => err as Error);
    const editor = lib instanceof Error ? { downloads: [], present: [], notes: [`Exports will not work: ${lib.message}`] } : planEditorTools(lib, recipe, lib.checkTools(this.deps.editorTools ?? {}));
    const totalDownloadGb = round1(models.totalDownloadGb + editor.downloads.reduce((sum, m) => sum + m.sizeGb, 0));
    const needGb = totalDownloadGb + (runtimeInstalled ? 0 : RUNTIME_INSTALL_GB) + DISK_MARGIN_GB;
    // A mock install writes nothing, so a demo runs on a machine with little free disk.
    const simulated = this.mode === "mock";
    const plan: InstallPlan = {
      tier,
      downloads: [...models.downloads, ...editor.downloads],
      alreadyPresent: [...models.alreadyPresent, ...editor.present],
      totalDownloadGb,
      freeDiskGb: hw.freeDiskGb,
      fits: simulated || needGb <= hw.freeDiskGb,
    };
    if (editor.notes.length) plan.notes = editor.notes;
    if (simulated) plan.simulated = true;
    return plan;
  }

  /** Starts the install in the background. Progress arrives as "install" and "runtime" events. */
  start(tier: string, memoryLimitGb: number | null): void {
    if (this.active) throw conflict(`Already installing ${this.active.tier}`);
    if (!this.recipe(tier)) throw notFound(`No recipe for tier ${tier}`);
    const controller = new AbortController();
    const previous = this.deps.settings.get().tier;
    this.deps.runtime.setPhase("installing", tier);
    const done = this.run(tier, memoryLimitGb, previous, controller.signal).finally(() => (this.active = undefined));
    this.active = { tier, controller, done };
  }

  async stop(): Promise<void> {
    this.active?.controller.abort();
    await this.active?.done.catch(() => undefined);
  }

  /** On engine start: bring up the runtime for the installed tier (any tier with a recipe on a remote), if there is one. */
  async resume(): Promise<void> {
    const { tier } = this.deps.settings.get();
    const { runtime, log } = this.deps;
    if (!tier || !this.recipe(tier) || (this.mode !== "remote" && !this.isInstalled(tier))) {
      runtime.setPhase("not_installed", tier && this.recipe(tier) ? tier : null);
      return;
    }
    // Checking the files takes a moment. A client that connects meanwhile must not read "not installed".
    runtime.setPhase("starting", tier);
    if (this.mode === "local") {
      const plan = await this.plan(tier);
      const models = plan.downloads.filter((m) => !isEditorItem(m)).length;
      const packs = await missingNodePacks(this.deps.paths.comfy, recipeNodePacks(this.recipe(tier)!), this.deps.nodesDir);
      // Missing editor tools do not stop the runtime: exports say what they lack.
      if (models || packs.length) {
        const missing = [models ? `${models} model file(s)` : "", packs.length ? `node pack(s) ${packs.join(", ")}` : ""].filter(Boolean).join(" and ");
        runtime.setPhase("not_installed", tier, `${missing[0]!.toUpperCase()}${missing.slice(1)} are missing. Install again to fetch them.`);
        return;
      }
      if (await comfyRequirementsStale(this.deps.paths.comfy)) {
        runtime.setPhase("not_installed", tier, "ComfyUI's Python packages need an update. Install again to update them.");
        return;
      }
    }
    await runtime.start(tier).catch((err) => log(`runtime did not start: ${errorMessage(err)}`));
  }

  private progress(modelId: string | null, doneGb: number, totalGb: number, message: string): void {
    this.deps.bus.emit({ type: "install", progress: { modelId, doneGb: round1(doneGb), totalGb: round1(totalGb), message } });
  }

  private async run(tier: string, memoryLimitGb: number | null, previous: string | null, signal: AbortSignal): Promise<void> {
    const { runtime, log, paths } = this.deps;
    const mode = this.mode;
    const recipe = this.recipe(tier)!;
    try {
      // Plan first, so every progress event carries the real total.
      const plan = await this.plan(tier);
      const total = plan.totalDownloadGb;
      // The old tier's ComfyUI goes down first, once the job on it (if any) is done.
      const busy = this.deps.runningJob();
      if (busy) this.progress(null, 0, total, `Waiting for the running ${busy.step.replace(/_/g, " ")} job to finish`);
      await this.deps.exclusive(() => runtime.stop());
      if (signal.aborted) throw new Error("Install stopped");
      this.progress(null, 0, total, "Checking disk space");
      if (!plan.fits) throw new Error(`Not enough disk space: ${total} GB to download, ${plan.freeDiskGb} GB free on the data drive.`);

      if (mode === "local") {
        await installComfyUI({
          comfyDir: paths.comfy,
          proxyVenv: paths.proxyVenv,
          workDir: join(paths.work, "install"),
          ...(this.deps.nodesDir ? { nodesDir: this.deps.nodesDir } : {}),
          recipe,
          hardware: await this.deps.hardware.effective(),
          modelsBases: process.env.NIGHTSHIFT_MODELS_BASE?.split(":").filter(Boolean),
          log,
          onStep: (m) => this.progress(null, 0, total, m),
          signal,
        });
      }
      if (mode === "remote") await installProxy({ proxyVenv: paths.proxyVenv, log, onStep: (m) => this.progress(null, 0, total, m), signal });

      let doneGb = 0;
      for (const model of plan.downloads) {
        const message = `Downloading ${describe(model)}`;
        if (mode !== "mock" && isEditorItem(model)) {
          await installEditorItem(await this.deps.editor(), model, { signal, onProgress: (bytes) => this.progress(model.id, doneGb + Math.min(model.sizeGb, bytes / 1e9), total, message) });
          if (signal.aborted) throw new Error("Install stopped");
        } else if (mode === "local") {
          await downloadFile({
            url: model.url,
            dest: join(paths.comfy, "models", model.folder, model.filename),
            ...(model.sha256 ? { sha256: model.sha256 } : {}),
            signal,
            onProgress: (bytes) => this.progress(model.id, doneGb + Math.min(model.sizeGb, bytes / GIB), total, message),
          });
        } else {
          // mock: about four seconds for the whole tier at speed 1
          const ticks = 8;
          for (let i = 1; i <= ticks; i++) {
            await sleep((4000 * this.deps.mockSpeed * (model.sizeGb / Math.max(total, 0.001))) / ticks, signal);
            this.progress(model.id, doneGb + (model.sizeGb * i) / ticks, total, message);
          }
        }
        doneGb += model.sizeGb;
        this.progress(model.id, doneGb, total, `Downloaded ${describe(model)}`);
      }

      // A remote's tier is not installed on this machine.
      if (mode !== "remote") {
        this.state.installed[tier] = new Date().toISOString();
        await writeJsonAtomic(paths.installState, this.state);
      }
      await this.deps.settings.update({ tier, memoryLimitGb });
      this.progress(null, total, total, "Installed");
      log(`tier ${tier} installed (${mode})`);
      await runtime.start(tier).catch((err) => log(`runtime did not start: ${errorMessage(err)}`));
    } catch (err) {
      const msg = signal.aborted ? "Install stopped" : errorMessage(err);
      log(`install of ${tier} failed: ${msg}`);
      this.progress(null, 0, 0, `Install failed: ${msg}`);
      // Back to the tier that was working before. A remote has its models either way: only the editor's tools are
      // missing, and exports say so.
      const fallback = mode === "remote" ? this.deps.settings.get().tier : previous !== tier && previous && this.isInstalled(previous) ? previous : null;
      if (!signal.aborted && fallback && this.recipe(fallback)) {
        await runtime.start(fallback).catch((e) => log(`runtime did not start: ${errorMessage(e)}`));
      } else {
        runtime.setPhase("not_installed", tier, msg);
      }
    }
  }
}

/** The editor's downloads are named for what they do; models by their file. */
function describe(model: ModelFile): string {
  if (!isEditorItem(model)) return model.filename;
  if (model.id.endsWith("render-browser")) return "the export renderer (Chrome headless shell)";
  if (model.id.endsWith("whisper-vad")) return "the voice activity model for captions";
  return `the speech recognition model for captions (${model.filename})`;
}
