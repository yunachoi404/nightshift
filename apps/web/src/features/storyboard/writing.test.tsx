/**
 * The storyboard while the shot list is written. On an 8 GB card that takes minutes, so the line says what is
 * happening and for how long, without repeating itself ("Writing the shot list, writing").
 */
import type { Event, Job, Project } from "@nightshift/contract";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NightshiftClient } from "@/api/client";
import { App } from "@/app/App";
import { EngineProvider } from "@/store/engine";

vi.mock("@/api/config", () => ({
  isMock: () => false,
  getClient: () => {
    throw new Error("each test gives the app its own client");
  },
}));

const PID = "prj_rain";
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

const project: Project = {
  id: PID,
  name: "Rain Rider",
  template: "cinematic_shot",
  aspect: "16:9",
  brief: {},
  shots: [],
  takes: [],
  assets: [],
  timeline: null,
  createdAt: iso(),
  updatedAt: iso(),
};

const writing: Job = { id: "job_text", projectId: PID, step: "text", mode: "now", status: "running", progress: 0.4, message: "Node 2 of 3", outputAssetIds: [], createdAt: iso(40_000), startedAt: iso(40_000) };

function client(): NightshiftClient {
  const answer = <T,>(fn: () => T): Promise<T> => Promise.resolve().then(() => structuredClone(fn()));
  const known: Partial<NightshiftClient> = {
    kind: "http",
    status: () => answer(() => ({ phase: "ready" as const, tier: "nvidia-8" as const, comfyui: { running: true, url: "http://127.0.0.1:8188", version: "0.41.3" }, memoryUsedGb: null, mode: "local" as const })),
    settings: () => answer(() => ({ tier: "nvidia-8" as const, memoryLimitGb: null, overnight: { enabled: false, startAt: "23:00", endAt: "07:00" }, remote: null })),
    onboarding: () => answer(() => ({ done: true, sampleProjectId: null })),
    tiers: () => answer(() => []),
    listProjects: () => answer(() => [project]),
    listJobs: () => answer(() => [writing]),
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

describe("the storyboard while the shot list is written", () => {
  it("says what it is doing and for how long, once", async () => {
    window.location.hash = `#/p/${PID}/storyboard`;
    render(
      <EngineProvider client={client()}>
        <App />
      </EngineProvider>,
    );
    const line = await screen.findByText(/^Writing the shot list/);
    expect(line.textContent).toMatch(/^Writing the shot list, 4\d s$/);
  });
});
