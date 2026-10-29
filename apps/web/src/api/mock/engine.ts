import type {
  Asset,
  ExportRequest,
  Caption,
  Event as EngineEvent,
  HardwareProfile,
  InstallPlan,
  Job,
  Onboarding,
  OnboardingSample,
  Project,
  RemoteCheck,
  RuntimeStatus,
  Settings,
  Shot,
  StillRequest,
  StepId,
  Take,
  TierId,
  TierSummary,
  Timeline,
} from "@nightshift/contract";
import { id } from "@/lib/ids";
import { kindForPrompt, mockUrl, type SceneKind } from "@/media/placeholder";
import { hardwarePresets, mockTiers, rankTiers } from "./data";
import { fallbackShots, finalFor, quickEffects, scriptLines } from "@nightshift/contract";
import { genres, looks } from "@nightshift/contract";
import type { AudioBody, CreateProjectBody, FinalBody, ProjectPatch } from "../client";

// ---------------------------------------------------------------- types

export type Speed = "quick" | "realistic";

export interface Faults {
  /** `GET /api/hardware` fails, so onboarding falls back to manual entry. */
  detectFails: boolean;
  /** The next install stops: disk full at 70%, or the network drops at 40%. */
  installFail: null | "disk" | "network";
  /** The next job that starts fails this way. Clears after it fires. */
  nextJobFail: null | "oom" | "crash";
  /** Every call fails as if the engine were down and the event stream drops. */
  unreachable: boolean;
  /** Attached to a shared GPU that is away: the engine answers, GPU jobs wait, exports and analysis still run. */
  gpuAway: boolean;
  /** Another app holds 3.5 GB of this machine's GPU (RuntimeStatus.otherGpuUse). The engine says so only during a render; the mock always. */
  gpuShared: boolean;
}

export type RemoteFixture = "reachable" | "unreachable" | "missing";

export interface DevSettings {
  speed: Speed;
  preset: string;
  faults: Faults;
  /** Treat "now" as inside the overnight window, so overnight jobs run. */
  simulateNight: boolean;
  /** What the fake GPU computer on the network answers: ready, nothing there, or models missing. */
  remote: RemoteFixture;
}

interface InstallState {
  tier: TierId;
  queue: string[]; // model ids left to download
  current: string | null;
  doneGb: number;
  totalGb: number;
  currentDoneGb: number;
  startedAt: number;
}

interface State {
  hardware: HardwareProfile | null;
  settings: Settings;
  runtime: RuntimeStatus;
  install: InstallState | null;
  present: string[]; // model ids on disk
  projects: Project[];
  jobs: Job[];
  /** Browser media sources by asset id. Asset.path stays a project-relative file path. */
  uploads: Record<string, string>;
  overnightForced: boolean;
  /** The setup installed on this machine, kept while a remote computer is in use so "Use this Mac" can come back to it. */
  localTier: TierId | null;
  /** Like the engine's onboarding.json: setup done, the First shot sample, and the draft queued for it. */
  onboarding: Onboarding & { draftJobId?: string };
}

const STATE_KEY = "nightshift.mock.state.v1";
const DEV_KEY = "nightshift.mock.dev.v1";

const defaultDev: DevSettings = {
  speed: "quick",
  preset: "m4max",
  faults: { detectFails: false, installFail: null, nextJobFail: null, unreachable: false, gpuAway: false, gpuShared: false },
  simulateNight: false,
  remote: "reachable",
};

function freshState(): State {
  return {
    hardware: null,
    settings: { tier: null, memoryLimitGb: null, overnight: { enabled: true, startAt: "23:00", endAt: "07:00" } },
    runtime: { mode: "mock", phase: "not_installed", tier: null, comfyui: { running: false, url: null, version: null }, memoryUsedGb: null },
    install: null,
    present: [],
    projects: [],
    jobs: [],
    uploads: {},
    overnightForced: false,
    localTier: null,
    onboarding: { done: false, sampleProjectId: null },
  };
}

/** The First shot sample, as the engine makes it. */
const SAMPLE = { name: "First shot", template: "cinematic_shot", aspect: "16:9", brief: { idea: "A lone lighthouse on a cliff as a storm rolls in, waves hitting the rocks", cameraMove: "dolly_in", look: "dawn", sequence: "one" } } as const;

const now = () => new Date().toISOString();

/** Seconds a step takes in quick mode. Realistic mode uses the tier's estimates instead. */
const quickSeconds: Record<StepId | "export", number> = {
  text: 4,
  still: 5,
  video_draft: 14,
  video_final_same_take: 26,
  video_final_remaster: 44,
  voice: 6,
  music: 10,
  camera_layout: 6,
  video_camera_move: 16,
  effect_end_frame: 6,
  video_effect: 16,
  video_what_if: 18,
  export: 9,
};

const WAITING_FOR_GPU = "Waiting for the GPU";

/** Steps that need the GPU. Exports and analysis jobs run on the CPU beside it. */
const needsGpu = (job: Pick<Job, "step" | "analysis">) => job.step !== "export" && !job.analysis;

const analysisMessages: Record<"music" | "voice", string[]> = {
  music: ["Reading the song", "Finding the beats", "Fitting the cut", "Saving"],
  voice: ["Listening", "Timing the words", "Fitting the cut", "Saving"],
};

const stepMessages: Record<StepId | "export", string[]> = {
  text: ["Reading your brief", "Writing the shot list", "Checking timing", "Saving"],
  still: ["Loading the image model", "Reading the prompt", "Step {i} of 8", "Decoding", "Saving"],
  video_draft: ["Loading the video model", "Encoding the still", "Step {i} of 8", "Decoding video", "Saving the take"],
  video_final_same_take: ["Loading the video model", "Loading your take", "Upscaling, step {i} of 3", "Smoothing motion", "Decoding video", "Saving"],
  video_final_remaster: ["Loading the final model", "Studying your take", "Step {i} of 8", "Decoding video", "Saving"],
  voice: ["Loading the voice", "Reading the script", "Speaking", "Aligning words", "Saving"],
  music: ["Loading the music model", "Reading the brief", "Composing", "Mixing", "Saving"],
  camera_layout: ["Reading depth from the photo", "Building the scene", "Flying the camera", "Saving"],
  video_camera_move: ["Loading the video model", "Following the camera path", "Step {i} of 8", "Decoding video", "Saving"],
  effect_end_frame: ["Loading the image model", "Painting the after image", "Saving"],
  video_effect: ["Loading the video model", "Animating the effect", "Step {i} of 8", "Decoding video", "Saving"],
  video_what_if: ["Loading the video model", "Reading four keyframes", "Step {i} of 8", "Decoding the film", "Saving the take"],
  export: ["Laying out the timeline", "Rendering captions", "Encoding video", "Mixing audio", "Writing the file"],
};

function messagesFor(job: Pick<Job, "step" | "analysis">): string[] {
  if (job.analysis && (job.step === "music" || job.step === "voice")) return analysisMessages[job.step];
  return stepMessages[job.step];
}

type Listener = (e: EngineEvent) => void;

// ---------------------------------------------------------------- engine

export class MockEngine {
  state: State;
  dev: DevSettings;
  private listeners = new Set<Listener>();
  private connListeners = new Set<(c: boolean) => void>();
  private timer: number | null = null;
  private lastTick = performance.now();
  private persistTimer: number | null = null;
  private lastJobEmit = new Map<string, number>();

