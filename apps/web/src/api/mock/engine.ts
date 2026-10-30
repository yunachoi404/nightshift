import type {
  Asset,
  DraftRequest,
  DraftTool,
  ExportRequest,
  Caption,
  Event as EngineEvent,
  HardwareProfile,
  InstallPlan,
  Job,
  MakeRequest,
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
import { kindForPrompt, mockUrl, parseMockUrl, type SceneKind, type SceneSpec } from "@/media/placeholder";
import { hardwarePresets, mockTier, rankTiers } from "./data";
import { nightTurn, tonightGroups } from "@/features/queue/tonight";
import { firstShot as firstShotSample, isSamplePath, playsRecordedCut, recordedCut, sampleAd, sampleAdExport, sampleForDraft, sampleForPrompt, sampleForStill, sampleUrl } from "./samples";
import { soundPick } from "./soundtrack";
import { cameraMoves, fallbackShots, finalFor, isBoardAsset, MAIN_BOARD_ID, mainBoardName, placeItem, quickEffects, quickMoves, scriptLines } from "@nightshift/contract";
import { genres, looks } from "@nightshift/contract";
import type { AudioBody, CreateProjectBody, FinalBody, ProjectPatch } from "../client";

// ---------------------------------------------------------------- types

/** "demo" paces the browser demo: a whole setup and First shot in well under a minute. */
export type Speed = "quick" | "realistic" | "demo";

/**
 * "dev": the mock for building the UI, with its controls panel. "demo": the browser demo for people trying Nightshift,
 * with real sample renders, a finished sample project and no controls. Each keeps its own state.
 */
export type MockFlavor = "dev" | "demo";

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
  /** Projects seeded from real renders (samples.ts): their cut is the recorded one while their picks and sound match it. */
  samples: string[];
}

// The demo's state is v2 since its sample ad changed: a v1 state holds the old ad, whose files are gone.
const keys = (flavor: MockFlavor) => (flavor === "demo" ? { state: "nightshift.demo.state.v2", dev: "nightshift.demo.dev.v1" } : { state: "nightshift.mock.state.v1", dev: "nightshift.mock.dev.v1" });

const defaultDev: DevSettings = {
  speed: "quick",
  preset: "m4max",
  faults: { detectFails: false, installFail: null, nextJobFail: null, unreachable: false, gpuAway: false, gpuShared: false },
  simulateNight: false,
  remote: "reachable",
};

/** The demo starts on the tested DGX Spark, at its own pace. */
const demoDev: Partial<DevSettings> = { speed: "demo", preset: "spark" };

function freshState(flavor: MockFlavor = "dev"): State {
  const seeded = flavor === "demo" ? [sampleAd()] : [];
  return {
    hardware: null,
    settings: { tier: null, memoryLimitGb: null, overnight: { enabled: true, startAt: "23:00", endAt: "07:00" } },
    runtime: { mode: "mock", phase: "not_installed", tier: null, comfyui: { running: false, url: null, version: null }, memoryUsedGb: null },
    install: null,
    present: [],
    jobs: [],
    uploads: {},
    overnightForced: false,
    localTier: null,
    onboarding: { done: false, sampleProjectId: null },
    samples: seeded.map((p) => p.id),
    projects: seeded,
  };
}

/** The First shot sample, as the engine makes it. */
const SAMPLE = { name: "First shot", template: "cinematic_shot", aspect: "16:9", brief: { idea: "A lone lighthouse on a cliff as a storm rolls in, waves hitting the rocks", cameraMove: "dolly_in", look: "dawn", sequence: "one" } } as const;

const now = () => new Date().toISOString();

/** Seconds a step takes in the demo: quick enough to see every stage in a couple of minutes, slow enough to watch. */
const demoSeconds: Record<StepId | "export", number> = {
  text: 3,
  still: 3,
  video_draft: 6,
  video_final_same_take: 8,
  video_final_remaster: 12,
  voice: 4,
  music: 5,
  camera_layout: 3,
  video_camera_move: 7,
  effect_end_frame: 3,
  video_effect: 7,
  video_what_if: 9,
  export: 5,
};

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

/** Presets that start with a shot list drafted from the brief. */
const FILMS = new Set<Project["template"]>(["cinematic_shot", "music_video", "product_ad", "talking_intro"]);

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

const editMessages = ["Loading the image model", "Editing the image", "Saving"];

function messagesFor(job: Pick<MockJob, "step" | "analysis" | "editFrom">): string[] {
  if (job.analysis && (job.step === "music" || job.step === "voice")) return analysisMessages[job.step];
  if (job.editFrom) return editMessages;
  return stepMessages[job.step];
}

/** The recipe step a job runs: an image edit is a still job that runs the edit step, as the engine runs it. */
const runsStep = (job: Pick<MockJob, "step" | "editFrom">): Job["step"] => (job.editFrom ? "effect_end_frame" : job.step);

type Listener = (e: EngineEvent) => void;

