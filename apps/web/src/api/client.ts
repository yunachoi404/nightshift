import type {
  Aspect,
  ExportRequest,
  Event as EngineEvent,
  FinalKind,
  HardwareProfile,
  InstallPlan,
  Job,
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

export type ProjectPatch = Partial<Pick<Project, "name" | "shots" | "timeline" | "brief" | "aspect" | "references">>;

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
  /** Uploads a user file (reference photo, song) into the project. */
  deleteAsset(id: string, assetId: string): Promise<void>;
  uploadAsset(id: string, file: File): Promise<import("@nightshift/contract").Asset>;

  storyboard(id: string): Promise<Job>;
  still(id: string, shotId: string, body?: StillRequest): Promise<Job>;
  draft(id: string, shotId: string, body?: { seed?: number }): Promise<Job>;
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
