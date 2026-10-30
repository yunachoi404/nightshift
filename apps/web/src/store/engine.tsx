import type { Aspect, DraftTool, ExportRequest, Job, MakeRequest, Onboarding, OnboardingSample, Project, RemoteCheck, RuntimeStatus, Settings, StillRequest, TierId, TierSummary } from "@nightshift/contract";
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { ApiError, type AudioBody, type CreateProjectBody, type FinalBody, type NightshiftClient, type ProjectPatch } from "@/api/client";
import { getClient } from "@/api/config";

export interface InstallProgress {
  modelId: string | null;
  doneGb: number;
  totalGb: number;
  message: string;
  updatedAt: number;
}

export interface EngineState {
  /** False until the first status fetch answered (with data or an error). */
  loaded: boolean;
  /** The engine answered at least once and the event stream is up. */
  connected: boolean;
  /** The last fetch failed at the network level. */
  unreachable: boolean;
  status: RuntimeStatus | null;
  settings: Settings | null;
  /** Whether setup is done, as the engine keeps it. Not this browser's: every window on the engine agrees. */
  onboarding: Onboarding | null;
  tiers: TierSummary[] | null;
  projects: Record<string, Project>;
  jobs: Record<string, Job>;
  install: InstallProgress | null;
}

type Action =
  | { type: "bootstrap"; status: RuntimeStatus; settings: Settings; onboarding: Onboarding; tiers: TierSummary[] | null; projects: Project[]; jobs: Job[] }
  | { type: "setup"; settings: Settings; tiers: TierSummary[] | null }
  | { type: "unreachable" }
  | { type: "connection"; connected: boolean }
  | { type: "status"; status: RuntimeStatus }
  | { type: "settings"; settings: Settings }
  | { type: "onboarding"; onboarding: Onboarding }
  | { type: "project"; project: Project }
  | { type: "projectRemoved"; id: string }
  | { type: "job"; job: Job }
  | { type: "install"; progress: InstallProgress };

const initial: EngineState = {
  loaded: false,
  connected: false,
  unreachable: false,
  status: null,
  settings: null,
  onboarding: null,
  tiers: null,
  projects: {},
  jobs: {},
  install: null,
};

function reducer(s: EngineState, a: Action): EngineState {
  switch (a.type) {
    case "bootstrap":
      return {
        ...s,
        loaded: true,
        unreachable: false,
        status: a.status,
        settings: a.settings,
        onboarding: a.onboarding,
        tiers: a.tiers,
        projects: Object.fromEntries(a.projects.map((p) => [p.id, p])),
        jobs: Object.fromEntries(a.jobs.map((j) => [j.id, j])),
      };
    case "setup":
      return { ...s, settings: a.settings, tiers: a.tiers ?? s.tiers };
    case "unreachable":
      return { ...s, loaded: true, unreachable: true, connected: false };
    case "connection":
      return { ...s, connected: a.connected, unreachable: a.connected ? false : s.unreachable };
    case "status":
      return { ...s, status: a.status, install: a.status.phase === "installing" ? s.install : null };
    case "settings":
      return { ...s, settings: a.settings };
    case "onboarding":
      return { ...s, onboarding: a.onboarding };
    case "project":
      return { ...s, projects: { ...s.projects, [a.project.id]: a.project } };
    case "projectRemoved": {
      const { [a.id]: _gone, ...rest } = s.projects;
      return { ...s, projects: rest };
    }
    case "job":
      return { ...s, jobs: { ...s.jobs, [a.job.id]: a.job } };
    case "install":
      return { ...s, install: a.progress };
  }
}

