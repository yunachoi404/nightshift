import type { Asset } from "@nightshift/contract";
import { ApiError, type NightshiftClient } from "../client";
import { getMockEngine, MockHttpError, type MockFlavor } from "./engine";

/** Wraps the in-browser engine in the same promise-based interface as the HTTP client, with a little latency. */
export function createMockClient(flavor: MockFlavor = "dev"): NightshiftClient {
  const engine = getMockEngine(flavor);

  async function call<T>(fn: () => T, ms = 90): Promise<T> {
    if (engine.dev.faults.unreachable) {
      await sleep(600);
      throw new ApiError("Could not reach the engine.", 0, "unreachable");
    }
    await sleep(ms + Math.random() * 60);
    try {
      return fn();
    } catch (e) {
      if (e instanceof MockHttpError) throw new ApiError(e.message, e.status);
      throw e;
    }
  }

  return {
    kind: "mock",
    hardware: () => call(() => engine.hardware(), 1400),
    setHardwareManual: (p) => call(() => engine.setHardwareManual(p)),
    tiers: () => call(() => engine.tiers(), 300),
    installPlan: (tier) => call(() => engine.installPlan(tier), 350),
    install: (body) => call(() => engine.install(body)),
    remoteCheck: (url) => call(() => engine.remoteCheck(url), 900),
    remoteUse: (body) => call(() => engine.remoteUse(body), 500),
    remoteForget: () => call(() => engine.remoteForget(), 300),
    status: () => call(() => engine.status(), 40),
    settings: () => call(() => engine.settings(), 40),
    updateSettings: (patch) => call(() => engine.updateSettings(patch)),
    onboarding: () => call(() => engine.onboarding(), 40),
    startSample: (body) => call(() => engine.startSample(body?.again === true)),
    finishOnboarding: () => call(() => engine.finishOnboarding(), 40),
    listProjects: () => call(() => engine.listProjects(), 60),
    createProject: (body) => call(() => engine.createProject(body)),
    getProject: (pid) => call(() => engine.getProject(pid), 40),
    updateProject: (pid, patch) => call(() => engine.updateProject(pid, patch), 30),
    deleteProject: (pid) => call(() => engine.deleteProject(pid)),
    deleteAsset: (pid, assetId) => call(() => engine.deleteAsset(pid, assetId)),
    uploadAsset: async (pid, file, opts) => {
      const dataUrl = await fileToSmallDataUrl(file);
      const kind: Asset["kind"] = file.type.startsWith("audio") ? "audio" : "image";
      return call(() => engine.uploadAsset(pid, dataUrl, kind, { role: opts?.role ?? (kind === "audio" ? "music" : "reference") }, opts?.boardId), 400);
    },
    storyboard: (pid) => call(() => engine.storyboard(pid)),
    make: (pid, body) => call(() => engine.make(pid, body)),
    still: (pid, shotId, body) => call(() => engine.still(pid, shotId, body)),
    draft: (pid, shotId, body) => call(() => engine.draft(pid, shotId, body)),
    final: (pid, shotId, body) => call(() => engine.final(pid, shotId, body)),
    audio: (pid, body) => call(() => engine.audio(pid, body)),
    exportVideo: (pid, body) => call(() => engine.exportVideo(pid, body)),
    listJobs: () => call(() => engine.listJobs(), 40),
    cancelJob: (jid) => call(() => engine.cancelJob(jid)),
    assetUrl: (pid, assetId) => engine.assetUrl(pid, assetId),
    events: (onEvent, onConnection) => engine.subscribe(onEvent, onConnection),
  };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Images shrink to 640px so they fit in localStorage. Audio keeps a tiny stub; the mock never plays it. */
async function fileToSmallDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image")) return `mock:audio:upload:${file.name}`;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bitmap.width * scale);
  c.height = Math.round(bitmap.height * scale);
  c.getContext("2d")!.drawImage(bitmap, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.82);
}
