/**
 * A voice or song that failed says why on its own lane of the timeline, with a way to try again. Before, the editor
 * went back to its button and the reason was only a tooltip in the queue, so a voice that ran out of graphics memory
 * looked like nothing happened.
 */
import type { Event, Job, Project } from "@nightshift/contract";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NightshiftClient } from "@/api/client";
import { App } from "@/app/App";
import { EngineProvider } from "@/store/engine";

vi.mock("@/api/config", () => ({
  API_KEY: "nightshift.api",
  buildApiBase: () => "",
  isMock: () => false,
  isDevMock: () => false,
  isBrowserDemo: () => false,
  getClient: () => {
    throw new Error("each test gives the app its own client");
  },
}));

// The filmstrip draws on a canvas, which jsdom lacks.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;

const PID = "prj_rain";
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

const project: Project = {
  id: PID,
  name: "Rain Rider",
  template: "cinematic_shot",
  aspect: "16:9",
  brief: {},
  shots: [{ id: "shot_1", index: 0, prompt: "A red motorcycle in the rain", durationSec: 2.04, stillAssetId: "ast_still", locked: false }],
  takes: [],
  assets: [{ id: "ast_still", kind: "image", path: "assets/ast_still.png", createdAt: iso() }],
  timeline: { clips: [{ shotId: "shot_1", assetId: "ast_still", start: 0, in: 0, out: 2.04 }], audio: [], captions: [], style: {} },
  createdAt: iso(),
  updatedAt: iso(),
};

const job = (id: string, step: Job["step"], status: Job["status"], msAgo: number, error?: string, message?: string): Job => ({
  id,
  projectId: PID,
  step,
  mode: "now",
  status,
  progress: status === "done" ? 1 : 0.33,
  outputAssetIds: [],
  createdAt: iso(msAgo),
  startedAt: iso(msAgo),
  finishedAt: iso(msAgo - 1000),
  ...(error ? { error } : {}),
  ...(message ? { message } : {}),
});

// As the engine reported it on an 8 GB card while another app held 3.5 GB of it.
const OOM =
  "ComfyUI failed in BreezeTTS2VoiceDesign node 2: Allocation on device 0 would exceed allowed memory. (out of memory)\nCurrently allocated     : 3.30 GiB\nRequested               : 8.01 MiB";

function client(jobs: Job[]): NightshiftClient {
  const answer = <T,>(fn: () => T): Promise<T> => Promise.resolve().then(() => structuredClone(fn()));
  const known: Partial<NightshiftClient> = {
    kind: "http",
    status: () => answer(() => ({ phase: "ready" as const, tier: "nvidia-8" as const, comfyui: { running: true, url: "http://127.0.0.1:8188", version: "0.41.3" }, memoryUsedGb: null, mode: "local" as const })),
    settings: () => answer(() => ({ tier: "nvidia-8" as const, memoryLimitGb: null, overnight: { enabled: false, startAt: "23:00", endAt: "07:00" }, remote: null })),
    onboarding: () => answer(() => ({ done: true, sampleProjectId: null })),
    tiers: () => answer(() => []),
    listProjects: () => answer(() => [project]),
    listJobs: () => answer(() => jobs),
    getProject: () => answer(() => project),
    assetUrl: (pid, aid) => `/api/projects/${pid}/assets/${aid}`,
    events: (_onEvent: (e: Event) => void, onConnection) => {
      queueMicrotask(() => onConnection?.(true));
      return () => undefined;
    },
  };
  // Anything else never answers.
  return new Proxy(known as NightshiftClient, {
    get: (target, key) => (typeof key !== "string" || key in target || key === "then" ? Reflect.get(target, key) : () => new Promise(() => undefined)),
  });
}

/** The failure on a lane, and the lane it is on. */
async function laneFailure(title: string) {
  const note = (await screen.findByText(title)).closest(".tl__note") as HTMLElement;
  return { note, lane: note.closest("[data-lane]")?.getAttribute("data-lane") };
}

describe("the editor after a voice or song failed", () => {
  it("says why the voice failed on the Voice lane, in plain words when the card ran out of memory; a song that worked on retry says nothing", async () => {
    window.location.hash = `#/p/${PID}/editor`;
    render(
      <EngineProvider client={client([job("job_m1", "music", "failed", 60_000, "ComfyUI failed in KSampler node 3: boom"), job("job_m2", "music", "done", 50_000), job("job_v1", "voice", "failed", 40_000, OOM)])}>
        <App />
      </EngineProvider>,
    );
    const { note, lane } = await laneFailure("The voice didn't finish.");
    expect(lane).toBe("voice");
    // A job from an engine that only said "Failed": the error alone shows it ran out of memory.
    expect(note.textContent).toContain("Ran out of graphics memory. Close other apps that use the graphics card, then try again.");
    expect(note.textContent).toContain("BreezeTTS2VoiceDesign node 2");
    expect(note.textContent).not.toContain("Currently allocated");
    within(note).getByRole("button", { name: "Try again" });
    expect(screen.queryByText("The music didn't finish.")).toBeNull();
  });

  it("names the other apps that held the card when the engine knew", async () => {
    window.location.hash = `#/p/${PID}/editor`;
    const message = "Ran out of graphics memory. Other apps are using 3.5 GB (python).";
    render(
      <EngineProvider client={client([job("job_v1", "voice", "failed", 40_000, OOM, message)])}>
        <App />
      </EngineProvider>,
    );
    const { note, lane } = await laneFailure("The voice didn't finish.");
    expect(lane).toBe("voice");
    expect(note.textContent).toContain("Ran out of graphics memory. Other apps are using 3.5 GB (python). Close them, then try again.");
    expect(note.textContent).toContain("BreezeTTS2VoiceDesign node 2");
  });
});