  constructor() {
    this.dev = loadJson<DevSettings>(DEV_KEY) ?? { ...defaultDev };
    this.dev = { ...defaultDev, ...this.dev, faults: { ...defaultDev.faults, ...this.dev.faults } };
    this.applyUrlParams();
    this.state = loadJson<State>(STATE_KEY) ?? freshState();
    this.state.localTier ??= null;
    this.state.onboarding ??= { done: this.state.projects.length > 0, sampleProjectId: this.state.projects.find((p) => p.name === SAMPLE.name && p.brief.idea === SAMPLE.brief.idea)?.id ?? null };
    this.state.settings.remote ??= null;
    this.state.runtime.mode = this.state.settings.remote && this.state.runtime.phase === "ready" ? "remote" : "mock";
    for (const p of this.state.projects) if (!p.timeline?.edited) p.timeline = buildTimeline(p);
    for (const project of this.state.projects) this.storeMediaSources(project);
    // Jobs that were running when the page closed keep running.
    this.timer = window.setInterval(() => this.tick(), 120);
    // For QA scripts: window.nightshiftMock.finishRunningNow(), .setDev({...}), .resetAll()
    (window as unknown as { nightshiftMock?: MockEngine }).nightshiftMock = this;
  }

  // ------------------------------------------------------------ dev controls

  private applyUrlParams() {
    const raw = new URLSearchParams(window.location.search).get("mock");
    if (!raw) return;
    for (const part of raw.split(",")) {
      const [k, v] = part.split(":");
      if (k === "reset") {
        for (const key of Object.keys(localStorage)) if (key.startsWith("nightshift.") && key !== DEV_KEY && key !== "nightshift.api") localStorage.removeItem(key);
      } else if (k === "hw" && v && hardwarePresets[v]) {
        this.dev.preset = v;
      } else if (k === "speed" && (v === "quick" || v === "realistic")) {
        this.dev.speed = v;
      } else if (k === "fail") {
        if (v === "detect") this.dev.faults.detectFails = true;
        if (v === "install-disk") this.dev.faults.installFail = "disk";
        if (v === "install-network") this.dev.faults.installFail = "network";
        if (v === "oom") this.dev.faults.nextJobFail = "oom";
        if (v === "crash") this.dev.faults.nextJobFail = "crash";
        if (v === "unreachable") this.dev.faults.unreachable = true;
        if (v === "gpu") this.dev.faults.gpuAway = true;
        if (v === "gpu-shared") this.dev.faults.gpuShared = true;
      } else if (k === "remote" && (v === "reachable" || v === "unreachable" || v === "missing")) {
        this.dev.remote = v;
      } else if (k === "night") {
        this.dev.simulateNight = true;
      }
    }
    saveJson(DEV_KEY, this.dev);
  }

  setDev(patch: Partial<DevSettings>) {
    const was = this.dev.faults;
    this.dev = { ...this.dev, ...patch, faults: { ...this.dev.faults, ...(patch.faults ?? {}) } };
    saveJson(DEV_KEY, this.dev);
    if (was.unreachable !== this.dev.faults.unreachable) {
      for (const l of this.connListeners) l(!this.dev.faults.unreachable);
      if (!this.dev.faults.unreachable) this.emit({ type: "runtime", status: this.status() });
    }
    if (was.gpuAway !== this.dev.faults.gpuAway) {
      // Queued GPU jobs say what they wait for while the GPU is away, and go quiet again when it is back.
      for (const job of this.state.jobs) {
        if (job.status !== "queued" || !needsGpu(job)) continue;
        const { message: _, ...rest } = job;
        this.setJob(this.dev.faults.gpuAway ? { ...job, message: WAITING_FOR_GPU } : rest);
      }
      this.emit({ type: "runtime", status: this.status() });
    }
    if (was.gpuShared !== this.dev.faults.gpuShared) this.emit({ type: "runtime", status: this.status() });
  }

  resetAll() {
    localStorage.removeItem(STATE_KEY);
    localStorage.removeItem("nightshift.overnightSeen");
    this.state = freshState();
    this.persist();
    window.location.replace(window.location.pathname);
  }

  /** Skip the wait: finish whatever is running right now. */
  finishRunningNow() {
    const job = this.state.jobs.find((j) => j.status === "running");
    if (job) this.completeJob(job);
    if (this.state.install) {
      this.state.install.doneGb = this.state.install.totalGb;
      this.state.install.queue = [];
      this.state.install.currentDoneGb = 0;
      this.state.install.current = null;
      this.finishInstall();
    }
  }

  // ------------------------------------------------------------ events

  subscribe(onEvent: Listener, onConnection?: (c: boolean) => void): () => void {
    this.listeners.add(onEvent);
    if (onConnection) {
      this.connListeners.add(onConnection);
      queueMicrotask(() => onConnection(!this.dev.faults.unreachable));
    }
    return () => {
      this.listeners.delete(onEvent);
      if (onConnection) this.connListeners.delete(onConnection);
    };
  }

  private emit(e: EngineEvent) {
    if (this.dev.faults.unreachable) return;
    for (const l of this.listeners) l(e);
    this.schedulePersist();
  }

