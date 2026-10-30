/**
 * The queue's recent jobs. A failed job says why on its row; before, the row said "Failed" and the reason was only a
 * tooltip. Every row's time and outcome share one column at its end, so "Failed" and "Done" line up whatever the time
 * reads ("1 min ago", "12 min ago").
 */
import type { Event, Job, Project } from "@nightshift/contract";
import { render, screen, waitFor } from "@testing-library/react";
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

const PID = "prj_rain";
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const project: Project = { id: PID, name: "Rain Rider", template: "cinematic_shot", aspect: "16:9", brief: {}, shots: [], takes: [], assets: [], timeline: null, createdAt: iso(), updatedAt: iso() };
const shots = (n: number): Project["shots"] => Array.from({ length: n }, (_, i) => ({ id: `shot_${i + 1}`, index: i, prompt: `Shot ${i + 1}`, durationSec: 4, locked: false }));
const OOM = "ComfyUI failed in BreezeTTS2VoiceDesign node 2: Allocation on device 0 would exceed allowed memory. (out of memory)\nCurrently allocated     : 3.30 GiB";

function job(id: string, step: Job["step"], status: Job["status"], minAgo: number, extra: Partial<Job> = {}): Job {
  return { id, projectId: PID, step, mode: "now", status, progress: 1, outputAssetIds: [], createdAt: iso(minAgo * 60_000 + 5000), finishedAt: iso(minAgo * 60_000), ...extra };
}

function client(jobs: Job[], p: Project = project, overnight = { enabled: false, startAt: "23:00", endAt: "07:00" }): NightshiftClient {
  const answer = <T,>(fn: () => T): Promise<T> => Promise.resolve().then(() => structuredClone(fn()));
  const known: Partial<NightshiftClient> = {
    kind: "http",
    status: () => answer(() => ({ phase: "ready" as const, tier: "nvidia-8", comfyui: { running: true, url: "http://127.0.0.1:8188", version: "0.41.3" }, memoryUsedGb: null, mode: "local" as const })),
    settings: () => answer(() => ({ tier: "nvidia-8", memoryLimitGb: null, overnight, remote: null })),
    onboarding: () => answer(() => ({ done: true, sampleProjectId: null })),
    tiers: () => answer(() => []),
    listProjects: () => answer(() => [p]),
    listJobs: () => answer(() => jobs),
    getProject: () => answer(() => p),
    events: (_onEvent: (e: Event) => void, onConnection) => {
      queueMicrotask(() => onConnection?.(true));
      return () => undefined;
    },
  };
  return new Proxy(known as NightshiftClient, {
    get: (target, key) => (typeof key !== "string" || key in target || key === "then" ? Reflect.get(target, key) : () => new Promise(() => undefined)),
  });
}

describe("the queue's recent jobs", () => {
  it("a failed job says why on its row, and every outcome sits in the row's end column", async () => {
    window.location.hash = "#/queue";
    render(
      <EngineProvider client={client([
        job("job_music", "music", "done", 16),
        job("job_v1", "voice", "failed", 12, { error: "ComfyUI failed in BreezeTTS2LoadModel node 1: property 'upsample' of 'Qwen3TTSTokenizerV2Encoder' object has no setter", message: "Failed" }),
        job("job_v2", "voice", "failed", 1, { error: OOM, message: "Ran out of graphics memory. Other apps are using 3.5 GB (python)." }),
      ])}>
        <App />
      </EngineProvider>,
    );
    const crowded = await screen.findByText("Ran out of graphics memory. Other apps are using 3.5 GB (python).");
    // Shown on the row, not only as a tooltip; the full error is the tooltip.
    expect(crowded.closest(".q-item__reason")?.getAttribute("title")).toBe(OOM);
    expect(screen.getByText("ComfyUI failed in BreezeTTS2LoadModel node 1: property 'upsample' of 'Qwen3TTSTokenizerV2Encoder' object has no setter")).toBeTruthy();

    const rows = [...document.querySelectorAll(".q-item")];
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.querySelector(".q-item__end")?.textContent)).toEqual(["1 min agoFailed", "12 min agoFailed", "16 min agoDone"]);
    // Nothing else on the row says how it ended.
    for (const r of rows) expect(r.querySelector(".q-item__sub")?.textContent).toBe("Rain Rider");
  });
});

describe("the queue's finals for tonight", () => {
  const night = (id: string, shot: number, model: "LTX-2.5" | "MiniMax H3", nightGroup: number, minAgo: number): Job =>
    job(id, model === "LTX-2.5" ? "video_final_same_take" : "video_final_remaster", "queued", minAgo, {
      mode: "overnight", shotId: `shot_${shot}`, model, nightGroup, progress: 0, message: "Runs tonight, 23:00 to 07:00", finishedAt: undefined,
    });

  it("are grouped by the model they share, in the order they run, under a note that says why", async () => {
    window.location.hash = "#/queue";
    render(
      <EngineProvider client={client([
        night("job_l1", 1, "LTX-2.5", 1, 9),
        night("job_h1", 2, "MiniMax H3", 2, 8),
        night("job_l2", 3, "LTX-2.5", 1, 7),
        job("job_still", "still", "queued", 6, { shotId: "shot_4", progress: 0, finishedAt: undefined }),
      ], { ...project, shots: shots(4) }, { enabled: true, startAt: "23:00", endAt: "07:00" })}>
        <App />
      </EngineProvider>,
    );
    await screen.findByText("Finals that share a model run back to back, so each model loads once. Groups go in the order you queued them.");
    const batches = [...document.querySelectorAll(".q-batch")];
    expect(batches.map((b) => b.getAttribute("aria-label"))).toEqual(["LTX-2.5, 2 finals", "MiniMax H3, 1 final"]);
    expect(batches.map((b) => [...b.querySelectorAll(".q-item__name")].map((n) => n.textContent))).toEqual([
      ["Final, same take, shot 1", "Final, same take, shot 3"],
      ["Final, remaster, shot 2"],
    ]);
    expect(batches[0]!.querySelector(".q-item__sub span")?.textContent).toBe("Runs tonight, 23:00 to 07:00");
    // Quick work waits apart, above.
    const waiting = screen.getByText("Waiting").closest("section")!;
    expect([...waiting.querySelectorAll(".q-item__name")].map((n) => n.textContent)).toEqual(["Still, shot 4"]);
  });

  it("one group needs no note, and says how many more follow the one running", async () => {
    window.location.hash = "#/queue";
    render(
      <EngineProvider client={client([
        { ...night("job_l1", 1, "LTX-2.5", 1, 9), status: "running", startedAt: iso(60_000), message: "Generating" },
        night("job_l2", 2, "LTX-2.5", 1, 8),
      ], { ...project, shots: shots(2) }, { enabled: true, startAt: "23:00", endAt: "07:00" })}>
        <App />
      </EngineProvider>,
    );
    const batch = await waitFor(() => {
      const b = document.querySelector(".q-batch");
      if (!b) throw new Error("no group yet");
      return b;
    });
    expect(batch.getAttribute("aria-label")).toBe("LTX-2.5, 1 more final");
    expect(screen.queryByText(/so each model loads once/)).toBeNull();
  });
});
