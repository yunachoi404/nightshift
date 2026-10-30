import type {
  Aspect,
  DraftRequest,
  ExportRequest,
  Event as EngineEvent,
  FinalKind,
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
  StillRequest,
  TemplateId,
  TierId,
  TierSummary,
} from "@nightshift/contract";

export type { EngineEvent };

export interface CreateProjectBody {
  name: string;
  template: TemplateId;
  aspect: Aspect;
  brief: Record<string, unknown>;
}

export type ProjectPatch = Partial<Pick<Project, "name" | "shots" | "timeline" | "brief" | "aspect" | "references" | "boards" | "soundtrack">>;

export interface FinalBody {
  draftId: string;
  kind: FinalKind;
  mode: "now" | "overnight";
}

export interface AudioBody {
  role: "music" | "voice";
  prompt?: string;
  text?: string;
  durationSec?: number;
  voice?: string;
  /** The board the result goes on. */
  boardId?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: "unreachable" | "http" | "bad_response" = "http",
  ) {
    super(message);
  }
}

/**
 * Everything the UI may ask the engine. One implementation speaks HTTP + SSE to the real engine
 * (`http.ts`), the other runs an in-browser mock (`mock/`). Screens never know which one they got.
 */
export interface NightshiftClient {
  readonly kind: "http" | "mock";

  hardware(): Promise<HardwareProfile>;
  setHardwareManual(profile: HardwareProfile): Promise<HardwareProfile>;
  tiers(): Promise<TierSummary[]>;
  installPlan(tier: TierId): Promise<InstallPlan>;
  install(body: { tier: TierId; memoryLimitGb: number | null }): Promise<void>;
  /**
   * Looks on this computer for the models a setup needs (ComfyUI folders, the Hugging Face cache, `folders` the user
   * added) and returns the plan with what it found. The in-browser engines have no disk to look at, so no scan.
   */
  scanModels?(body: { tier: TierId; folders?: string[] }): Promise<InstallPlan>;
  /** Checks a GPU computer on the network (a host, "host:port" or URL) before using it. */
  remoteCheck(url: string): Promise<RemoteCheck>;
  /** Sends all work to that computer. Downloads nothing. */
  remoteUse(body: { url: string; tier: TierId }): Promise<RuntimeStatus>;
  /** Back to this machine. */
  remoteForget(): Promise<RuntimeStatus>;
  status(): Promise<RuntimeStatus>;
  settings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;

  /** Whether setup is done. The engine keeps it, so every window and browser on it agrees. */
  onboarding(): Promise<Onboarding>;
  /** The First shot sample. The engine makes and runs it once; every later call returns the same project. */
  startSample(body?: { again?: boolean }): Promise<OnboardingSample>;
  finishOnboarding(): Promise<Onboarding>;

  listProjects(): Promise<Project[]>;
  createProject(body: CreateProjectBody): Promise<Project>;
  getProject(id: string): Promise<Project>;
  updateProject(id: string, patch: ProjectPatch): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  /** Deletes an uploaded image (a reference or a photo) and its links. */
  deleteAsset(id: string, assetId: string): Promise<void>;
  /** Uploads a user file (reference photo, song, voice) into the project. `role` defaults as the engine decides; `boardId` files it in that board. */
  uploadAsset(id: string, file: File, opts?: { role?: "reference" | "music" | "voice"; boardId?: string }): Promise<import("@nightshift/contract").Asset>;

  storyboard(id: string): Promise<Job>;
  /** One use of a project tool (image, video, effect, camera move): a new shot in the project's media and its first job. */
  make(id: string, body: MakeRequest): Promise<Job>;
  still(id: string, shotId: string, body?: StillRequest): Promise<Job>;
  /** A new draft of a shot: a plain motion draft, or with `tool` an effect or a camera move on its still. */
  draft(id: string, shotId: string, body?: DraftRequest): Promise<Job>;
  final(id: string, shotId: string, body: FinalBody): Promise<Job>;
  audio(id: string, body: AudioBody): Promise<Job>;
  exportVideo(id: string, body: ExportRequest): Promise<Job>;
  listJobs(): Promise<Job[]>;
  cancelJob(id: string): Promise<Job>;

  /** URL the browser can load for an asset. Mock assets use a `mock:` scheme handled by `<Media>`. */
  assetUrl(projectId: string, assetId: string): string;

  /** Subscribe to the live event stream. Returns an unsubscribe. */
  events(onEvent: (e: EngineEvent) => void, onConnection?: (connected: boolean) => void): () => void;
}