  private schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = window.setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, 400);
  }

  private persist() {
    saveJson(STATE_KEY, this.state);
  }

  // ------------------------------------------------------------ hardware and tiers

  hardware(): HardwareProfile {
    if (this.state.hardware?.source === "manual" || (this.state.hardware?.source === "remote" && this.state.settings.remote)) return this.state.hardware;
    if (this.dev.faults.detectFails) throw new MockHttpError(500, "Could not read the GPU. The driver did not answer.");
    const preset = hardwarePresets[this.dev.preset] ?? hardwarePresets.m4max!;
    this.state.hardware = preset.profile;
    this.schedulePersist();
    return preset.profile;
  }

  setHardwareManual(p: HardwareProfile): HardwareProfile {
    this.state.hardware = { ...p, source: "manual" };
    this.schedulePersist();
    return this.state.hardware;
  }

  tiers(): TierSummary[] {
    return rankTiers(this.state.hardware);
  }

  installPlan(tier: TierId): InstallPlan {
    const t = mockTiers.find((x) => x.tier === tier);
    if (!t) throw new MockHttpError(404, `Unknown tier ${tier}`);
    const downloads = t.models.filter((m) => !this.state.present.includes(m.id));
    const totalDownloadGb = round1(downloads.reduce((s, m) => s + m.sizeGb, 0));
    const freeDiskGb = this.state.hardware?.freeDiskGb ?? 0;
    return {
      tier,
      downloads,
      alreadyPresent: t.models.filter((m) => this.state.present.includes(m.id)).map((m) => m.id),
      totalDownloadGb,
      freeDiskGb,
      fits: true,
      simulated: true,
      notes: ["Demo setup. No models or tools are downloaded."],
    };
  }

  install(body: { tier: TierId; memoryLimitGb: number | null }) {
    const plan = this.installPlan(body.tier);
    this.state.settings = { ...this.state.settings, tier: body.tier, memoryLimitGb: body.memoryLimitGb };
    this.state.install = {
      tier: body.tier,
      queue: plan.downloads.map((m) => m.id),
      current: null,
      doneGb: 0,
      totalGb: plan.totalDownloadGb,
      currentDoneGb: 0,
      startedAt: Date.now(),
    };
    this.setRuntime({ phase: "installing", tier: body.tier, error: undefined });
    this.emit({ type: "install", progress: { modelId: null, doneGb: 0, totalGb: plan.totalDownloadGb, message: "Starting the download" } });
  }

  private setRuntime(patch: Partial<RuntimeStatus>) {
    this.state.runtime = { ...this.state.runtime, ...patch };
    this.emit({ type: "runtime", status: this.status() });
  }

  status(): RuntimeStatus {
    const runtime = this.state.runtime;
    const remote = this.state.settings.remote;
    if (this.dev.faults.gpuAway && runtime.phase === "ready") {
      if (remote) return { ...runtime, mode: "remote", comfyui: { ...runtime.comfyui, running: false, version: null }, memoryUsedGb: null, error: `${remote.name ?? remote.url} is not answering` };
      return { ...runtime, mode: "attach", comfyui: { ...runtime.comfyui, running: false, version: null }, memoryUsedGb: null, error: "comfy-api-proxy at http://127.0.0.1:8191 is not answering" };
    }
    // Like the engine: only this machine's own GPU, never a GPU computer on the network.
    if (this.dev.faults.gpuShared && runtime.phase === "ready" && runtime.comfyui.running && !remote) return { ...runtime, otherGpuUse: { usedGb: 3.5, apps: ["python"] } };
    return runtime;
  }

  // ------------------------------------------------------------ a GPU computer on the network

  /** Normalizes what the user typed: "spark", "spark:8190", "http://spark:8190/". Default port 8190. */
  private remoteUrl(input: string): string {
    const raw = input.trim();
    if (!raw) throw new MockHttpError(400, "Type the computer's name or address.");
    const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`;
    let url: URL;
    try {
      url = new URL(withScheme);
    } catch {
      throw new MockHttpError(400, `"${raw}" is not an address Nightshift can use. Try a name like spark, or spark:8190.`);
    }
    if (!url.port) url.port = "8190";
    return `${url.protocol}//${url.host}`;
  }

  remoteCheck(input: string): RemoteCheck {
    const url = this.remoteUrl(input);
    const host = new URL(url).hostname;
    if (this.dev.remote === "unreachable") {
      return { url, reachable: false, comfyuiVersion: null, hardware: null, recommendedTier: null, missingNodes: [], missingModels: [], error: `Nothing answered at ${url}. Check the address, and that ComfyUI is running on ${host}.` };
    }
    const profile: HardwareProfile = { ...hardwarePresets.spark!.profile, source: "remote" };
    const recommended = rankTiers(profile).find((t) => t.recommended)?.tier ?? null;
    const missing = this.dev.remote === "missing";
    return {
      url,
      reachable: true,
      name: host === "spark" ? "NVIDIA GB10" : host,
      comfyuiVersion: "0.41.3",
      hardware: profile,
      recommendedTier: recommended,
      missingNodes: missing ? ["ComfyUI-LTXVideo"] : [],
      missingModels: missing ? ["ltx-2.5-22b-distilled-int8.safetensors", "krea-2-bf16.safetensors"] : [],
    };
  }

  remoteUse(body: { url: string; tier: TierId }): RuntimeStatus {
    const check = this.remoteCheck(body.url);
    if (!check.reachable) throw new MockHttpError(502, check.error ?? "That computer is not answering.");
    if (!mockTiers.some((t) => t.tier === body.tier)) throw new MockHttpError(404, `Unknown tier ${body.tier}`);
    if (this.state.runtime.phase === "ready" && !this.state.settings.remote && this.state.settings.tier) this.state.localTier = this.state.settings.tier;
    this.state.hardware = check.hardware;
    this.state.install = null;
    this.state.settings = { ...this.state.settings, tier: body.tier, remote: { url: check.url, name: check.name } };
    this.setRuntime({ phase: "ready", tier: body.tier, mode: "remote", error: undefined, comfyui: { running: true, url: check.url, version: check.comfyuiVersion }, memoryUsedGb: null });
    this.schedulePersist();
    return this.status();
  }

  remoteForget(): RuntimeStatus {
    const local = this.state.localTier;
    this.state.hardware = null;
    this.state.settings = { ...this.state.settings, remote: null, tier: local };
    if (local) this.setRuntime({ phase: "ready", tier: local, mode: "mock", error: undefined, comfyui: { running: true, url: "http://127.0.0.1:8188", version: "0.41.3" }, memoryUsedGb: 0 });
    else this.setRuntime({ phase: "not_installed", tier: null, mode: "mock", error: undefined, comfyui: { running: false, url: null, version: null }, memoryUsedGb: null });
    this.schedulePersist();
    return this.status();
  }

  settings(): Settings {
    return this.state.settings;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    this.state.settings = { ...this.state.settings, ...patch, overnight: { ...this.state.settings.overnight, ...(patch.overnight ?? {}) } };
    this.schedulePersist();
    return this.state.settings;
  }

  // ------------------------------------------------------------ projects

  listProjects(): Project[] {
    return this.state.projects;
  }

  getProject(pid: string): Project {
    const p = this.state.projects.find((x) => x.id === pid);
    if (!p) throw new MockHttpError(404, "Project not found");
    return p;
  }

  // ------------------------------------------------------------ onboarding

  onboarding(): Onboarding {
    return { done: this.state.onboarding.done, sampleProjectId: this.state.onboarding.sampleProjectId };
  }

  finishOnboarding(): Onboarding {
    if (!this.state.onboarding.done) this.setOnboarding({ ...this.state.onboarding, done: true });
    return this.onboarding();
  }

  /** Made once; later calls return the same project. A deleted sample stays deleted, unless `again`. */
  startSample(again: boolean): OnboardingSample {
    const { done, sampleProjectId } = this.state.onboarding;
    if (!again && (sampleProjectId !== null || done)) return { onboarding: this.onboarding(), project: this.state.projects.find((p) => p.id === sampleProjectId) ?? null };
    const p = this.makeProject({ ...SAMPLE, brief: { ...SAMPLE.brief } });
    this.setOnboarding({ done, sampleProjectId: p.id });
    this.storyboard(p.id);
    return { onboarding: this.onboarding(), project: p };
  }

  private setOnboarding(next: State["onboarding"]) {
    this.state.onboarding = next;
    this.persist();
    this.emit({ type: "onboarding", onboarding: this.onboarding() });
  }

  /** A project of the user's own: setup is behind them. */
  createProject(body: CreateProjectBody): Project {
    const p = this.makeProject(body);
    this.finishOnboarding();
    return p;
  }

  private makeProject(body: CreateProjectBody): Project {
    const t = now();
    const p: Project = {
      id: id("prj"),
      name: body.name,
      template: body.template,
      aspect: body.aspect,
      brief: body.brief,
      shots: [],
      takes: [],
      assets: [],
      timeline: null,
      createdAt: t,
      updatedAt: t,
    };
    this.state.projects = [p, ...this.state.projects];
    this.emit({ type: "project", project: p });
    return p;
  }

  updateProject(pid: string, patch: ProjectPatch): Project {
    const p = this.getProject(pid);
    const next: Project = { ...p, ...patch, updatedAt: now() };
    if (patch.references !== undefined) {
      const refs = patch.references;
      if (refs.length > 6 || new Set(refs.map(r => r.id)).size !== refs.length) throw new MockHttpError(400, "Choose up to six different references.");
      for (const r of refs) if (!r.label.trim() || !p.assets.some(a => a.id === r.assetId && a.kind === "image" && a.role === "reference")) throw new MockHttpError(400, "Each reference needs a name and an uploaded photo.");
      if (!patch.shots) next.shots = p.shots.map(shot => shot.referenceIds ? { ...shot, referenceIds: shot.referenceIds.filter(id => refs.some(r => r.id === id)) } : shot);
      if (p.template === "product_ad") next.brief = { ...next.brief, referenceAssetId: refs.find(r => r.kind === "product")?.assetId };
    }
    if (patch.brief && typeof patch.brief.referenceAssetId === "string" && patch.brief.referenceAssetId !== p.brief.referenceAssetId) {
      const asset = p.assets.find(a => a.id === patch.brief?.referenceAssetId && a.kind === "image");
      if (asset) next.references = [...(next.references ?? []), { id: id("ref"), assetId: asset.id, kind: p.template === "product_ad" ? "product" : "style", label: String(patch.brief.productName || "Reference photo") }];
    }
    if (patch.shots) for (const shot of patch.shots) if (shot.referenceIds && (shot.referenceIds.length > 3 || new Set(shot.referenceIds).size !== shot.referenceIds.length || shot.referenceIds.some(id => !(next.references ?? []).some(r => r.id === id)))) throw new MockHttpError(400, "Choose up to three project references per shot.");
    if (patch.shots) next.shots = patch.shots.map((s, i) => ({ ...mergedShot(p, s), index: i }));
    if (patch.timeline && patch.timeline.edited !== false) {
      const fields = ["clips", "audio", "captions", "overlays", "markers"] as const;
      next.timeline = { ...patch.timeline, edited: p.timeline?.edited || fields.some((key) => JSON.stringify(patch.timeline?.[key] ?? []) !== JSON.stringify(p.timeline?.[key] ?? [])) };
    }
    if (patch.timeline === null || patch.timeline?.edited === false || !next.timeline?.edited) next.timeline = buildTimeline(next);
    this.replaceProject(next);
    return next;
  }

  deleteProject(pid: string) {
    this.state.projects = this.state.projects.filter((p) => p.id !== pid);
    this.state.jobs = this.state.jobs.filter((j) => j.projectId !== pid);
    this.persist();
  }

  deleteAsset(pid: string, assetId: string): void {
    const p = this.getProject(pid);
    const asset = p.assets.find(a => a.id === assetId);
    if (!asset) throw new MockHttpError(404, "Reference not found");
    if (asset.role !== "reference") throw new MockHttpError(409, "Only uploaded references can be removed here.");
    if (this.state.jobs.some(j => j.projectId === pid && (j.status === "queued" || j.status === "running"))) throw new MockHttpError(409, "Wait for this project's jobs to finish before removing a reference.");
    const removed = (p.references ?? []).filter(r => r.assetId === assetId).map(r => r.id);
    const brief = { ...p.brief };
    for (const key of ["referenceAssetId", "productAssetId"]) if (brief[key] === assetId) delete brief[key];
    this.replaceProject({ ...p, brief, references: (p.references ?? []).filter(r => r.assetId !== assetId), assets: p.assets.filter(a => a.id !== assetId), shots: p.shots.map(s => s.referenceIds ? { ...s, referenceIds: s.referenceIds.filter(id => !removed.includes(id)) } : s) });
    delete this.state.uploads[assetId];
  }

  uploadAsset(pid: string, dataUrl: string, kind: Asset["kind"], meta: Partial<Asset>): Asset {
    const p = this.getProject(pid);
    const asset: Asset = { id: id("ast"), kind, path: dataUrl, createdAt: now(), ...meta };
    this.state.uploads[asset.id] = dataUrl;
    const next = { ...p, assets: [...p.assets, asset], updatedAt: now() };
    this.storeMediaSources(next);
    this.replaceProject(next);
    return asset;
  }

  assetUrl(pid: string, assetId: string): string {
    const asset = this.state.projects.find((p) => p.id === pid)?.assets.find((a) => a.id === assetId);
    return asset ? this.state.uploads[assetId] ?? asset.path : `mock:missing:${assetId}`;
  }

  private storeMediaSources(project: Project) {
    for (const asset of project.assets) {
      if (!/^(mock:|data:|blob:)/.test(asset.path)) continue;
      this.state.uploads[asset.id] = asset.path;
      const ext = asset.kind === "image" ? "png" : asset.kind === "video" ? "mp4" : asset.kind === "audio" ? "wav" : "bin";
      asset.path = `assets/${asset.id}.${ext}`;
    }
  }

  private replaceProject(next: Project) {
    this.state.projects = this.state.projects.map((p) => (p.id === next.id ? next : p));
    this.emit({ type: "project", project: next });
  }

  // ------------------------------------------------------------ jobs

  listJobs(): Job[] {
    return this.state.jobs;
  }

  private requireReady() {
    if (this.state.runtime.phase !== "ready") throw new MockHttpError(409, "The engine is not ready yet.");
  }

  private enqueue(partial: Pick<Job, "projectId" | "step"> & Partial<Job>): Job {
    this.requireReady();
    const job: Job = {
      id: id("job"),
      status: "queued",
      progress: 0,
      mode: "now",
      outputAssetIds: [],
      createdAt: now(),
      ...partial,
    };
    if (this.dev.faults.gpuAway && needsGpu(job)) job.message = WAITING_FOR_GPU;
    this.state.jobs = [...this.state.jobs, job];
    this.emit({ type: "job", job });
    return job;
  }

  storyboard(pid: string): Job {
    const p = this.getProject(pid);
    if (p.template === "vfx_effect") {
      if (!p.assets.some((a) => a.id === p.brief.photoAssetId && a.kind === "image")) throw new MockHttpError(409, "Add a photo to this Effect project first.");
      if (!quickEffects.some((e) => e.id === p.brief.effect)) throw new MockHttpError(409, "Choose an effect from the gallery.");
    }
    return this.enqueue({ projectId: pid, step: "text", message: "Waiting" });
  }

  still(pid: string, shotId: string, body?: StillRequest): Job {
    this.getProject(pid);
    const job = this.enqueue({ projectId: pid, shotId, step: "still" });
    (job as Job & { keyframeIndex?: number }).keyframeIndex = body?.keyframeIndex;
    return job;
  }

  draft(pid: string, shotId: string, body?: { seed?: number }): Job {
    const p = this.getProject(pid);
    const shot = p.shots.find((s) => s.id === shotId);
    if (!shot) throw new MockHttpError(404, "Shot not found");
    if (!shot.stillAssetId) throw new MockHttpError(409, "Make a still first.");
    const job = this.enqueue({ projectId: pid, shotId, step: p.template === "what_if" ? "video_what_if" : p.template === "vfx_effect" ? "video_effect" : p.template === "camera_move" ? "video_camera_move" : "video_draft" });
    (job as Job & { seed?: number }).seed = body?.seed ?? Math.floor(Math.random() * 1e9);
    return job;
  }

  final(pid: string, shotId: string, body: FinalBody): Job {
    const p = this.getProject(pid);
    if (p.template === "what_if" && body.kind === "remaster") throw new MockHttpError(409, "What-if films finish from their saved take.");
    const take = p.takes.find((t) => t.id === body.draftId);
    if (!take) throw new MockHttpError(404, "Take not found");
    const step: StepId = body.kind === "remaster" ? "video_final_remaster" : "video_final_same_take";
    const tier = mockTiers.find((t) => t.tier === this.state.settings.tier);
    if (tier && tier.steps && !tier.steps.includes(step)) throw new MockHttpError(409, "This machine can only do same-take finals.");
    const job = this.enqueue({ projectId: pid, shotId, step, mode: body.mode });
    (job as Job & { parent?: string }).parent = take.id;
    return job;
  }

  audio(pid: string, body: AudioBody): Job {
    this.getProject(pid);
    const job = this.enqueue({ projectId: pid, step: body.role === "music" ? "music" : "voice" });
    (job as Job & { audioBody?: AudioBody }).audioBody = body;
    return job;
  }

  exportVideo(pid: string, body: ExportRequest): Job {
    const project = this.getProject(pid);
    if (body.kind === "reveal") {
      // One shot's share clip: the job carries the shot and the asset is filed with role "reveal".
      const shot = body.shotId ? project.shots.find((s) => s.id === body.shotId) : project.shots.length === 1 ? project.shots[0] : undefined;
      if (!shot) throw new MockHttpError(400, "Say which shot to reveal (shotId): this project has several.");
      const final = project.takes.find((t) => t.id === shot.chosenFinalId);
      if (!final) throw new MockHttpError(409, "This shot has no final yet. Finish it first, then share the reveal.");
      const job = this.enqueue({ projectId: pid, step: "export", shotId: shot.id });
      (job as Job & { aspect?: Project["aspect"] }).aspect = body.aspect;
      (job as Job & { reveal?: boolean }).reveal = true;
      return job;
    }
    if (body.rebuild || !project.timeline?.edited) this.replaceProject({ ...project, timeline: buildTimeline(project) });
    const job = this.enqueue({ projectId: pid, step: "export" });
    (job as Job & { quality?: ExportRequest["quality"] }).quality = body.quality;
    (job as Job & { aspect?: Project["aspect"] }).aspect = body.aspect;
    return job;
  }

  cancelJob(jid: string): Job {
    const job = this.state.jobs.find((j) => j.id === jid);
    if (!job) throw new MockHttpError(404, "Job not found");
    if (job.status === "queued" || job.status === "running") {
      const next: Job = { ...job, status: "cancelled", finishedAt: now(), message: "Cancelled" };
      this.setJob(next);
      return next;
    }
    return job;
  }

  private setJob(next: Job) {
    this.state.jobs = this.state.jobs.map((j) => (j.id === next.id ? next : j));
    this.emit({ type: "job", job: next });
  }

  // ------------------------------------------------------------ the clock

  private nightNow(): boolean {
    if (this.dev.simulateNight || this.state.overnightForced) return true;
    const { enabled, startAt, endAt } = this.state.settings.overnight;
    if (!enabled) return false;
    const d = new Date();
    const cur = d.getHours() * 60 + d.getMinutes();
    const [sh, sm] = startAt.split(":").map(Number);
    const [eh, em] = endAt.split(":").map(Number);
    const start = (sh ?? 23) * 60 + (sm ?? 0);
    const end = (eh ?? 7) * 60 + (em ?? 0);
    return start < end ? cur >= start && cur < end : cur >= start || cur < end;
  }

  /** "Run the overnight queue now": used from the finals screen. */
  startOvernightNow() {
    this.state.overnightForced = true;
    this.schedulePersist();
  }

  private tick() {
    const t = performance.now();
    const dt = Math.min(2, (t - this.lastTick) / 1000);
    this.lastTick = t;
    if (this.dev.faults.unreachable) return;
    this.tickInstall(dt);
    this.tickJobs(dt);
  }

  private tickInstall(dt: number) {
    const inst = this.state.install;
    if (!inst || this.state.runtime.phase !== "installing") return;
    const tier = mockTiers.find((x) => x.tier === inst.tier)!;
    const rate = this.dev.speed === "quick" ? Math.max(0.5, inst.totalGb / 28) : 0.06; // GB per second
    let budget = rate * dt;
    while (budget > 0) {
      if (!inst.current) {
        const nextId = inst.queue.shift();
        if (!nextId) break;
        inst.current = nextId;
        inst.currentDoneGb = 0;
      }
      const m = tier.models.find((x) => x.id === inst.current)!;
      const left = m.sizeGb - inst.currentDoneGb;
      const step = Math.min(left, budget);
      inst.currentDoneGb += step;
      inst.doneGb += step;
      budget -= step;
      if (inst.currentDoneGb >= m.sizeGb - 1e-6) {
        this.state.present.push(m.id);
        inst.current = null;
      }
    }
    const frac = inst.totalGb > 0 ? inst.doneGb / inst.totalGb : 1;
    const fail = this.dev.faults.installFail;
    if (fail === "network" && frac >= 0.4) {
      this.dev.faults.installFail = null;
      saveJson(DEV_KEY, this.dev);
      this.setRuntime({ phase: "error", error: "Lost the connection while downloading. Check your network, then try again. What's already downloaded is kept." });
      return;
    }
    if (fail === "disk" && frac >= 0.7) {
      this.dev.faults.installFail = null;
      saveJson(DEV_KEY, this.dev);
      const need = round1(inst.totalGb - inst.doneGb + 8);
      this.setRuntime({ phase: "error", error: `The disk is full. Free about ${Math.ceil(need)} GB, then try again. What's already downloaded is kept.` });
      return;
    }
    const current = inst.current ? tier.models.find((x) => x.id === inst.current) : undefined;
    const message = current ? `Downloading ${current.name ?? current.filename}` : inst.queue.length ? "Checking files" : "Verifying";
    this.emit({ type: "install", progress: { modelId: inst.current, doneGb: round1(inst.doneGb), totalGb: inst.totalGb, message } });
    if (!inst.current && inst.queue.length === 0) this.finishInstall();
  }

  private finishInstall() {
    this.state.install = null;
    this.setRuntime({ phase: "starting", comfyui: { running: false, url: null, version: null } });
    const delay = this.dev.speed === "quick" ? 3500 : 12000;
    window.setTimeout(() => {
      if (this.state.runtime.phase !== "starting") return;
      this.state.localTier = this.state.settings.tier;
      this.setRuntime({
        phase: "ready",
        comfyui: { running: true, url: "http://127.0.0.1:8190", version: "0.41.3" },
        memoryUsedGb: 2.1,
      });
    }, delay);
  }

  private tickJobs(dt: number) {
    if (this.state.runtime.phase !== "ready") return;
    let running = this.state.jobs.find((j) => j.status === "running");
    if (!running) {
      const night = this.nightNow();
      const queued = this.state.jobs.filter((j) => j.status === "queued" && (!this.dev.faults.gpuAway || !needsGpu(j)));
      // Interactive work first, then overnight finals when the window is open.
      running = queued.find((j) => j.mode === "now") ?? (night ? queued.find((j) => j.mode === "overnight") : undefined);
      if (!running) {
        if (this.state.overnightForced && !queued.some((j) => j.mode === "overnight")) {
          this.state.overnightForced = false;
          this.schedulePersist();
        }
        if (this.state.runtime.memoryUsedGb && this.state.runtime.memoryUsedGb > 2.2) this.setRuntime({ memoryUsedGb: 2.1 });
        return;
      }
      running = { ...running, status: "running", startedAt: now(), progress: 0, message: messagesFor(running)[0] };
      this.setJob(running);
      const tier = mockTiers.find((x) => x.tier === this.state.settings.tier);
      const est = tier?.estimates?.[running.step as StepId]?.peakGb;
      if (est) this.setRuntime({ memoryUsedGb: Math.min(est, (this.state.settings.memoryLimitGb ?? est) * 0.96) });
    }
    const total = this.jobSeconds(running.step, running.analysis);
    const next = Math.min(1, running.progress + dt / total);
    const fail = this.dev.faults.nextJobFail;
    if (fail && next >= 0.58) {
      this.dev.faults.nextJobFail = null;
      saveJson(DEV_KEY, this.dev);
      const tier = mockTiers.find((x) => x.tier === this.state.settings.tier);
      const peak = tier?.estimates?.[running.step as StepId]?.peakGb ?? 30;
      const limit = this.state.settings.memoryLimitGb ?? peak;
      const error =
        fail === "oom"
          ? `Ran out of memory. This step needed about ${Math.ceil(peak)} GB and ${Math.floor(Math.min(limit, peak - 4))} GB was free. Close other apps or raise the memory limit in Settings, then try again.`
          : "The render engine stopped responding and was restarted. Try again.";
      // As the engine says it: a plain message when the card ran out of memory, else "Failed" and the error says why.
      const others = this.status().otherGpuUse;
      const message = fail !== "oom" ? "Failed" : others ? `Ran out of graphics memory. Other apps are using ${others.usedGb} GB${others.apps.length ? ` (${others.apps.join(", ")})` : ""}.` : "Ran out of graphics memory.";
      this.setJob({ ...running, status: "failed", error, finishedAt: now(), message });
      this.setRuntime({ memoryUsedGb: 2.1 });
      return;
    }
    const msgs = messagesFor(running);
    const phase = Math.min(msgs.length - 1, Math.floor(next * msgs.length));
    const stepCount = running.step === "video_final_same_take" ? 3 : 8;
    const message = msgs[phase]!.replace("{i}", String(Math.max(1, Math.min(stepCount, Math.ceil(((next * msgs.length) % 1) * stepCount)))));
    const updated: Job = { ...running, progress: next, message };
    if (next >= 1) {
      this.completeJob(updated);
      return;
    }
    const last = this.lastJobEmit.get(running.id) ?? 0;
    this.state.jobs = this.state.jobs.map((j) => (j.id === updated.id ? updated : j));
    if (performance.now() - last > 240) {
      this.lastJobEmit.set(running.id, performance.now());
      this.emit({ type: "job", job: updated });
    }
  }

  private jobSeconds(step: Job["step"], analysis = false): number {
    if (analysis) return this.dev.speed === "quick" ? 4 : 12;
    if (this.dev.speed === "quick") return quickSeconds[step];
    const tier = mockTiers.find((x) => x.tier === this.state.settings.tier);
    const est = step === "export" ? 40 : tier?.estimates?.[step]?.seconds;
    return est ?? quickSeconds[step] * 6;
  }

  // ------------------------------------------------------------ job results

  private completeJob(job: Job) {
    const p = this.state.projects.find((x) => x.id === job.projectId);
    if (!p) {
      this.setJob({ ...job, status: "failed", error: "Project was deleted", finishedAt: now() });
      return;
    }
    if (job.analysis) {
      // Measured the song or the voice: the cut is refitted to it (the mock's cut needs no measuring).
      this.setJob({ ...job, status: "done", progress: 1, message: "Done", finishedAt: now() });
      return;
    }
    const outputs: string[] = [];
    let next: Project = { ...p, updatedAt: now() };
    const seedOf = (s: string) => Math.abs(hashStr(s)) % 100000;
    const size = aspectSize(p.aspect);
    const paletteFor = (prompt: string): number => {
      const lk = looks.find((l) => l.id === p.brief.look);
      if (lk) return lk.palette;
      const g = genres.find((x) => x.id === p.brief.genre);
      if (g) return g.palette;
      if (p.template === "product_ad") return 6;
      const h = Math.abs(hashStr(prompt));
      return [0, 1, 2, 3, 5, 7][h % 6]!;
    };

    switch (job.step) {
      case "text": {
        // As the engine does: no shot is longer than one draft of this setup makes.
        const longest = mockTiers.find((x) => x.tier === this.state.settings.tier)?.longestShotSec;
        const gen = fallbackShots(p.template, p.brief).map(s => ({ ...s, durationSec: longest ? Math.min(s.durationSec, longest) : s.durationSec, prompt: [s.prompt, ...(p.references ?? []).slice(0, 3).map(r => `Featuring ${r.label}.`)].join(" ") }));
        let planIndex = 0;
        const fresh = (g: (typeof gen)[number]): Shot => ({ id: id("sht"), index: 0, ...g, locked: false });
        const merged: Shot[] = [];
        for (const shot of [...p.shots].sort((a, b) => a.index - b.index)) {
          if (shot.locked) merged.push(shot);
          else if (planIndex < gen.length) merged.push(fresh(gen[planIndex++]!));
        }
        while (planIndex < gen.length) merged.push(fresh(gen[planIndex++]!));
        next.shots = merged.map((s, index) => ({ ...s, index, ...((p.template === "camera_move" || p.template === "vfx_effect") && typeof p.brief.photoAssetId === "string" ? { stillAssetId: p.brief.photoAssetId } : {}) }));
        next.takes = p.takes.filter((t) => next.shots.some((s) => s.id === t.shotId));
        break;
      }
      case "still": {
        const shot = p.shots.find((s) => s.id === job.shotId);
        if (!shot) break;
        if (p.template === "what_if" && shot.keyframes) {
          const assets: Asset[] = [];
          const start = (job as Job & { keyframeIndex?: number }).keyframeIndex ?? 0;
          const keyframes = shot.keyframes.map((frame, index) => {
            if (index < start && frame.stillAssetId) return frame;
            if (index === 0 && typeof p.brief.photoAssetId === "string") return { ...frame, stillAssetId: p.brief.photoAssetId };
            const image: Asset = { id: id("ast"), kind: "image", createdAt: now(), width: size.w, height: size.h,
              path: mockUrl({ kind: kindForPrompt(frame.prompt, p.template), seed: seedOf(frame.prompt + job.id), w: size.w, h: size.h, quality: "still", palette: paletteFor(frame.prompt), move: "static" }) };
            assets.push(image);
            return { ...frame, stillAssetId: image.id };
          });
          next.assets = [...p.assets, ...assets];
          next.shots = [{ ...shot, keyframes, stillAssetId: keyframes[0]!.stillAssetId }];
          outputs.push(...assets.map(asset => asset.id));
          break;
        }
        if (p.template === "vfx_effect") {
          const photo = p.assets.find((a) => a.id === p.brief.photoAssetId && a.kind === "image");
          if (!photo) break;
          next.shots = p.shots.map((s) => s.id === shot.id ? { ...s, stillAssetId: photo.id } : s);
          outputs.push(photo.id);
          break;
        }
        const kind: SceneKind = kindForPrompt(shot.prompt, p.template);
        const asset: Asset = {
          id: id("ast"),
          kind: "image",
          path: mockUrl({ kind, seed: seedOf(shot.id + shot.prompt + job.id), w: size.w, h: size.h, quality: "still", palette: paletteFor(shot.prompt), move: "static" }),
          width: size.w,
          height: size.h,
          createdAt: now(),
        };
        outputs.push(asset.id);
        next.assets = [...p.assets, asset];
        next.shots = p.shots.map((s) => (s.id === shot.id ? { ...s, stillAssetId: asset.id } : s));
        break;
      }
      case "video_effect":
      case "video_what_if":
      case "video_camera_move":
      case "video_draft": {
        const shot = p.shots.find((s) => s.id === job.shotId);
        if (!shot) break;
        const still = p.assets.find((a) => a.id === shot.stillAssetId);
        const url = still ? this.assetUrl(p.id, still.id) : "";
        const base = url.startsWith("mock:") ? url.split(":") : null;
        const seed = (job as Job & { seed?: number }).seed ?? Math.floor(Math.random() * 1e9);
        const kind = (base?.[1] as SceneKind) ?? kindForPrompt(shot.prompt, p.template);
        const sceneSeed = base ? Number(base[2]) + (seed % 7) : seedOf(shot.id + seed);
        const video: Asset = {
          id: id("ast"),
          kind: "video",
          path: mockUrl({ kind, seed: sceneSeed, w: Math.round(size.w / 2), h: Math.round(size.h / 2), quality: "draft", palette: paletteFor(shot.prompt), move: shot.cameraMove ?? "static" }),
          width: Math.round(size.w / 2),
          height: Math.round(size.h / 2),
          durationSec: shot.durationSec,
          createdAt: now(),
        };
        const latent: Asset = { id: id("ast"), kind: "latent", path: `latents/${video.id}.safetensors`, createdAt: now() };
        const take: Take = { id: id("tk"), shotId: shot.id, rung: "draft", seed, videoAssetId: video.id, latentAssetId: latent.id, jobId: job.id };
        if (p.template === "what_if") {
          take.prompt = shot.prompt;
          take.imageAssetId = shot.stillAssetId;
          take.guideAssetIds = shot.keyframes?.flatMap(frame => frame.stillAssetId ? [frame.stillAssetId] : []);
        }
        outputs.push(video.id);
        next.assets = [...p.assets, video, latent];
        next.takes = [...p.takes, take];
        const hasChoice = p.takes.some((t) => t.shotId === shot.id && t.rung === "draft");
        next.shots = p.shots.map((s) => (s.id === shot.id && !hasChoice ? { ...s, chosenDraftId: take.id } : s));
        break;
      }
      case "video_final_same_take":
      case "video_final_remaster": {
        const shot = p.shots.find((s) => s.id === job.shotId);
        const parentId = (job as Job & { parent?: string }).parent;
        const parent = p.takes.find((t) => t.id === parentId) ?? p.takes.find((t) => t.shotId === job.shotId && t.rung === "draft");
        if (!shot || !parent) break;
        const draftAsset = p.assets.find((a) => a.id === parent.videoAssetId);
        const parts = draftAsset ? this.assetUrl(p.id, draftAsset.id).split(":") : undefined;
        const remaster = job.step === "video_final_remaster";
        const video: Asset = {
          id: id("ast"),
          kind: "video",
          path: mockUrl({
            kind: (parts?.[1] as SceneKind) ?? "landscape",
            seed: remaster ? Number(parts?.[2] ?? 1) + 3 : Number(parts?.[2] ?? 1),
            w: size.w,
            h: size.h,
            quality: "final",
            palette: Number(parts?.[5] ?? 0),
            move: shot.cameraMove ?? "static",
          }),
          width: size.w,
          height: size.h,
          durationSec: shot.durationSec,
          createdAt: now(),
        };
        const take: Take = {
          id: id("tk"),
          shotId: shot.id,
          rung: "final",
          finalKind: remaster ? "remaster" : "same_take",
          parentTakeId: parent.id,
          seed: parent.seed,
          videoAssetId: video.id,
          jobId: job.id,
        };
        outputs.push(video.id);
        next.assets = [...p.assets, video];
        next.takes = [...p.takes, take];
        // Like the engine: it takes over its shot only while its draft is the pick.
        next.shots = p.shots.map((s) => (s.id === shot.id && s.chosenDraftId === parent.id ? { ...s, chosenFinalId: take.id } : s));
        break;
      }
      case "voice":
      case "music": {
        const body = (job as Job & { audioBody?: AudioBody }).audioBody;
        const total = p.shots.reduce((s, x) => s + x.durationSec, 0) || 15;
        const asset: Asset = {
          id: id("ast"),
          kind: "audio",
          path: `mock:audio:${job.step}:${seedOf(job.id)}`,
          durationSec: job.step === "music" ? Math.max(total, body?.durationSec ?? total) : Math.min(total, Math.max(4, (body?.text ?? "").split(" ").length / 2.6)),
          createdAt: now(),
        };
        outputs.push(asset.id);
        next.assets = [...p.assets, asset];
        const tl = ensureTimeline(next);
        const audio = tl.audio.filter((a) => a.role !== (job.step === "music" ? "music" : "voice"));
        audio.push({ assetId: asset.id, role: job.step === "music" ? "music" : "voice", start: 0, gain: job.step === "music" ? 0.8 : 1 });
        let captions = tl.captions;
        if (job.step === "voice") {
          const lines = body?.text ? splitLines(body.text) : scriptLines(p.template, p.brief);
          captions = captionsFor(lines, asset.durationSec ?? total);
        }
        next.timeline = { ...tl, audio, captions };
        break;
      }
      case "export": {
        const aspect = (job as Job & { aspect?: Project["aspect"] }).aspect ?? p.aspect;
        const sz = aspectSize(aspect);
        if ((job as Job & { reveal?: boolean }).reveal) {
          const shot = p.shots.find((s) => s.id === job.shotId) ?? p.shots[0];
          const chosen = shot ? bestAssetFor(p, shot) : undefined;
          const parts = chosen ? this.assetUrl(p.id, chosen.id).split(":") : undefined;
          const asset: Asset = {
            id: id("ast"),
            kind: "video",
            path: mockUrl({ kind: (parts?.[1] as SceneKind) ?? "landscape", seed: Number(parts?.[2] ?? 7), w: sz.w, h: sz.h, quality: "final", palette: Number(parts?.[5] ?? 0), move: shot?.cameraMove ?? "static" }),
            width: sz.w,
            height: sz.h,
            durationSec: 9.9,
            role: "reveal",
            createdAt: now(),
          };
          outputs.push(asset.id);
          next.assets = [...p.assets, asset];
          break;
        }
        const firstShot = p.shots[0];
        const chosen = firstShot ? bestAssetFor(p, firstShot) : undefined;
        const parts = chosen ? this.assetUrl(p.id, chosen.id).split(":") : undefined;
        const total = Math.max(0, ...(p.timeline?.clips ?? []).map((c) => c.start + c.out - c.in));
        if ((job as Job & { quality?: string }).quality === "preview") {
          const scale = 540 / Math.min(sz.w, sz.h);
          sz.w = Math.round(sz.w * scale / 2) * 2;
          sz.h = Math.round(sz.h * scale / 2) * 2;
        }
        const asset: Asset = {
          id: id("ast"),
          kind: "video",
          path: mockUrl({ kind: (parts?.[1] as SceneKind) ?? "landscape", seed: Number(parts?.[2] ?? 7), w: sz.w, h: sz.h, quality: "final", palette: Number(parts?.[5] ?? 0), move: firstShot?.cameraMove ?? "static" }),
          width: sz.w,
          height: sz.h,
          durationSec: total,
          createdAt: now(),
        };
        outputs.push(asset.id);
        next.assets = [...p.assets, asset];
        break;
      }
    }

    if (!next.timeline?.edited) next.timeline = buildTimeline(next);
    this.storeMediaSources(next);
    this.state.projects = this.state.projects.map((x) => (x.id === next.id ? next : x));
    this.emit({ type: "project", project: next });
    const peak = mockTiers.find((x) => x.tier === this.state.settings.tier)?.estimates?.[job.step as StepId]?.peakGb;
    const doneMessage = (job as Job & { reveal?: boolean }).reveal ? "Demo preview. The real engine writes a 9.9 s reveal clip." : job.step === "export" ? "Demo preview. No MP4 was written. Caption timings are estimated." : "Done";
    this.setJob({ ...job, status: "done", progress: 1, message: doneMessage, finishedAt: now(), outputAssetIds: outputs, peakGb: peak });

    // A sensible engine queues stills right after the shot list exists.
    if (job.step === "text" && next.template === "camera_move" && next.shots[0]?.stillAssetId) this.draft(next.id, next.shots[0].id);
    if (job.step === "text") {
      if (p.template === "vfx_effect") {
        for (const shot of next.shots) this.draft(p.id, shot.id);
      } else {
        for (const s of next.shots.filter((s) => !s.stillAssetId)) this.enqueue({ projectId: p.id, shotId: s.id, step: "still" });
      }
      if (p.template === "what_if") {
        this.audio(p.id, { role: "voice", text: next.shots[0]?.line ?? "", voice: "mara" });
        this.audio(p.id, { role: "music", prompt: "Instrumental cinematic curiosity", durationSec: 15 });
      }
    }
    if (job.step === "still" && p.template === "what_if" && !p.takes.length && next.shots[0]?.stillAssetId) this.draft(p.id, next.shots[0].id);
    // The sample's still is done: its motion draft follows, once, while the user is on the First shot step.
    const ob = this.state.onboarding;
    const first = next.shots[0];
    if (job.step === "still" && p.id === ob.sampleProjectId && !ob.done && !ob.draftJobId && first && first.id === job.shotId && first.stillAssetId && !next.takes.length) {
      this.state.onboarding = { ...ob, draftJobId: this.draft(p.id, first.id).id };
      this.persist();
    }
    // Every new song or voice is measured (beats, word times) by an analysis job on the CPU, like the real engine.
    if (job.step === "music" || job.step === "voice") this.enqueue({ projectId: p.id, step: job.step, analysis: true });
  }
}