export interface EngineActions {
  client: NightshiftClient;
  reload(): Promise<void>;
  refreshSetup(): Promise<void>;
  refreshProject(id: string): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  install(tier: string, memoryLimitGb: number | null): Promise<void>;
  remoteCheck(url: string): Promise<RemoteCheck>;
  remoteUse(url: string, tier: TierId): Promise<RuntimeStatus>;
  remoteForget(): Promise<RuntimeStatus>;
  /** Ask the engine for the First shot sample. Safe to call again: the engine makes it once. */
  startSample(again?: boolean): Promise<OnboardingSample>;
  finishOnboarding(): Promise<Onboarding>;
  createProject(body: CreateProjectBody): Promise<Project>;
  updateProject(id: string, patch: ProjectPatch): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  storyboard(id: string): Promise<Job>;
  /** One use of a project tool from the prompt panel: a new card (a shot, job.shotId) on a board and its first job. */
  make(id: string, body: MakeRequest): Promise<Job>;
  still(id: string, shotId: string, body?: StillRequest): Promise<Job>;
  /** A new version of a shot: a motion draft, or with `tool` an effect or a camera move on its still. */
  draft(id: string, shotId: string, seed?: number, tool?: DraftTool): Promise<Job>;
  final(id: string, shotId: string, body: FinalBody): Promise<Job>;
  audio(id: string, body: AudioBody): Promise<Job>;
  exportVideo(id: string, aspect: Aspect, quality?: ExportRequest["quality"], extra?: Pick<ExportRequest, "kind" | "shotId">): Promise<Job>;
  cancelJob(id: string): Promise<Job>;
}

const StateCtx = createContext<EngineState>(initial);
const ActionsCtx = createContext<EngineActions | null>(null);

