/**
 * "Use a GPU computer on your network": POST /api/remote/check, POST /api/remote and DELETE /api/remote. The choice
 * lives in Settings.remote, so the app starts on that computer next time too. Only an engine started for this machine
 * (local mode) can switch; mock and attach mode were told where their GPU is at launch.
 */
import { HardwareProfileSchema, type HardwareProfile, type Recipe, type RemoteCheck, type RemoteUseRequest, type RuntimeStatus } from "@nightshift/contract";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { conflict, notFound } from "../errors.js";
import type { EventBus } from "../events.js";
import type { Installer } from "../install/installer.js";
import { installProxy } from "../install/proxy.js";
import type { DataPaths } from "../paths.js";
import type { RecipeSet } from "../recipes.js";
import type { Runtime } from "../runtime/runtime.js";
import type { SettingsStore } from "../settings.js";
import { errorMessage, readJson, writeJsonAtomic, type Logger } from "../util.js";
import { checkRemote, describeMissing, hardwareFromStats, missingOnRemote, normalizeRemoteUrl, NotComfyError, readObjectInfo, readSystemStats, remoteLabel, remoteName } from "./check.js";
import { RemoteRuntime } from "./runtime.js";
import { RuntimeSwitch } from "./switch.js";

export interface RemoteRuntimeOptions {
  paths: DataPaths;
  workflowsDir: string;
  recipe: (tier: string) => Recipe | undefined;
  log: Logger;
  /** How often to look at the proxy and the remote, ms. */
  checkMs?: number;
}

/** Makes the runtime for a remote ComfyUI: its own proxy state and log, and what it lacks for a tier in plain words. */
export function remoteRuntimes(o: RemoteRuntimeOptions): (bus: EventBus, url: string) => RemoteRuntime {
  return (bus, url) =>
    new RemoteRuntime(bus, {
      comfyUrl: url,
      proxyVenv: o.paths.proxyVenv,
      stateDir: join(o.paths.root, "proxy", "remote", createHash("sha256").update(url).digest("hex").slice(0, 12)),
      logFile: join(o.paths.logs, "proxy-remote.log"),
      log: o.log,
      prepare: () => installProxy({ proxyVenv: o.paths.proxyVenv, log: o.log }),
      problems: async (tier) => {
        const recipe = o.recipe(tier);
        if (!recipe) return `No recipe for tier ${tier}`;
        const missing = describeMissing(await missingOnRemote(recipe, o.workflowsDir, await readObjectInfo(url)));
        return missing && `The GPU computer at ${remoteLabel(url)} lacks ${missing} that tier ${tier} uses, so jobs that need them will fail. Set it up with scripts/setup_comfyui.sh.`;
      },
      ...(o.checkMs ? { checkMs: o.checkMs } : {}),
    });
}

export interface RemoteServiceDeps {
  runtime: Runtime;
  settings: SettingsStore;
  installer: Installer;
  reloadRecipes: () => Promise<RecipeSet>;
  workflowsDir: string;
  paths: DataPaths;
  /** The queue's exclusive: run while no GPU job runs. */
  exclusive: <T>(fn: () => Promise<T>) => Promise<T>;
  log: Logger;
}

/** remote.json: the tier this machine ran before a remote took over (to go back to), and the remote's hardware. */
interface RemoteState {
  localTier?: string | null;
  /** What the GPU computer at `url` reported the last time it answered a check or a use. */
  hardware?: { url: string; profile: HardwareProfile };
}

export class RemoteService {
  private state: RemoteState = {};

  constructor(private readonly d: RemoteServiceDeps) {}

  private get statePath(): string {
    return join(this.d.paths.root, "remote.json");
  }

  private save(): Promise<void> {
    return writeJsonAtomic(this.statePath, this.state);
  }

  /** The GPU computer jobs go to right now, or null. */
  private get current(): string | null {
    return this.d.runtime instanceof RuntimeSwitch ? this.d.runtime.remoteUrl : null;
  }

  /**
   * While a GPU computer on the network does the work, recipes are matched against it: its hardware as it last reported
   * it (`source: "remote"`), for GET /api/hardware and the tiers' recommendation. Undefined on this machine.
   */
  hardware(): HardwareProfile | undefined {
    const saved = this.state.hardware;
    return saved && saved.url === this.current ? saved.profile : undefined;
  }

  private switcher(): RuntimeSwitch {
    if (this.d.runtime instanceof RuntimeSwitch) return this.d.runtime;
    const how = this.d.runtime.mode === "mock" ? "in mock mode" : "attached to a proxy (--comfy-base-url)";
    throw conflict(`This engine was started ${how}, so it cannot switch GPU computers. Start it without that option.`);
  }