// ---------------------------------------------------------------- helpers

export class MockHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function loadJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function saveJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota: drop silently, the mock keeps running in memory */
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

export function aspectSize(aspect: Project["aspect"]): { w: number; h: number } {
  if (aspect === "9:16") return { w: 576, h: 1024 };
  if (aspect === "1:1") return { w: 768, h: 768 };
  return { w: 1024, h: 576 };
}

/**
 * A shot from a PATCH, merged like the engine does it: a shot that leaves out stillAssetId, chosenDraftId or
 * chosenFinalId keeps the current value, and a new pick gets that draft's final (`finalFor`), or none yet.
 */
function mergedShot(p: Project, incoming: Shot): Shot {
  const current = p.shots.find((s) => s.id === incoming.id);
  if (!current) return incoming;
  const merged: Shot = { ...incoming };
  for (const key of ["stillAssetId", "chosenDraftId", "chosenFinalId"] as const) if (merged[key] === undefined && current[key] !== undefined) merged[key] = current[key];
  if (merged.chosenDraftId !== current.chosenDraftId) {
    const final = finalFor(p.takes, merged.chosenDraftId, merged.chosenFinalId);
    if (final) merged.chosenFinalId = final.id;
    else delete merged.chosenFinalId;
  }
  return merged;
}

