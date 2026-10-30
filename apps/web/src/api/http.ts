import { EventSchema } from "@nightshift/contract";
import { ApiError, type NightshiftClient } from "./client";

/** Talks to the real engine. `base` is "" for same-origin or "http://127.0.0.1:7788". */
export function createHttpClient(base: string): NightshiftClient {
  const root = base.replace(/\/$/, "");

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(root + path, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError(e instanceof Error ? e.message : "Network error", 0, "unreachable");
    }
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const data = (await res.json()) as { error?: string; message?: string };
        message = data.error ?? data.message ?? message;
      } catch {
        /* keep status text */
      }
      throw new ApiError(message, res.status);
    }
    if (res.status === 204 || res.status === 202) {
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
    return (await res.json()) as T;
  }

  return {
    kind: "http",
    hardware: () => call("GET", "/api/hardware"),
    setHardwareManual: (p) => call("POST", "/api/hardware", p),
    tiers: () => call("GET", "/api/tiers"),
    installPlan: (tier) => call("GET", `/api/install/plan?tier=${encodeURIComponent(tier)}`),
    install: (body) => call("POST", "/api/install", body),
    scanModels: (body) => call("POST", "/api/install/scan", body),
    remoteCheck: (url) => call("POST", "/api/remote/check", { url }),
    remoteUse: (body) => call("POST", "/api/remote", body),
    remoteForget: () => call("DELETE", "/api/remote"),
    status: () => call("GET", "/api/status"),
    settings: () => call("GET", "/api/settings"),
    updateSettings: (patch) => call("PATCH", "/api/settings", patch),
    onboarding: () => call("GET", "/api/onboarding"),
    startSample: (body) => call("POST", "/api/onboarding/sample", body ?? {}),
    finishOnboarding: () => call("POST", "/api/onboarding/done"),
    listProjects: () => call("GET", "/api/projects"),
    createProject: (body) => call("POST", "/api/projects", body),
    getProject: (id) => call("GET", `/api/projects/${id}`),
    updateProject: (id, patch) => call("PATCH", `/api/projects/${id}`, patch),
    deleteProject: (id) => call("DELETE", `/api/projects/${id}`),
    deleteAsset: (id, assetId) => call("DELETE", `/api/projects/${id}/assets/${assetId}`),
    uploadAsset: async (id, file, opts) => {
      const form = new FormData();
      form.append("file", file, file.name);
      const query = new URLSearchParams({ ...(opts?.role ? { role: opts.role } : {}), ...(opts?.boardId ? { board: opts.boardId } : {}) }).toString();
      let res: Response;
      try {
        res = await fetch(`${root}/api/projects/${id}/assets${query ? `?${query}` : ""}`, { method: "POST", body: form });
      } catch (e) {
        throw new ApiError(e instanceof Error ? e.message : "Network error", 0, "unreachable");
      }
      if (!res.ok) throw new ApiError(`Upload failed (${res.status})`, res.status);
      return (await res.json()) as import("@nightshift/contract").Asset;
    },
    storyboard: (id) => call("POST", `/api/projects/${id}/storyboard`),
    make: (id, body) => call("POST", `/api/projects/${id}/make`, body),
    still: (id, shotId, body) => call("POST", `/api/projects/${id}/shots/${shotId}/still`, body),
    draft: (id, shotId, body) => call("POST", `/api/projects/${id}/shots/${shotId}/draft`, body ?? {}),
    final: (id, shotId, body) => call("POST", `/api/projects/${id}/shots/${shotId}/final`, body),
    audio: (id, body) => call("POST", `/api/projects/${id}/audio`, body),
    exportVideo: (id, body) => call("POST", `/api/projects/${id}/export`, body),
    listJobs: () => call("GET", "/api/jobs"),
    cancelJob: (id) => call("POST", `/api/jobs/${id}/cancel`),
    assetUrl: (projectId, assetId) => `${root}/api/projects/${projectId}/assets/${assetId}`,
    events: (onEvent, onConnection) => {
      const es = new EventSource(`${root}/api/events`);
      es.onopen = () => onConnection?.(true);
      es.onerror = () => onConnection?.(false);
      es.onmessage = (m) => {
        try {
          const parsed = EventSchema.safeParse(JSON.parse(m.data as string));
          if (parsed.success) onEvent(parsed.data);
        } catch {
          /* ignore malformed frames */
        }
      };
      return () => es.close();
    },
  };
}
