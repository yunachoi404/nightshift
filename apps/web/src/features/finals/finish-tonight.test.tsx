/**
 * Finish N shots tonight, on the board's header and in the editor's Export panel: one press and one confirmation queue
 * tonight's final of every picked take in the cut that has none yet. Before, each card took five clicks (open, Finish
 * tonight, Queue for tonight, Escape, Escape): 125 clicks for one night's 25 finals.
 */
import type { Asset, Event, FinalKind, Job, Project, Settings, TierSummary } from "@nightshift/contract";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
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

// jsdom has no modal dialogs, and the filmstrip draws on a canvas it lacks.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new window.Event("close"));
  };
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});

const PID = "prj_ghost";
const iso = (minute = 0) => new Date(Date.UTC(2026, 10, 1, 8, minute)).toISOString();

const TIER = {
  tier: "unified-128-cuda",
  label: "Spark",
  match: { vendor: "nvidia", minRamGb: 128, minVramGb: 0, unifiedMemory: true },
  downloadGb: 90,
  recommended: true,
  steps: ["still", "video_draft", "video_final_same_take"],
  estimates: { video_final_same_take: { peakGb: 56, seconds: 288, measured: true } },
} as unknown as TierSummary;

/**
 * Four shots on the timeline: 1 and 2 have a picked take and no final, 3 has its final, 4 is a still. A fifth card,
 * with a picked take, sits on the board only.
 */
function ghostShift(): Project {
  const video = (id: string, minute: number): Asset => ({ id, kind: "video", path: `${id}.mp4`, durationSec: 4, createdAt: iso(minute) });
  const shot = (n: number, extra: Partial<Project["shots"][number]> = {}) => ({ id: `shot_${n}`, index: n - 1, prompt: `Shot ${n} prompt`, durationSec: 4, stillAssetId: `still_${n}`, locked: false, ...extra });
  return {
    id: PID,
    name: "Ghost Shift",
    template: "micro_drama",
    aspect: "9:16",
    brief: {},
    shots: [shot(1, { chosenDraftId: "take_1" }), shot(2, { chosenDraftId: "take_2" }), shot(3, { chosenDraftId: "take_3", chosenFinalId: "final_3" }), shot(4), shot(5, { chosenDraftId: "take_5", onTimeline: false })],
    takes: [
      ...[1, 2, 3, 5].map((n) => ({ id: `take_${n}`, shotId: `shot_${n}`, rung: "draft" as const, seed: n, jobId: `job_${n}`, videoAssetId: `v_take_${n}` })),
      { id: "final_3", shotId: "shot_3", rung: "final", finalKind: "same_take", parentTakeId: "take_3", seed: 3, jobId: "job_f3", videoAssetId: "v_final_3" },
    ],
    assets: [...[1, 2, 3, 4, 5].map((n): Asset => ({ id: `still_${n}`, kind: "image", path: `still_${n}.png`, createdAt: iso(n) })), ...[1, 2, 3, 5].map((n) => video(`v_take_${n}`, 10 + n)), video("v_final_3", 20)],
    timeline: {
      clips: [1, 2, 3, 4].map((n) => ({ shotId: `shot_${n}`, assetId: n === 3 ? "v_final_3" : n === 4 ? "still_4" : `v_take_${n}`, start: (n - 1) * 4, in: 0, out: 4 })),
      audio: [],
      captions: [],
      style: {},
    },
    createdAt: iso(),
    updatedAt: iso(),
  };
}