export function ensureTimeline(p: Project): Timeline {
  if (p.timeline) return p.timeline;
  return buildTimeline(p);
}

/** The default cut: every shot in order with its best asset. */
export function buildTimeline(p: Project): Timeline {
  let t = 0;
  const clips: Timeline["clips"] = [];
  const voice = p.timeline?.audio.find((a) => a.role === "voice");
  const voiceAsset = p.assets.find((a) => a.id === voice?.assetId);
  const lines = scriptLines(p.template, p.brief);
  const perLine = voiceAsset?.durationSec && lines.length ? voiceAsset.durationSec / lines.length : undefined;
  const beat = 60 / (genres.find((g) => g.id === p.brief.genre)?.bpm ?? 120);
  for (const shot of p.shots) {
    const asset = bestAssetFor(p, shot);
    if (!asset) continue;
    let dur = asset.durationSec ?? shot.durationSec;
    if (p.template === "music_video" && p.timeline?.audio.some((a) => a.role === "music")) dur = Math.max(beat, Math.round(dur / beat) * beat);
    if (perLine) dur = perLine;
    clips.push({ shotId: shot.id, assetId: asset.id, start: t, in: 0, out: dur });
    t += dur;
  }
  return { ...p.timeline, clips, audio: p.timeline?.audio ?? [], captions: p.timeline?.captions ?? [], style: p.timeline?.style ?? {}, edited: false };
}

export function bestAssetFor(p: Project, s: Shot): Asset | undefined {
  const final = p.takes.find((t) => t.id === s.chosenFinalId);
  const draft = p.takes.find((t) => t.id === s.chosenDraftId);
  const assetId = final?.videoAssetId ?? draft?.videoAssetId ?? s.stillAssetId;
  return p.assets.find((a) => a.id === assetId);
}

function splitLines(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Captions spread over the voice, with even word timings. The real engine aligns words to the audio. */
function captionsFor(lines: string[], total: number): Caption[] {
  if (!lines.length) return [];
  const per = total / lines.length;
  return lines.map((text, i) => {
    const start = i * per + 0.2;
    const end = Math.min(total, (i + 1) * per - 0.15);
    const words = text.split(" ");
    const wdur = (end - start) / words.length;
    return { start, end, text, words: words.map((w, k) => ({ start: start + k * wdur, end: start + (k + 1) * wdur, text: w })) };
  });
}

let engine: MockEngine | null = null;
export function getMockEngine(): MockEngine {
  if (!engine) engine = new MockEngine();
  return engine;
}
