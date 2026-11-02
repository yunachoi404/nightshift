/**
 * The morning's news of finals finished overnight counts only finals of projects that are still there: one deleted
 * since has nothing to show, and its link would lead nowhere.
 */
import type { Event, Job, Project } from "@nightshift/contract";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { NightshiftClient } from "@/api/client";
import { EngineProvider } from "@/store/engine";
import { useMorningSummary } from "./morning";

const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
const project: Project = { id: "prj_kept", name: "Kept", template: "blank", aspect: "16:9", brief: {}, shots: [], takes: [], assets: [], timeline: null, createdAt: iso(600), updatedAt: iso(600) };
const final = (id: string, projectId: string): Job => ({ id, projectId, step: "video_final_same_take", mode: "overnight", status: "done", progress: 1, outputAssetIds: [], createdAt: iso(300), finishedAt: iso(60) });

function client(jobs: Job[]): NightshiftClient {
  const answer = <T,>(fn: () => T): Promise<T> => Promise.resolve().then(() => structuredClone(fn()));
  const known: Partial<NightshiftClient> = {
    kind: "http",
    status: () => answer(() => ({ phase: "ready" as const, tier: "apple-64" as const, comfyui: { running: true, url: "http://127.0.0.1:8188", version: "0.3" }, memoryUsedGb: null, mode: "local" as const })),
    settings: () => answer(() => ({ tier: "apple-64", memoryLimitGb: null, overnight: { enabled: true, startAt: "23:00", endAt: "07:00" }, remote: null })),
    onboarding: () => answer(() => ({ done: true, sampleProjectId: null })),
    tiers: () => answer(() => []),
    listProjects: () => answer(() => [project]),
    listJobs: () => answer(() => jobs),
    events: (_onEvent: (e: Event) => void, onConnection) => {
      queueMicrotask(() => onConnection?.(true));
      return () => undefined;
    },
  };
  return new Proxy(known as NightshiftClient, {
    get: (target, key) => (typeof key !== "string" || key in target || key === "then" ? Reflect.get(target, key) : () => new Promise(() => undefined)),
  });
}

function Summary() {
  const s = useMorningSummary();
  return <p>{s ? `${s.done} done in ${s.projectIds.join(" ")}` : "nothing"}</p>;
}

afterEach(() => localStorage.clear());

describe("the overnight summary", () => {
  it("leaves out finals of a project deleted since", async () => {
    // The user last looked before the night.
    localStorage.setItem("nightshift.overnightSeen", iso(500));
    render(
      <EngineProvider client={client([final("job_kept", "prj_kept"), final("job_gone", "prj_gone")])}>
        <Summary />
      </EngineProvider>,
    );
    expect(await screen.findByText("1 done in prj_kept")).toBeTruthy();
  });
});