  /** Reads the remote's ComfyUI. Works in every mode: it only reads. */
  async check(input: string): Promise<RemoteCheck> {
    const url = normalizeRemoteUrl(input);
    const { recipes } = await this.d.reloadRecipes();
    const result = await checkRemote(url, { recipes, workflowsDir: this.d.workflowsDir });
    if (result.hardware && url === this.current) {
      this.state.hardware = { url, profile: result.hardware };
      await this.save();
    }
    return result;
  }

  /**
   * On engine start, before the installer resumes: send work where Settings.remote says. The remote may be away right
   * now (a shared box busy with other work); jobs wait for it.
   */
  async load(): Promise<void> {
    const saved = (await readJson<RemoteState>(this.statePath).catch(() => undefined)) ?? {};
    const profile = HardwareProfileSchema.safeParse(saved.hardware?.profile);
    this.state = { localTier: saved.localTier ?? null, ...(profile.success && saved.hardware ? { hardware: { url: saved.hardware.url, profile: profile.data } } : {}) };
    const remote = this.d.settings.get().remote;
    if (!remote) return;
    if (!(this.d.runtime instanceof RuntimeSwitch)) {
      this.d.log(`settings name the GPU computer ${remote.url}, but this engine runs in ${this.d.runtime.mode} mode; it is not used`);
      return;
    }
    this.d.runtime.select(remote.url);
    this.d.log(`jobs go to the GPU computer at ${remote.url}`);
  }

  /**
   * Sends all work to the ComfyUI at `url` with `tier`'s workflows. Stops this machine's ComfyUI once the job on it is
   * done, starts comfy-api-proxy here pointed there, and fetches only the editor's tools if they are missing. Refused when
   * the address answers but is not ComfyUI; one that does not answer now is taken (jobs wait for it).
   */
  async use(req: RemoteUseRequest): Promise<RuntimeStatus> {
    const sw = this.switcher();
    const url = normalizeRemoteUrl(req.url);
    await this.d.reloadRecipes();
    if (!this.d.installer.recipe(req.tier)) throw notFound(`No recipe for tier ${req.tier}`);
    if (this.d.installer.busy) throw conflict("An install is running. Wait for it to finish, then try again.");
    let hardware: HardwareProfile | undefined;
    try {
      hardware = hardwareFromStats(await readSystemStats(url, 5000));
    } catch (err) {
      if (err instanceof NotComfyError) throw conflict(`${remoteLabel(url)} answers, but it is not ComfyUI. Check the address and the port.`);
      this.d.log(`${url} is not answering right now (${errorMessage(err)}); jobs will wait for it`);
    }
    const name = remoteName(hardware ?? null, url);
    const before = this.d.settings.get();
    if (sw.mode !== "remote") this.state.localTier = before.tier;
    if (hardware) this.state.hardware = { url, profile: hardware };
    await this.save();
    await this.d.settings.update({ remote: { url, name }, tier: req.tier });
    sw.select(url);
    this.d.log(`using the GPU computer ${name} at ${url} with tier ${req.tier}`);
    // Stops what ran before (after its job), fetches what this machine lacks, starts the proxy.
    this.d.installer.start(req.tier, before.memoryLimitGb);
    return sw.status();
  }

  /** Back to this machine: its own install if it has one, else not_installed. */
  async forget(): Promise<RuntimeStatus> {
    const sw = this.switcher();
    if (sw.mode !== "remote" && !this.d.settings.get().remote) return sw.status();
    // An install under way is the remote's (editor tools); it would start the remote again when done.
    if (this.d.installer.busy) await this.d.installer.stop();
    const tier = await this.localTier();
    await this.d.settings.update({ remote: null, tier });
    sw.select(null);
    this.d.log(`jobs go to this machine again${tier ? ` (tier ${tier})` : ""}`);
    if (!tier) sw.setPhase("not_installed", null);
    void this.d
      .exclusive(async () => {
        await sw.release();
        await this.d.installer.resume();
      })
      .catch((err) => this.d.log(`could not go back to this machine: ${errorMessage(err)}`));
    return sw.status();
  }

  /** The tier this machine ran before, else the latest one installed here. */
  private async localTier(): Promise<string | null> {
    const usable = (t: string | null | undefined): t is string => !!t && this.d.installer.isInstalled(t) && !!this.d.installer.recipe(t);
    return [this.state.localTier, this.d.settings.get().tier, ...this.d.installer.installedTiers()].find(usable) ?? null;
  }
}