/** What the mock keeps on a job besides the contract's fields: the request it runs. */
type MockJob = Job & {
  seed?: number;
  parent?: string;
  keyframeIndex?: number;
  audioBody?: AudioBody;
  /** A draft made with a tool (an effect, a camera move) on the shot's still. */
  tool?: DraftTool;
  /** A still that replaces the shot's prompt for this render only. With `editFrom`, the edit's instruction. */
  stillPrompt?: string;
  /** A still drawn as an edit of this image (StillRequest.editFrom, the edit tool): the recipe's effect_end_frame step. */
  editFrom?: string;
  /** A still from the video tool: its draft is queued when it lands. */
  autoDraft?: boolean;
  aspect?: Project["aspect"];
  quality?: ExportRequest["quality"];
  /** One shot's share clip. */
  reveal?: boolean;
};

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

  private readonly keys: { state: string; dev: string };

  constructor(readonly flavor: MockFlavor = "dev") {
    this.keys = keys(flavor);
    const base = flavor === "demo" ? { ...defaultDev, ...demoDev } : defaultDev;
    this.dev = loadJson<DevSettings>(this.keys.dev) ?? { ...base };
    this.dev = { ...base, ...this.dev, faults: { ...base.faults, ...this.dev.faults } };
    this.applyUrlParams();
    this.state = loadJson<State>(this.keys.state) ?? freshState(flavor);
    this.state.samples ??= [];
    this.state.localTier ??= null;
    this.state.onboarding ??= { done: this.state.projects.length > 0, sampleProjectId: this.state.projects.find((p) => p.name === SAMPLE.name && p.brief.idea === SAMPLE.brief.idea)?.id ?? null };
    this.state.settings.remote ??= null;
    this.state.runtime.mode = this.state.settings.remote && this.state.runtime.phase === "ready" ? "remote" : "mock";
    for (const p of this.state.projects) if (!p.timeline?.edited) p.timeline = this.cut(p);
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
        for (const key of Object.keys(localStorage)) if (key.startsWith("nightshift.") && key !== this.keys.dev && key !== "nightshift.api") localStorage.removeItem(key);
      } else if (k === "hw" && v && hardwarePresets[v]) {
        this.dev.preset = v;
      } else if (k === "speed" && (v === "quick" || v === "realistic" || v === "demo")) {
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
    saveJson(this.keys.dev, this.dev);
  }

  setDev(patch: Partial<DevSettings>) {
    const was = this.dev.faults;
    this.dev = { ...this.dev, ...patch, faults: { ...this.dev.faults, ...(patch.faults ?? {}) } };
    saveJson(this.keys.dev, this.dev);
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
    localStorage.removeItem(this.keys.state);
    localStorage.removeItem("nightshift.overnightSeen");
    this.state = freshState(this.flavor);
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
    saveJson(this.keys.state, this.state);
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
    const t = mockTier(tier, this.state.hardware);
    if (!t) throw new MockHttpError(404, `Unknown tier ${tier}`);
    const downloads = t.files.filter((m) => !this.state.present.includes(m.id));
    const totalDownloadGb = round1(downloads.reduce((s, m) => s + m.sizeGb, 0));
    const freeDiskGb = this.state.hardware?.freeDiskGb ?? 0;
    return {
      tier,
      downloads,
      alreadyPresent: t.files.filter((m) => this.state.present.includes(m.id)).map((m) => m.id),
      totalDownloadGb,
      freeDiskGb,
      fits: true,
      simulated: true,
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

  /** The setup in use, from the real recipes. */
  private currentTier() {
    return this.state.settings.tier ? mockTier(this.state.settings.tier, this.state.hardware) : undefined;
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
    if (!mockTier(body.tier)) throw new MockHttpError(404, `Unknown tier ${body.tier}`);
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

  /**
   * A project of the user's own: setup is behind them. A film starts with the shot list its preset drafts from the
   * brief, on one board; a blank project or a What if? film starts empty. Nothing is queued.
   */
  createProject(body: CreateProjectBody): Project {
    const p = this.makeProject(body, this.presetShots(body));
    this.finishOnboarding();
    return p;
  }

  /** The shots a film's preset starts with: its template's shot list, no shot longer than one draft of this setup. */
  private presetShots(body: CreateProjectBody): Shot[] {
    if (!FILMS.has(body.template)) return [];
    const longest = this.currentTier()?.longestShotSec;
    return fallbackShots(body.template, body.brief).map((plan, index): Shot => {
      const shot: Shot = { id: id("sht"), index, prompt: plan.prompt, cameraMove: plan.cameraMove, durationSec: longest ? Math.min(plan.durationSec, longest) : plan.durationSec, locked: false };
      if (plan.line) shot.line = plan.line;
      return shot;
    });
  }

  private makeProject(body: CreateProjectBody, shots: Shot[] = []): Project {
    const t = now();
    const p: Project = {
      id: id("prj"),
      name: body.name,
      template: body.template,
      aspect: body.aspect,
      brief: body.brief,
      shots,
      takes: [],
      assets: [],
      timeline: null,
      boards: [{ id: MAIN_BOARD_ID, name: mainBoardName(body.template), items: shots.map((s) => s.id) }],
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
    // Handed back (`null`, `edited: false`) or never edited: the mock lays out the cut.
    if (!next.timeline?.edited) next.timeline = this.cut(next);
    else if (!patch.timeline) next.timeline = keptInStep(p, next, next.timeline, { soundtrack: patch.soundtrack !== undefined });
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
    if (p.shots.some(s => s.stillAssetId === assetId || s.keyframes?.some(frame => frame.stillAssetId === assetId)) || p.takes.some(t => t.imageAssetId === assetId || t.videoAssetId === assetId || t.guideAssetIds?.includes(assetId))) throw new MockHttpError(409, "This image is used by a shot or take.");
    const removed = (p.references ?? []).filter(r => r.assetId === assetId).map(r => r.id);
    const brief = { ...p.brief };
    for (const key of ["referenceAssetId", "productAssetId"]) if (brief[key] === assetId) delete brief[key];
    const boards = p.boards?.map(b => ({ ...b, items: b.items.filter(item => item !== assetId) }));
    this.replaceProject({ ...p, brief, references: (p.references ?? []).filter(r => r.assetId !== assetId), assets: p.assets.filter(a => a.id !== assetId), shots: p.shots.map(s => s.referenceIds ? { ...s, referenceIds: s.referenceIds.filter(id => !removed.includes(id)) } : s), ...(boards ? { boards } : {}) });
    delete this.state.uploads[assetId];
  }

  /** An uploaded file, filed at the end of `boardId` (else the first board). A song or a voiceover is the one the cut uses now. */
  uploadAsset(pid: string, dataUrl: string, kind: Asset["kind"], meta: Partial<Asset>, boardId?: string): Asset {
    const p = this.getProject(pid);
    const asset: Asset = { id: id("ast"), kind, path: dataUrl, createdAt: now(), ...meta };
    this.state.uploads[asset.id] = dataUrl;
    let next: Project = { ...p, assets: [...p.assets, asset], updatedAt: now() };
    if (isBoardAsset(next, asset)) next.boards = placeItem(next, asset.id, { boardId });
    if (asset.kind === "audio" && (asset.role === "music" || asset.role === "voice")) {
      next = withNewSound(next, asset.role);
      next.timeline = next.timeline?.edited ? keptInStep(p, next, next.timeline, { soundtrack: true }) : this.cut(next);
    }
    this.storeMediaSources(next);
    this.replaceProject(next);
    return asset;
  }

  assetUrl(pid: string, assetId: string): string {
    const asset = this.state.projects.find((p) => p.id === pid)?.assets.find((a) => a.id === assetId);
    if (!asset) return `mock:missing:${assetId}`;
    return isSamplePath(asset.path) ? sampleUrl(asset.path) : (this.state.uploads[assetId] ?? asset.path);
  }

  private storeMediaSources(project: Project) {
    for (const asset of project.assets) {
      if (!/^(mock:|data:|blob:)/.test(asset.path)) continue;
      this.state.uploads[asset.id] = asset.path;
      const ext = asset.kind === "image" ? "png" : asset.kind === "video" ? "mp4" : asset.kind === "audio" ? "wav" : "bin";
      asset.path = `assets/${asset.id}.${ext}`;
    }
  }

  /**
   * The cut the mock lays out for a project whose cut is not edited by hand: the recorded one while a sample still
   * has what it was recorded from (samples.ts), else its own default cut.
   */
  private cut(p: Project): Timeline {
    return recordedCut(p, this.state.samples) ?? buildTimeline(p);
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

  private enqueue(partial: Pick<Job, "projectId" | "step"> & Partial<MockJob>): MockJob {
    this.requireReady();
    const job: MockJob = {
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
    if (p.template === "blank") throw new MockHttpError(409, "A blank project has no shot list to write. Make shots with the tools.");
    if (p.template === "vfx_effect") {
      if (!p.assets.some((a) => a.id === p.brief.photoAssetId && a.kind === "image")) throw new MockHttpError(409, "Add a photo to this Effect project first.");
      if (!quickEffects.some((e) => e.id === p.brief.effect)) throw new MockHttpError(409, "Choose an effect from the gallery.");
    }
    return this.enqueue({ projectId: pid, step: "text", message: "Waiting" });
  }

  /**
   * One use of a project tool: a new card. The new shot waits on a board (`onTimeline: false`, at the end of `boardId`,
   * else the first board), in its own shape when the request names one (`aspect`), and its first job is queued: a
   * still, a draft from an image, a still that is drafted when it lands, an effect or a camera move on an image, or an
   * edit of an image (the new card's still; the image stays where it was).
   */
  make(pid: string, body: MakeRequest): Job {
    const p = this.getProject(pid);
    refuseTools(p);
    const prompt = body.prompt?.trim() ?? "";
    const image = body.imageAssetId ? p.assets.find((a) => a.id === body.imageAssetId && a.kind === "image") : undefined;
    if (body.imageAssetId && !image) throw new MockHttpError(404, `No image ${body.imageAssetId} in this project.`);
    if (body.referenceIds && (body.referenceIds.length > 3 || new Set(body.referenceIds).size !== body.referenceIds.length || body.referenceIds.some((r) => !(p.references ?? []).some((x) => x.id === r)))) throw new MockHttpError(400, "Choose up to three project references per shot.");
    let tool: DraftTool | undefined;
    let edit: { image: Asset; instruction: string } | undefined;
    let step: StepId;
    if (body.tool === "image") {
      if (!prompt) throw new MockHttpError(400, "Write a prompt for the image.");
      step = "still";
    } else if (body.tool === "video") {
      if (!image && !prompt) throw new MockHttpError(400, "Write a prompt, or start from an image.");
      if (body.move && !cameraMoves.some((m) => m.id === body.move)) throw new MockHttpError(400, "Choose a camera move from the list.");
      step = image ? "video_draft" : "still";
      this.requireStep("video_draft");
    } else if (body.tool === "effect") {
      if (!image) throw new MockHttpError(400, "Choose an image for the effect.");
      if (!body.effect || !quickEffects.some((e) => e.id === body.effect)) throw new MockHttpError(400, "Choose an effect from the gallery.");
      tool = { kind: "effect", effect: body.effect };
      step = "video_effect";
    } else if (body.tool === "edit") {
      if (!image) throw new MockHttpError(400, "Choose an image from this project first.");
      edit = this.editSource(p, image.id, prompt);
      step = "still";
    } else {
      if (!image) throw new MockHttpError(400, "Choose an image for the camera move.");
      if (!body.move || !quickMoves.some((m) => m.id === body.move)) throw new MockHttpError(400, "Choose a camera move from the gallery.");
      tool = { kind: "camera_move", move: body.move };
      step = "video_camera_move";
    }
    this.requireStep(step);
    this.requireReady();
    const longest = this.currentTier()?.longestShotSec;
    const durationSec = Math.min(body.durationSec ?? 4, longest ?? Infinity);
    const shot: Shot = { id: id("sht"), index: p.shots.length, prompt, durationSec, locked: false, onTimeline: false };
    if (image && !edit) shot.stillAssetId = image.id;
    if (body.tool === "video") shot.cameraMove = body.move ?? "static";
    if (body.tool === "camera_move") shot.cameraMove = body.move;
    if (body.referenceIds?.length) shot.referenceIds = body.referenceIds;
    if (body.aspect) shot.aspect = body.aspect;
    const next: Project = { ...p, shots: [...p.shots, shot], updatedAt: now() };
    next.boards = placeItem(next, shot.id, { boardId: body.boardId });
    this.replaceProject(next);
    const seed = body.seed ?? Math.floor(Math.random() * 1e9);
    if (edit) return this.enqueue({ projectId: pid, shotId: shot.id, step, seed, stillPrompt: edit.instruction, editFrom: edit.image.id });
    if (step === "still") return this.enqueue({ projectId: pid, shotId: shot.id, step, seed, ...(body.tool === "video" ? { autoDraft: true } : {}) });
    return this.enqueue({ projectId: pid, shotId: shot.id, step, seed, ...(tool ? { tool } : {}) });
  }

  /**
   * What an image edit starts from, checked as the engine checks it before anything is queued: an image of this
   * project, the instruction it follows, and a recipe with an image edit step (effect_end_frame, FLUX.2 Klein edit).
   */
  private editSource(p: Project, assetId: string, prompt: string | undefined): { image: Asset; instruction: string } {
    const tier = this.currentTier();
    if (!tier) throw new MockHttpError(409, "No tier is installed yet. Finish onboarding first.");
    if (!tier.steps?.includes("effect_end_frame")) throw new MockHttpError(409, `The ${tier.label} recipe cannot edit images.`);
    const asset = p.assets.find((a) => a.id === assetId);
    if (!asset) throw new MockHttpError(404, "That image is not in this project.");
    if (asset.kind !== "image") throw new MockHttpError(409, "Only an image can be edited. Choose a still or a photo.");
    const instruction = prompt?.trim();
    if (!instruction) throw new MockHttpError(400, "Say how to change the image.");
    return { image: asset, instruction };
  }

  /** Like the engine: a step the installed recipe lacks cannot be queued. */
  private requireStep(step: StepId) {
    const tier = this.currentTier();
    if (tier?.steps && !tier.steps.includes(step)) throw new MockHttpError(409, `The ${tier.label} recipe has no ${step.replace(/_/g, " ")} step.`);
  }

  /**
   * Draw a shot's still again: from its prompt (or `prompt`), or as an edit of an image of the project (`editFrom`,
   * following `prompt` as the instruction). The new still is the shot's pick when it lands.
   */
  still(pid: string, shotId: string, body?: StillRequest): Job {
    const p = this.getProject(pid);
    if (!p.shots.some((s) => s.id === shotId)) throw new MockHttpError(404, "Shot not found");
    if (body?.editFrom !== undefined) {
      refuseTools(p);
      const { image, instruction } = this.editSource(p, body.editFrom, body.prompt);
      return this.enqueue({ projectId: pid, shotId, step: "still", seed: body.seed ?? Math.floor(Math.random() * 1e9), stillPrompt: instruction, editFrom: image.id });
    }
    const prompt = body?.prompt?.trim();
    return this.enqueue({ projectId: pid, shotId, step: "still", keyframeIndex: body?.keyframeIndex, ...(prompt ? { stillPrompt: prompt } : {}) });
  }

  /** A new version of a shot: a motion draft, or with `tool` an effect or a camera move on its still. */
  draft(pid: string, shotId: string, body?: DraftRequest): Job {
    const p = this.getProject(pid);
    const shot = p.shots.find((s) => s.id === shotId);
    if (!shot) throw new MockHttpError(404, "Shot not found");
    const tool = body?.tool;
    if (tool?.kind === "effect" && !quickEffects.some((e) => e.id === tool.effect)) throw new MockHttpError(400, "Choose an effect from the gallery.");
    if (tool?.kind === "camera_move" && !quickMoves.some((m) => m.id === tool.move)) throw new MockHttpError(400, "Choose a camera move from the gallery.");
    if (!shot.stillAssetId) throw new MockHttpError(409, "Make a still for this shot first: the draft starts from it.");
    const step: StepId = tool ? (tool.kind === "effect" ? "video_effect" : "video_camera_move") : p.template === "what_if" ? "video_what_if" : p.template === "vfx_effect" ? "video_effect" : p.template === "camera_move" ? "video_camera_move" : "video_draft";
    if (tool) this.requireStep(step);
    return this.enqueue({ projectId: pid, shotId, step, seed: body?.seed ?? Math.floor(Math.random() * 1e9), ...(tool ? { tool } : {}) });
  }

  final(pid: string, shotId: string, body: FinalBody): Job {
    const p = this.getProject(pid);
    if (p.template === "what_if" && body.kind === "remaster") throw new MockHttpError(409, "What-if films finish from their saved take.");
    const take = p.takes.find((t) => t.id === body.draftId);
    if (!take) throw new MockHttpError(404, "Take not found");
    const step: StepId = body.kind === "remaster" ? "video_final_remaster" : "video_final_same_take";
    const tier = this.currentTier();
    if (tier && tier.steps && !tier.steps.includes(step)) throw new MockHttpError(409, "This machine can only do same-take finals.");
    const model = tier?.models?.[step];
    const partial: Pick<Job, "projectId" | "step"> & Partial<MockJob> = { projectId: pid, shotId, step, mode: body.mode, parent: take.id, ...(model ? { model } : {}) };
    if (body.mode === "overnight") partial.nightGroup = this.nightGroupFor(partial);
    return this.enqueue(partial);
  }

  /**
   * As the engine groups finals for the night (Job.nightGroup): a final joins the waiting group of its model while none
   * of that group has started, else it starts a new group after every other.
   */
  private nightGroupFor(job: Pick<Job, "step" | "model">): number {
    const key = (j: Pick<Job, "step" | "model">) => j.model ?? j.step;
    const night = this.state.jobs.filter((j) => j.mode === "overnight" && j.nightGroup !== undefined);
    const started = new Set(night.filter((j) => j.startedAt).map((j) => j.nightGroup));
    const open = night.find((j) => j.status === "queued" && !started.has(j.nightGroup) && key(j) === key(job));
    return open?.nightGroup ?? Math.max(0, ...night.map((j) => j.nightGroup!)) + 1;
  }

  audio(pid: string, body: AudioBody): Job {
    this.getProject(pid);
    return this.enqueue({ projectId: pid, step: body.role === "music" ? "music" : "voice", audioBody: body });
  }

  exportVideo(pid: string, body: ExportRequest): Job {
    const project = this.getProject(pid);
    if (body.kind === "reveal") {
      // One shot's share clip: the job carries the shot and the asset is filed with role "reveal".
      const shot = body.shotId ? project.shots.find((s) => s.id === body.shotId) : project.shots.length === 1 ? project.shots[0] : undefined;
      if (!shot) throw new MockHttpError(400, "Say which shot to reveal (shotId): this project has several.");
      const final = project.takes.find((t) => t.id === shot.chosenFinalId);
      if (!final) throw new MockHttpError(409, "This shot has no final yet. Finish it first, then share the reveal.");
      return this.enqueue({ projectId: pid, step: "export", shotId: shot.id, aspect: body.aspect, reveal: true });
    }
    if (body.rebuild || !project.timeline?.edited) this.replaceProject({ ...project, timeline: this.cut(project) });
    return this.enqueue({ projectId: pid, step: "export", quality: body.quality, aspect: body.aspect });
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
    const tier = mockTier(inst.tier)!;
    const rate = this.dev.speed === "demo" ? Math.max(0.5, inst.totalGb / 6) : this.dev.speed === "quick" ? Math.max(0.5, inst.totalGb / 28) : 0.06; // GB per second
    let budget = rate * dt;
    while (budget > 0) {
      if (!inst.current) {
        const nextId = inst.queue.shift();
        if (!nextId) break;
        inst.current = nextId;
        inst.currentDoneGb = 0;
      }
      const m = tier.files.find((x) => x.id === inst.current)!;
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
      saveJson(this.keys.dev, this.dev);
      this.setRuntime({ phase: "error", error: "Lost the connection while downloading. Check your network, then try again. What's already downloaded is kept." });
      return;
    }
    if (fail === "disk" && frac >= 0.7) {
      this.dev.faults.installFail = null;
      saveJson(this.keys.dev, this.dev);
      const need = round1(inst.totalGb - inst.doneGb + 8);
      this.setRuntime({ phase: "error", error: `The disk is full. Free about ${Math.ceil(need)} GB, then try again. What's already downloaded is kept.` });
      return;
    }
    const current = inst.current ? tier.files.find((x) => x.id === inst.current) : undefined;
    const message = current ? `Downloading ${current.name ?? current.filename}` : inst.queue.length ? "Checking files" : "Verifying";
    this.emit({ type: "install", progress: { modelId: inst.current, doneGb: round1(inst.doneGb), totalGb: inst.totalGb, message } });
    if (!inst.current && inst.queue.length === 0) this.finishInstall();
  }

  private finishInstall() {
    this.state.install = null;
    this.setRuntime({ phase: "starting", comfyui: { running: false, url: null, version: null } });
    const delay = this.dev.speed === "demo" ? 1500 : this.dev.speed === "quick" ? 3500 : 12000;
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
      // Interactive work first, then overnight finals when the window is open, in groups that share a model.
      running = queued.find((j) => j.mode === "now") ?? (night ? tonightGroups(queued, nightTurn(this.state.jobs))[0]?.jobs[0] : undefined);
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
      const tier = this.currentTier();
      const est = tier?.estimates?.[runsStep(running) as StepId]?.peakGb;
      if (est) this.setRuntime({ memoryUsedGb: Math.min(est, (this.state.settings.memoryLimitGb ?? est) * 0.96) });
    }
    const total = this.jobSeconds(runsStep(running), running.analysis);
    const next = Math.min(1, running.progress + dt / total);
    const fail = this.dev.faults.nextJobFail;
    if (fail && next >= 0.58) {
      this.dev.faults.nextJobFail = null;
      saveJson(this.keys.dev, this.dev);
      const tier = this.currentTier();
      const peak = tier?.estimates?.[runsStep(running) as StepId]?.peakGb ?? 30;
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
    if (analysis) return this.dev.speed === "demo" ? 2 : this.dev.speed === "quick" ? 4 : 12;
    if (this.dev.speed === "demo") return demoSeconds[step];
    if (this.dev.speed === "quick") return quickSeconds[step];
    const tier = this.currentTier();
    const est = step === "export" ? 40 : tier?.estimates?.[step]?.seconds;
    return est ?? quickSeconds[step] * 6;
  }

  // ------------------------------------------------------------ job results

  private completeJob(job: MockJob) {
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
    // A What if? film renders in the project's shape. Every other shot renders in its own (Shot.aspect), else the
    // project's, and a recorded render is replayed only for a shot in the shape it was recorded in.
    const size = aspectSize(p.aspect);
    const shapeOf = (shot: Shot) => aspectSize(shot.aspect ?? p.aspect);
    const ownShape = (shot: Shot) => !!shot.aspect && shot.aspect !== p.aspect;
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
        const longest = this.currentTier()?.longestShotSec;
        let gen = fallbackShots(p.template, p.brief).map(s => ({ ...s, durationSec: longest ? Math.min(s.durationSec, longest) : s.durationSec, prompt: [s.prompt, ...(p.references ?? []).slice(0, 3).map(r => `Featuring ${r.label}.`)].join(" ") }));
        // The First shot sample writes the shot the real one wrote, so its still and draft are the real renders.
        if (p.id === this.state.onboarding.sampleProjectId && gen[0] && p.shots.length === 0) gen = [{ ...gen[0], prompt: firstShotSample.prompt, cameraMove: firstShotSample.cameraMove, durationSec: firstShotSample.durationSec }];
        let planIndex = 0;
        const fresh = (g: (typeof gen)[number]): Shot => ({ id: id("sht"), index: 0, ...g, locked: false });
        const merged: Shot[] = [];
        // The shot list is the timeline's: shots waiting on a board stay as they are, after it. As the engine does, it
        // writes over only the shots it wrote: locked shots keep their place, and so do shots it did not write (a take
        // made with a tool, no prompt). A shot left over past the new list stays when it has a still or takes.
        const takesOf = (shot: Shot) => p.takes.filter((t) => t.shotId === shot.id);
        const keeps = (shot: Shot) => shot.locked || !shot.prompt.trim() || takesOf(shot).some((t) => t.tool);
        const replaced = new Map<string, string>();
        for (const shot of timelineShots(p)) {
          if (keeps(shot)) merged.push(shot);
          else if (planIndex < gen.length) {
            const made = fresh(gen[planIndex++]!);
            replaced.set(shot.id, made.id);
            merged.push(made);
          } else if (shot.stillAssetId || takesOf(shot).length) merged.push(shot);
        }
        while (planIndex < gen.length) merged.push(fresh(gen[planIndex++]!));
        const quickPhoto = (p.template === "camera_move" || p.template === "vfx_effect") && typeof p.brief.photoAssetId === "string" ? { stillAssetId: p.brief.photoAssetId } : {};
        next.shots = [...merged.map((s) => ({ ...s, ...quickPhoto })), ...boardShots(p)].map((s, index) => ({ ...s, index }));
        next.takes = p.takes.filter((t) => next.shots.some((s) => s.id === t.shotId));
        // A rewritten shot takes its place on its board.
        if (p.boards) next.boards = p.boards.map((b) => ({ ...b, items: b.items.map((item) => replaced.get(item) ?? item) }));
        break;
      }
      case "still": {
        const shot = p.shots.find((s) => s.id === job.shotId);
        if (!shot) break;
        if (p.template === "what_if" && shot.keyframes) {
          const assets: Asset[] = [];
          const start = job.keyframeIndex ?? 0;
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
        if (p.template === "vfx_effect" && shot.onTimeline !== false) {
          const photo = p.assets.find((a) => a.id === p.brief.photoAssetId && a.kind === "image");
          if (!photo) break;
          next.shots = p.shots.map((s) => s.id === shot.id ? { ...s, stillAssetId: photo.id } : s);
          outputs.push(photo.id);
          break;
        }
        const prompt = job.stillPrompt ?? shot.prompt;
        const shape = shapeOf(shot);
        if (job.editFrom) {
          // An edit (the edit tool, StillRequest.editFrom): a new still of this card, its history keeping the instruction.
          const source = p.assets.find((a) => a.id === job.editFrom && a.kind === "image");
          if (!source) {
            this.setJob({ ...job, status: "failed", error: "The image to edit is no longer in this project.", message: "Failed", finishedAt: now() });
            return;
          }
          const shown = p.shots.find((s) => s.stillAssetId === source.id || s.stillHistory?.some((h) => h.assetId === source.id))?.prompt || prompt;
          const scene = { kind: kindForPrompt(shown, p.template), seed: seedOf(source.id), palette: paletteFor(shown) };
          const asset: Asset = { id: id("ast"), kind: "image", path: editedPicture(parseMockUrl(this.assetUrl(p.id, source.id)), scene, prompt, shape), width: shape.w, height: shape.h, createdAt: now() };
          outputs.push(asset.id);
          next.assets = [...p.assets, asset];
          next.shots = p.shots.map((s) => (s.id === shot.id ? withStill(p, s, asset, prompt) : s));
          break;
        }
        const kind: SceneKind = kindForPrompt(prompt, p.template);
        const recorded = ownShape(shot) ? undefined : sampleForPrompt(prompt)?.still;
        const asset: Asset = recorded
          ? { id: id("ast"), kind: "image", ...recorded, createdAt: now() }
          : {
              id: id("ast"),
              kind: "image",
              path: mockUrl({ kind, seed: seedOf(shot.id + prompt + job.id), w: shape.w, h: shape.h, quality: "still", palette: paletteFor(prompt), move: "static" }),
              width: shape.w,
              height: shape.h,
              createdAt: now(),
            };
        outputs.push(asset.id);
        next.assets = [...p.assets, asset];
        next.shots = p.shots.map((s) => (s.id === shot.id ? withStill(p, s, asset, prompt) : s));
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
        const seed = job.seed ?? Math.floor(Math.random() * 1e9);
        const kind = (base?.[1] as SceneKind) ?? kindForPrompt(shot.prompt, p.template);
        const sceneSeed = base ? Number(base[2]) + (seed % 7) : seedOf(shot.id + seed);
        // The draft moves its still: in the still's light (an edited still keeps its new light), at half the card's size.
        const palette = base ? Number(base[5]) : paletteFor(shot.prompt);
        const half = { w: Math.round(shapeOf(shot).w / 2), h: Math.round(shapeOf(shot).h / 2) };
        // A recorded shot's drafts are its real takes, in the order they were made.
        const recorded = job.step === "video_draft" && !ownShape(shot) ? sampleForStill(still?.path) : undefined;
        const made = p.takes.filter((t) => t.shotId === shot.id && t.rung === "draft").length;
        const real = recorded?.drafts[made % recorded.drafts.length];
        const video: Asset = real
          ? { id: id("ast"), kind: "video", ...real, createdAt: now() }
          : {
              id: id("ast"),
              kind: "video",
              path: mockUrl({ kind, seed: sceneSeed, w: half.w, h: half.h, quality: "draft", palette, move: moveOf(shot, job.tool) }),
              width: half.w,
              height: half.h,
              durationSec: shot.durationSec,
              createdAt: now(),
            };
        const latent: Asset = { id: id("ast"), kind: "latent", path: `latents/${video.id}.safetensors`, createdAt: now() };
        const take: Take = { id: id("tk"), shotId: shot.id, rung: "draft", seed, videoAssetId: video.id, latentAssetId: latent.id, jobId: job.id };
        if (shot.prompt) take.prompt = shot.prompt;
        if (shot.stillAssetId) take.imageAssetId = shot.stillAssetId;
        if (job.tool) take.tool = job.tool;
        if (p.template === "what_if") take.guideAssetIds = shot.keyframes?.flatMap(frame => frame.stillAssetId ? [frame.stillAssetId] : []);
        outputs.push(video.id);
        next.assets = [...p.assets, video, latent];
        next.takes = [...p.takes, take];
        // The new draft is the shot's pick: the cut shows it, and no final of an earlier draft.
        next.shots = p.shots.map((s) => {
          if (s.id !== shot.id) return s;
          const { useStill: _still, chosenFinalId: _final, ...rest } = s;
          return { ...rest, chosenDraftId: take.id };
        });
        break;
      }
      case "video_final_same_take":
      case "video_final_remaster": {
        const shot = p.shots.find((s) => s.id === job.shotId);
        const parentId = job.parent;
        const parent = p.takes.find((t) => t.id === parentId) ?? p.takes.find((t) => t.shotId === job.shotId && t.rung === "draft");
        if (!shot || !parent) break;
        const draftAsset = p.assets.find((a) => a.id === parent.videoAssetId);
        const parts = draftAsset ? this.assetUrl(p.id, draftAsset.id).split(":") : undefined;
        const remaster = job.step === "video_final_remaster";
        // A recorded take finishes as its real same-take final did. A take with none recorded (the First shot's, made on
        // an 8 GB card whose final is a 2x resize) shows its own frames.
        const recorded = ownShape(shot) ? undefined : sampleForDraft(draftAsset?.path);
        const real = recorded && (recorded.final ?? recorded.drafts.find((d) => d.path === draftAsset?.path));
        const shape = shapeOf(shot);
        const video: Asset = real
          ? { id: id("ast"), kind: "video", ...real, createdAt: now() }
          : {
          id: id("ast"),
          kind: "video",
          path: mockUrl({
            kind: (parts?.[1] as SceneKind) ?? "landscape",
            seed: remaster ? Number(parts?.[2] ?? 1) + 3 : Number(parts?.[2] ?? 1),
            w: shape.w,
            h: shape.h,
            quality: "final",
            palette: Number(parts?.[5] ?? 0),
            move: moveOf(shot, parent.tool),
          }),
          width: shape.w,
          height: shape.h,
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
        if (parent.prompt) take.prompt = parent.prompt;
        if (parent.imageAssetId) take.imageAssetId = parent.imageAssetId;
        if (parent.tool) take.tool = parent.tool;
        outputs.push(video.id);
        next.assets = [...p.assets, video];
        next.takes = [...p.takes, take];
        // Like the engine: it takes over its shot only while its draft is the pick, and then it is what the cut shows.
        next.shots = p.shots.map((s) => {
          if (s.id !== shot.id || s.chosenDraftId !== parent.id) return s;
          const { useStill: _still, ...rest } = s;
          return { ...rest, chosenFinalId: take.id };
        });
        break;
      }
      case "voice":
      case "music": {
        const body = job.audioBody;
        const role = job.step;
        const total = cutLength(p);
        const asset: Asset = {
          id: id("ast"),
          kind: "audio",
          role,
          path: `mock:audio:${job.step}:${seedOf(job.id)}`,
          durationSec: job.step === "music" ? Math.max(total, body?.durationSec ?? total) : Math.min(total, Math.max(4, (body?.text ?? "").split(" ").length / 2.6)),
          createdAt: now(),
        };
        if (role === "voice" && body?.text?.trim()) asset.text = body.text.trim();
        outputs.push(asset.id);
        next.assets = [...p.assets, asset];
        // Like the engine: the new song or voiceover is a card on its board, and the one the cut uses.
        next.boards = placeItem(next, asset.id, { boardId: body?.boardId });
        next = withNewSound(next, role);
        const tl = ensureTimeline(next);
        const audio = tl.audio.filter((a) => a.role !== role);
        audio.push({ assetId: asset.id, role, start: 0, gain: role === "music" ? 0.8 : 1 });
        next.timeline = { ...tl, audio, captions: job.step === "voice" ? voiceCaptions(p, asset, total) : tl.captions };
        break;
      }
      case "export": {
        const aspect = job.aspect ?? p.aspect;
        const sz = aspectSize(aspect);
        if (job.reveal) {
          const shot = p.shots.find((s) => s.id === job.shotId) ?? p.shots[0];
          const final = p.takes.find((t) => t.id === shot?.chosenFinalId);
          const chosen = p.assets.find((a) => a.id === final?.videoAssetId) ?? (shot ? bestAssetFor(p, shot) : undefined);
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
        const firstShot = timelineShots(p)[0];
        const chosen = firstShot ? bestAssetFor(p, firstShot) : undefined;
        const parts = chosen ? this.assetUrl(p.id, chosen.id).split(":") : undefined;
        const total = Math.max(0, ...(p.timeline?.clips ?? []).map((c) => c.start + c.out - c.in));
        if (job.quality === "preview") {
          const scale = 540 / Math.min(sz.w, sz.h);
          sz.w = Math.round(sz.w * scale / 2) * 2;
          sz.h = Math.round(sz.h * scale / 2) * 2;
        }
        // The recorded project, cut as it was recorded, exports the film it really exported.
        const recordedExport = aspect === "16:9" && playsRecordedCut(p, this.state.samples) ? sampleAdExport : undefined;
        const asset: Asset = recordedExport
          ? { ...recordedExport, id: id("ast"), createdAt: now() }
          : {
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

    if (!next.timeline?.edited) next.timeline = this.cut(next);
    this.storeMediaSources(next);
    this.state.projects = this.state.projects.map((x) => (x.id === next.id ? next : x));
    this.emit({ type: "project", project: next });
    const peak = this.currentTier()?.estimates?.[runsStep(job) as StepId]?.peakGb;
    const recordedFilm = job.step === "export" && next.assets.some((a) => outputs.includes(a.id) && a.path === sampleAdExport.path);
    const doneMessage = job.reveal ? "Demo preview. The real engine writes a 9.9 s reveal clip." : recordedFilm ? "The film this project exported on the DGX Spark, made smaller for the web." : job.step === "export" ? "Demo preview. No MP4 was written. Caption timings are estimated." : job.editFrom ? "Edit ready" : "Done";
    this.setJob({ ...job, status: "done", progress: 1, message: doneMessage, finishedAt: now(), outputAssetIds: outputs, peakGb: peak });

    // A sensible engine queues stills right after the shot list exists: for the timeline's shots, not the ones waiting on a board.
    const quickShot = timelineShots(next)[0];
    if (job.step === "text" && next.template === "camera_move" && quickShot?.stillAssetId) this.draft(next.id, quickShot.id);
    if (job.step === "text") {
      if (p.template === "vfx_effect") {
        for (const shot of timelineShots(next)) this.draft(p.id, shot.id);
      } else {
        for (const s of timelineShots(next).filter((s) => !s.stillAssetId)) this.enqueue({ projectId: p.id, shotId: s.id, step: "still" });
      }
      if (p.template === "what_if") {
        this.audio(p.id, { role: "voice", text: next.shots[0]?.line ?? "", voice: "mara" });
        this.audio(p.id, { role: "music", prompt: "Instrumental cinematic curiosity", durationSec: 15 });
      }
    }
    if (job.step === "still" && p.template === "what_if" && !p.takes.length && next.shots[0]?.stillAssetId) this.draft(p.id, next.shots[0].id);
    // A still the video tool drew: its draft follows, from the still that landed.
    const drawn = next.shots.find((s) => s.id === job.shotId);
    if (job.step === "still" && job.autoDraft && drawn?.stillAssetId) this.enqueue({ projectId: p.id, shotId: drawn.id, step: "video_draft", seed: job.seed ?? Math.floor(Math.random() * 1e9) });
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
 * A shot from a PATCH, merged like the engine does it: a shot that leaves out a field jobs set (its still and its
 * history, its picks, whether it is on the timeline, whether the cut shows its still) keeps the current value. A new
 * pick gets that draft's final (`finalFor`), or none yet, and shows that draft, not the still, unless `useStill` says so.
 */
function mergedShot(p: Project, incoming: Shot): Shot {
  const current = p.shots.find((s) => s.id === incoming.id);
  if (!current) return incoming;
  const merged: Shot = { ...incoming };
  const keep = <K extends keyof Shot>(key: K) => {
    if (merged[key] === undefined && current[key] !== undefined) merged[key] = current[key];
  };
  for (const key of ["stillAssetId", "chosenDraftId", "chosenFinalId", "onTimeline", "stillHistory"] as const) keep(key);
  if (merged.chosenDraftId !== current.chosenDraftId) {
    const final = finalFor(p.takes, merged.chosenDraftId, merged.chosenFinalId);
    if (final) merged.chosenFinalId = final.id;
    else delete merged.chosenFinalId;
  } else keep("useStill");
  return merged;
}

/** The timeline's shots, in order. Shots the tools made wait on a board (`onTimeline: false`) and are not in the cut. */
export function timelineShots(p: Pick<Project, "shots">): Shot[] {
  return p.shots.filter((s) => s.onTimeline !== false).sort((a, b) => a.index - b.index);
}

/** The shots waiting on a board, in order. */
function boardShots(p: Pick<Project, "shots">): Shot[] {
  return p.shots.filter((s) => s.onTimeline === false).sort((a, b) => a.index - b.index);
}

/** A new still is the shot's pick: the cut shows it, and it joins the shot's history, which starts with the still it had. */
function withStill(p: Project, shot: Shot, asset: Asset, prompt: string): Shot {
  const before = p.assets.find((a) => a.id === shot.stillAssetId);
  const history = shot.stillHistory ?? (before ? [{ assetId: before.id, createdAt: before.createdAt }] : []);
  return { ...shot, stillAssetId: asset.id, useStill: true, stillHistory: [...history, { assetId: asset.id, ...(prompt ? { prompt } : {}), createdAt: asset.createdAt }] };
}

/** As the engine: What if? films and quick shots keep their own flow, so the tools (new cards, image edits) refuse them. */
function refuseTools(p: Project): void {
  if (p.template === "what_if") throw new MockHttpError(409, "A What if? film is one continuous shot. Start a new project to make more.");
  if (p.template === "camera_move" || p.template === "vfx_effect") throw new MockHttpError(409, "This project makes one shot from its photo. Start a new project to use the tools.");
}

/** The light an edit asks for, by the words of its instruction: a placeholder palette (see media/placeholder.ts). */
const EDIT_LIGHT: Array<[RegExp, number]> = [
  [/\b(black and white|noir|monochrome)\b/, 4],
  [/\b(night|midnight|neon|dark)\b/, 2],
  [/\b(sunset|golden|dusk|evening|warm)\b/, 1],
  [/\b(dawn|sunrise|morning)\b/, 5],
  [/\b(fog|foggy|mist|misty|rain|rainy|overcast|cloudy|storm|snow|winter|gr[ae]y)\b/, 3],
  [/\b(forest|green|spring|summer|trees)\b/, 7],
  [/\b(day|daylight|noon|sunny|bright)\b/, 0],
];

/**
 * An image edit, as a placeholder: the source picture's scene (its kind and layout) in the light the instruction asks
 * for, at the card's size. An instruction that names no light still shows a change: the same scene in another light.
 * A photo or a recorded still has no scene to keep, so it gets `scene`, drawn from what its card shows.
 */
function editedPicture(source: SceneSpec | null, scene: Pick<SceneSpec, "kind" | "seed" | "palette">, instruction: string, size: { w: number; h: number }): string {
  const kind = source?.kind ?? scene.kind;
  // A product shot's light is fixed: its product's shape is what changes.
  const seed = source ? source.seed + (kind === "product" ? 1 : 0) : scene.seed;
  const from = source?.palette ?? scene.palette;
  const text = instruction.toLowerCase();
  const others = [0, 1, 2, 3, 5, 7].filter((n) => n !== from);
  const palette = EDIT_LIGHT.find(([words]) => words.test(text))?.[1] ?? others[Math.abs(hashStr(text)) % others.length]!;
  return mockUrl({ kind, seed, w: size.w, h: size.h, quality: "still", palette, move: "static" });
}

/** How a placeholder clip moves: a camera move's path, an effect from a still camera, else the shot's own move. */
function moveOf(shot: Shot, tool: DraftTool | undefined): string {
  if (tool?.kind === "camera_move") return tool.move;
  if (tool?.kind === "effect") return "static";
  return shot.cameraMove ?? "static";
}

/** A new song or voiceover clears its role's pick, so the cut uses it (the newest of its role). */
function withNewSound(p: Project, role: "music" | "voice"): Project {
  if (!p.soundtrack || !(role in p.soundtrack)) return p;
  const { [role]: _, ...soundtrack } = p.soundtrack;
  const next: Project = { ...p, soundtrack };
  if (!Object.keys(soundtrack).length) delete next.soundtrack;
  return next;
}

/**
 * The cut's audio with the soundtrack's song and voice. Tracks that already play the pick stay as they are (a voice in
 * pieces, a trimmed song); another song or voice is replaced by the pick from the start, and a role set to none goes.
 */
function cutAudio(p: Project, current: Timeline["audio"]): Timeline["audio"] {
  const picks = { music: soundPick(p, "music"), voice: soundPick(p, "voice") };
  const audio = current.filter((a) => (a.role !== "music" && a.role !== "voice") || picks[a.role] === undefined || picks[a.role] === a.assetId);
  for (const role of ["music", "voice"] as const) {
    const pick = picks[role];
    if (pick && !audio.some((a) => a.role === role)) audio.push({ assetId: pick, role, start: 0, gain: role === "music" ? 0.8 : 1 });
  }
  return audio;
}

/**
 * A hand-edited cut kept in step with the project, as of the change from `before`: clips of shots taken off the
 * timeline go and the clips after them close the gap; a shot sent to the timeline comes in before the next timeline
 * shot that has a clip, pushing the rest later. With `soundtrack`, the song and the voice follow the soundtrack.
 */
function keptInStep(before: Project, p: Project, tl: Timeline, o: { soundtrack?: boolean } = {}): Timeline {
  const was = new Set(timelineShots(before).map((s) => s.id));
  const cut = timelineShots(p);
  const inCut = new Set(cut.map((s) => s.id));
  let clips = [...tl.clips];
  for (const gone of clips.filter((c) => was.has(c.shotId) && !inCut.has(c.shotId))) {
    const length = gone.out - gone.in;
    clips = clips.filter((c) => c !== gone).map((c) => (c.start > gone.start ? { ...c, start: Math.max(gone.start, c.start - length) } : c));
  }
  cut.forEach((shot, i) => {
    if (was.has(shot.id) || clips.some((c) => c.shotId === shot.id)) return;
    const asset = bestAssetFor(p, shot);
    if (!asset) return;
    const length = asset.durationSec ?? shot.durationSec;
    const later = new Set(cut.slice(i + 1).map((s) => s.id));
    const next = clips.filter((c) => later.has(c.shotId)).sort((a, b) => a.start - b.start)[0];
    const at = next ? next.start : Math.max(0, ...clips.map((c) => c.start + c.out - c.in));
    clips = clips.map((c) => (c.start >= at ? { ...c, start: c.start + length } : c));
    clips.push({ shotId: shot.id, assetId: asset.id, start: at, in: 0, out: length });
  });
  clips.sort((a, b) => a.start - b.start);
  if (!o.soundtrack) return { ...tl, clips };
  // As the engine keeps an edited cut: the captions follow the track they come from (the song in a music video, else
  // the voice). Taken off, they go; another one, its words.
  const audio = cutAudio(p, tl.audio);
  const from = p.template === "music_video" ? "music" : "voice";
  const track = (a: Timeline["audio"]) => a.find((x) => x.role === from)?.assetId;
  const now = p.assets.find((a) => a.id === track(audio));
  let captions = tl.captions;
  if (track(audio) !== track(tl.audio)) captions = !now ? [] : from === "voice" ? voiceCaptions(p, now, cutLength(p)) : captions;
  return { ...tl, clips, audio, captions };
}

export function ensureTimeline(p: Project): Timeline {
  if (p.timeline) return p.timeline;
  return buildTimeline(p);
}

/** The default cut: the timeline's shots in order, each with its pick, and the soundtrack's song and voice. */
export function buildTimeline(p: Project): Timeline {
  let t = 0;
  const clips: Timeline["clips"] = [];
  const audio = cutAudio(p, p.timeline?.audio ?? []);
  const voice = audio.find((a) => a.role === "voice");
  const voiceAsset = p.assets.find((a) => a.id === voice?.assetId);
  const lines = scriptLines(p.template, p.brief);
  const perLine = voiceAsset?.durationSec && lines.length ? voiceAsset.durationSec / lines.length : undefined;
  const beat = 60 / (genres.find((g) => g.id === p.brief.genre)?.bpm ?? 120);
  for (const shot of timelineShots(p)) {
    const asset = bestAssetFor(p, shot);
    if (!asset) continue;
    let dur = asset.durationSec ?? shot.durationSec;
    if (p.template === "music_video" && audio.some((a) => a.role === "music")) dur = Math.max(beat, Math.round(dur / beat) * beat);
    if (perLine) dur = perLine;
    clips.push({ shotId: shot.id, assetId: asset.id, start: t, in: 0, out: dur });
    t += dur;
  }
  // As the engine's cut: the captions are the voice's words, so another voice brings its own. With no voice they are
  // the script's, timed by estimate, where the engine shows that (a product ad, a talking intro), else none. A music
  // video's come from the song, which the mock does not transcribe: they stay.
  let captions = p.timeline?.captions ?? [];
  if (p.template !== "music_video") {
    const before = p.timeline?.audio.find((a) => a.role === "voice")?.assetId;
    if (!voice) captions = scriptCaptions(p, t || cutLength(p));
    else if (voiceAsset && voice.assetId !== before) captions = voiceCaptions(p, voiceAsset, t || cutLength(p));
  }
  return { ...p.timeline, clips, audio, captions, style: p.timeline?.style ?? {}, edited: false };
}

/**
 * What the cut shows for a shot, as the engine picks it: its still when restored as the pick (`useStill`), else its
 * shown final, its picked draft, its newest take (finals first), its still.
 */
export function bestAssetFor(p: Project, s: Shot): Asset | undefined {
  const asset = (assetId: string | undefined) => (assetId ? p.assets.find((a) => a.id === assetId) : undefined);
  const still = asset(s.stillAssetId);
  if (s.useStill && still) return still;
  const take = (takeId: string | undefined) => asset(p.takes.find((t) => t.id === takeId)?.videoAssetId);
  const newest = p.takes
    .filter((t) => t.shotId === s.id && asset(t.videoAssetId))
    .sort((a, b) => Number(b.rung === "final") - Number(a.rung === "final") || asset(b.videoAssetId)!.createdAt.localeCompare(asset(a.videoAssetId)!.createdAt))[0];
  return take(s.chosenFinalId) ?? take(s.chosenDraftId) ?? asset(newest?.videoAssetId) ?? still;
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

/** How long the timeline's shots run, for timing words when there is nothing else to time them by. */
function cutLength(p: Project): number {
  return timelineShots(p).reduce((sum, s) => sum + s.durationSec, 0) || 15;
}

/** A voiceover's captions, as the voice job writes them: its own text, else the template's script, over its length. */
function voiceCaptions(p: Project, voice: Asset, total: number): Caption[] {
  return captionsFor(voice.text ? splitLines(voice.text) : scriptLines(p.template, p.brief), voice.durationSec ?? total);
}

/**
 * The captions the engine's cut shows with no voice: a product ad's and a talking intro's script, timed by estimate.
 * The script is the brief's, else for a product ad the lines of the timeline's shots, else its pitch.
 */
function scriptCaptions(p: Project, total: number): Caption[] {
  if (p.template !== "product_ad" && p.template !== "talking_intro") return [];
  const script = typeof p.brief.script === "string" ? p.brief.script.trim() : "";
  if (script || p.template === "talking_intro") return captionsFor(splitLines(script), total);
  const lines = timelineShots(p).flatMap((s) => (s.line?.trim() ? [s.line.trim()] : []));
  return captionsFor(lines.length ? lines : scriptLines("product_ad", p.brief), total);
}

let engine: MockEngine | null = null;
/** The page's one mock engine. Its flavor is fixed by the first call: the page reloads to change it. */
export function getMockEngine(flavor: MockFlavor = "dev"): MockEngine {
  if (!engine) engine = new MockEngine(flavor);
  return engine;
}