export function EngineProvider({ children, client: given }: { children: ReactNode; client?: NightshiftClient }) {
  const client = useMemo(() => given ?? getClient(), [given]);
  const [state, dispatch] = useReducer(reducer, initial);
  const reloading = useRef<Promise<void> | null>(null);

  const refreshSetup = useCallback(async () => {
    const [settings, tiers] = await Promise.all([client.settings(), client.tiers().catch(() => null)]);
    dispatch({ type: "setup", settings, tiers });
  }, [client]);

  const reload = useCallback(async () => {
    if (reloading.current) return reloading.current;
    reloading.current = (async () => {
      try {
        const status = await client.status();
        const [settings, onboarding, tiers, projects, jobs] = await Promise.all([client.settings(), client.onboarding(), client.tiers().catch(() => null), client.listProjects(), client.listJobs()]);
        dispatch({ type: "bootstrap", status, settings, onboarding, tiers, projects, jobs });
      } catch (e) {
        if (e instanceof ApiError && e.code === "unreachable") dispatch({ type: "unreachable" });
        else throw e;
      } finally {
        reloading.current = null;
      }
    })();
    return reloading.current;
  }, [client]);

  useEffect(() => {
    void reload();
    let wasConnected = false;
    const off = client.events(
      (e) => {
        switch (e.type) {
          case "runtime":
            dispatch({ type: "status", status: e.status });
            if (e.status.phase === "ready") void refreshSetup().catch(() => undefined);
            break;
          case "install":
            dispatch({ type: "install", progress: { ...e.progress, updatedAt: Date.now() } });
            break;
          case "job":
            dispatch({ type: "job", job: e.job });
            break;
          case "project":
            dispatch({ type: "project", project: e.project });
            break;
          case "onboarding":
            dispatch({ type: "onboarding", onboarding: e.onboarding });
            break;
        }
      },
      (connected) => {
        dispatch({ type: "connection", connected });
        // Coming back after a drop: resync everything we may have missed.
        if (connected && !wasConnected) void reload();
        // A drop may mean the engine is gone. Probe it; a failed probe shows the unreachable screen.
        if (!connected && wasConnected) window.setTimeout(() => void reload(), 1500);
        wasConnected = connected;
      },
    );
    return off;
  }, [client, reload, refreshSetup]);

  const actions = useMemo<EngineActions>(
    () => ({
      client,
      reload,
      refreshSetup,
      refreshProject: async (pid) => {
        const p = await client.getProject(pid);
        dispatch({ type: "project", project: p });
      },
      updateSettings: async (patch) => {
        const settings = await client.updateSettings(patch);
        dispatch({ type: "settings", settings });
        return settings;
      },
      install: async (tier, memoryLimitGb) => {
        await client.install({ tier, memoryLimitGb });
        const settings = await client.settings();
        dispatch({ type: "settings", settings });
      },
      remoteCheck: (url) => client.remoteCheck(url),
      remoteUse: async (url, tier) => {
        const status = await client.remoteUse({ url, tier });
        dispatch({ type: "status", status });
        const [settings, tiers] = await Promise.all([client.settings(), client.tiers().catch(() => null)]);
        dispatch({ type: "setup", settings, tiers });
        return status;
      },
      remoteForget: async () => {
        const status = await client.remoteForget();
        dispatch({ type: "status", status });
        const [settings, tiers] = await Promise.all([client.settings(), client.tiers().catch(() => null)]);
        dispatch({ type: "setup", settings, tiers });
        return status;
      },
      startSample: async (again) => {
        const sample = await client.startSample(again ? { again } : {});
        if (sample.project) dispatch({ type: "project", project: sample.project });
        dispatch({ type: "onboarding", onboarding: sample.onboarding });
        return sample;
      },
      finishOnboarding: async () => {
        const onboarding = await client.finishOnboarding();
        dispatch({ type: "onboarding", onboarding });
        return onboarding;
      },
      createProject: async (body) => {
        const p = await client.createProject(body);
        dispatch({ type: "project", project: p });
        return p;
      },
      updateProject: async (pid, patch) => {
        const p = await client.updateProject(pid, patch);
        dispatch({ type: "project", project: p });
        return p;
      },
      deleteProject: async (pid) => {
        await client.deleteProject(pid);
        dispatch({ type: "projectRemoved", id: pid });
      },
      storyboard: async (pid) => {
        const j = await client.storyboard(pid);
        dispatch({ type: "job", job: j });
        return j;
      },
      make: async (pid, body) => {
        const j = await client.make(pid, body);
        dispatch({ type: "job", job: j });
        // The new shot arrives on the event stream too; fetch it now so the media shows it at once.
        void client.getProject(pid).then((p) => dispatch({ type: "project", project: p })).catch(() => undefined);
        return j;
      },
      still: async (pid, shotId, body) => {
        const j = await client.still(pid, shotId, body);
        dispatch({ type: "job", job: j });
        return j;
      },
      draft: async (pid, shotId, seed, tool) => {
        const j = await client.draft(pid, shotId, { ...(seed === undefined ? {} : { seed }), ...(tool ? { tool } : {}) });
        dispatch({ type: "job", job: j });
        return j;
      },
      final: async (pid, shotId, body) => {
        const j = await client.final(pid, shotId, body);
        dispatch({ type: "job", job: j });
        return j;
      },
      audio: async (pid, body) => {
        const j = await client.audio(pid, body);
        dispatch({ type: "job", job: j });
        return j;
      },
      exportVideo: async (pid, aspect, quality, extra) => {
        const j = await client.exportVideo(pid, { aspect, quality, ...extra });
        dispatch({ type: "job", job: j });
        return j;
      },
      cancelJob: async (jid) => {
        const j = await client.cancelJob(jid);
        dispatch({ type: "job", job: j });
        return j;
      },
    }),
    [client, reload, refreshSetup],
  );

  return (
    <ActionsCtx.Provider value={actions}>
      <StateCtx.Provider value={state}>{children}</StateCtx.Provider>
    </ActionsCtx.Provider>
  );
}

export function useEngineState(): EngineState {
  return useContext(StateCtx);
}

export function useEngine(): EngineActions {
  const a = useContext(ActionsCtx);
  if (!a) throw new Error("useEngine outside EngineProvider");
  return a;
}

export function useProject(pid: string | undefined): Project | undefined {
  const s = useEngineState();
  return pid ? s.projects[pid] : undefined;
}

export function useProjectList(): Project[] {
  const s = useEngineState();
  return useMemo(() => Object.values(s.projects).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [s.projects]);
}

export function useJobs(): Job[] {
  const s = useEngineState();
  return useMemo(() => Object.values(s.jobs).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), [s.jobs]);
}

export function useProjectJobs(pid: string | undefined): Job[] {
  const jobs = useJobs();
  return useMemo(() => jobs.filter((j) => j.projectId === pid), [jobs, pid]);
}

export const isActive = (j: Job) => j.status === "queued" || j.status === "running";

/** Active job for one shot and step, if any. */
export function activeJobFor(jobs: Job[], shotId: string, steps?: Job["step"][]): Job | undefined {
  return jobs.find((j) => j.shotId === shotId && isActive(j) && (!steps || steps.includes(j.step)));
}