/** "HH:MM" of a time some minutes from now, on this computer's clock. */
function hhmm(minutesFromNow: number): string {
  const d = new Date(Date.now() + minutesFromNow * 60_000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

class Engine {
  finals: Array<{ shotId: string; draftId: string; kind: FinalKind; mode: "now" | "overnight" }> = [];
  settings: Settings;
  constructor(public project: Project, overnight: Settings["overnight"]) {
    this.settings = { tier: "unified-128-cuda", memoryLimitGb: null, overnight, remote: null } as Settings;
  }
  client(): NightshiftClient {
    const answer = <T,>(fn: () => T): Promise<T> => Promise.resolve().then(() => structuredClone(fn()));
    const known: Partial<NightshiftClient> = {
      kind: "http",
      status: () => answer(() => ({ phase: "ready" as const, tier: "unified-128-cuda" as const, comfyui: { running: true, url: "http://127.0.0.1:8188", version: "0.41.3" }, memoryUsedGb: null, mode: "local" as const })),
      settings: () => answer(() => this.settings),
      updateSettings: (patch) => answer(() => (this.settings = { ...this.settings, ...patch })),
      onboarding: () => answer(() => ({ done: true, sampleProjectId: null })),
      tiers: () => answer(() => [TIER]),
      listProjects: () => answer(() => [this.project]),
      listJobs: () => answer((): Job[] => []),
      getProject: () => answer(() => this.project),
      final: (_id, shotId, body) =>
        answer((): Job => {
          this.finals.push({ shotId, ...body });
          return { id: `job_final_${shotId}`, projectId: PID, shotId, step: "video_final_same_take", mode: body.mode, status: "queued", progress: 0, outputAssetIds: [], createdAt: iso(30) };
        }),
      assetUrl: (pid, aid) => `/api/projects/${pid}/assets/${aid}`,
      events: (_onEvent: (e: Event) => void, onConnection) => {
        queueMicrotask(() => onConnection?.(true));
        return () => undefined;
      },
    };
    return new Proxy(known as NightshiftClient, {
      get: (target, key) => (typeof key !== "string" || key in target || key === "then" ? Reflect.get(target, key) : () => new Promise(() => undefined)),
    });
  }
}

function open(engine: Engine, page: "media" | "editor") {
  window.location.hash = `#/p/${PID}/${page}`;
  render(
    <EngineProvider client={engine.client()}>
      <App />
    </EngineProvider>,
  );
}

describe("finish every pick tonight", () => {
  it("on the board: one press and one confirmation queue the cut's picks without a final, and turn the night shift on", async () => {
    const engine = new Engine(ghostShift(), { enabled: false, startAt: hhmm(60), endAt: hhmm(300) });
    open(engine, "media");
    fireEvent.click(await screen.findByRole("button", { name: "Finish 2 shots tonight" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading").textContent).toBe("Finish 2 shots tonight?");
    expect(dialog.textContent).toContain("Nightshift renders the picked take of each of the 2 shots on the timeline");
    expect(dialog.textContent).toContain("10 min");
    expect(dialog.textContent).toContain("This turns overnight runs on.");
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Queue 2 finals" })));
    await waitFor(() =>
      expect(engine.finals).toEqual([
        { shotId: "shot_1", draftId: "take_1", kind: "same_take", mode: "overnight" },
        { shotId: "shot_2", draftId: "take_2", kind: "same_take", mode: "overnight" },
      ]),
    );
    expect(engine.settings.overnight.enabled).toBe(true);
    // Toasts outlive a test: the newest is this one's.
    const toast = (await screen.findAllByText("2 finals queued for tonight")).at(-1)!.closest(".toast") as HTMLElement;
    expect(toast.textContent).toMatch(/Starts at \d/);
  });

  it("inside the night window, says it starts once the GPU is free, never a start time gone by", async () => {
    const engine = new Engine(ghostShift(), { enabled: true, startAt: hhmm(-40), endAt: hhmm(300) });
    open(engine, "media");
    fireEvent.click(await screen.findByRole("button", { name: "Finish 2 shots tonight" }));
    expect(screen.getByRole("dialog").textContent).toContain("The night shift is on now. Once the GPU is free, Nightshift renders");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Queue 2 finals" })));
    // Toasts outlive a test: the newest is this one's.
    const toast = (await screen.findAllByText("2 finals queued for tonight")).at(-1)!.closest(".toast") as HTMLElement;
    expect(toast.textContent).toContain("Starts once the GPU is free. The night shift runs until");
    expect(toast.textContent).not.toMatch(/Starts at/);
  });

  it("in the editor's Export panel, the same press", async () => {
    const engine = new Engine(ghostShift(), { enabled: true, startAt: "23:00", endAt: "07:00" });
    open(engine, "editor");
    const panel = await screen.findByRole("complementary", { name: "Inspector" });
    fireEvent.click(await within(panel).findByRole("button", { name: "Finish 2 shots tonight" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Queue 2 finals" })));
    await waitFor(() => expect(engine.finals.map((f) => f.shotId)).toEqual(["shot_1", "shot_2"]));
  });

  it("shows nothing once every pick in the cut is finished", async () => {
    const project = ghostShift();
    project.shots = project.shots.map((s) => (s.id === "shot_1" || s.id === "shot_2" ? { ...s, onTimeline: false } : s));
    open(new Engine(project, { enabled: true, startAt: "23:00", endAt: "07:00" }), "media");
    await screen.findAllByRole("group", { name: /Shot 3/ });
    expect(screen.queryByRole("button", { name: /tonight$/ })).toBeNull();
  });
});
