/**
 * The editor as the dogfood night left it: the export's result sat at the inspector's foot, below the fold, and in the
 * media list a final's "Final" chip ran into its length ("Fin· 0:04"). An export that lands now comes into view, and a
 * final's card wears one chip.
 */
import type { Asset, Event, Job, Project } from "@nightshift/contract";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
});
afterEach(() => {
  delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
});

const PID = "prj_ghost";
const iso = (minute = 0) => new Date(Date.UTC(2026, 10, 1, 9, minute)).toISOString();

function ghostShift(): Project {
  const video = (id: string, minute: number): Asset => ({ id, kind: "video", path: `${id}.mp4`, durationSec: 4, createdAt: iso(minute) });
  return {
    id: PID,
    name: "Ghost Shift",
    template: "micro_drama",
    aspect: "9:16",
    brief: {},
    shots: [
      { id: "shot_1", index: 0, prompt: "Rin at the counter", durationSec: 4, stillAssetId: "still_1", chosenDraftId: "take_1", chosenFinalId: "final_1", locked: false },
      { id: "shot_2", index: 1, prompt: "Mochi eats the bun", durationSec: 4, stillAssetId: "still_2", chosenDraftId: "take_2", locked: false },
    ],
    takes: [
      { id: "take_1", shotId: "shot_1", rung: "draft", seed: 1, jobId: "j1", videoAssetId: "v_take_1" },
      { id: "final_1", shotId: "shot_1", rung: "final", finalKind: "same_take", parentTakeId: "take_1", seed: 1, jobId: "j3", videoAssetId: "v_final_1" },
      { id: "take_2", shotId: "shot_2", rung: "draft", seed: 2, jobId: "j2", videoAssetId: "v_take_2" },
    ],
    assets: [
      { id: "still_1", kind: "image", path: "still_1.png", createdAt: iso(1) },
      { id: "still_2", kind: "image", path: "still_2.png", createdAt: iso(2) },
      video("v_take_1", 3),
      video("v_take_2", 4),
      video("v_final_1", 5),
    ],
    timeline: {
      clips: [
        { shotId: "shot_1", assetId: "v_final_1", start: 0, in: 0, out: 4 },
        { shotId: "shot_2", assetId: "v_take_2", start: 4, in: 0, out: 4 },
      ],
      audio: [],
      captions: [],
      style: {},
    },
    createdAt: iso(),
    updatedAt: iso(),
  };
}

function open(project: Project, jobs: Job[]) {
  let push: ((e: Event) => void) | undefined;
  const answer = <T,>(fn: () => T): Promise<T> => Promise.resolve().then(() => structuredClone(fn()));
  const known: Partial<NightshiftClient> = {
    kind: "http",
    status: () => answer(() => ({ phase: "ready" as const, tier: "unified-128-cuda" as const, comfyui: { running: true, url: "http://127.0.0.1:8188", version: "0.41.3" }, memoryUsedGb: null, mode: "local" as const })),
    settings: () => answer(() => ({ tier: "unified-128-cuda" as const, memoryLimitGb: null, overnight: { enabled: true, startAt: "23:00", endAt: "07:00" }, remote: null })),
    onboarding: () => answer(() => ({ done: true, sampleProjectId: null })),
    tiers: () => answer(() => []),
    listProjects: () => answer(() => [project]),
    listJobs: () => answer(() => jobs),
    getProject: () => answer(() => project),
    assetUrl: (pid, aid) => `/api/projects/${pid}/assets/${aid}`,
    events: (onEvent: (e: Event) => void, onConnection) => {
      push = onEvent;
      queueMicrotask(() => onConnection?.(true));
      return () => undefined;
    },
  };
  const client = new Proxy(known as NightshiftClient, {
    get: (target, key) => (typeof key !== "string" || key in target || key === "then" ? Reflect.get(target, key) : () => new Promise(() => undefined)),
  });
  window.location.hash = `#/p/${PID}/editor`;
  render(
    <EngineProvider client={client}>
      <App />
    </EngineProvider>,
  );
  return { send: (e: Event) => act(() => push?.(e)) };
}

const exportJob = (status: Job["status"], outputAssetIds: string[] = []): Job => ({ id: "job_export", projectId: PID, step: "export", mode: "now", status, progress: status === "done" ? 1 : 0.5, outputAssetIds, createdAt: iso(10), ...(status === "done" ? { finishedAt: iso(11), message: "Exported 1080x1920, 8.0 s, 3.1 MB, captions" } : {}) });

describe("the editor's export and media list", () => {
  it("brings an export that lands into view at the inspector's foot", async () => {
    const scrolled = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrolled;
    const project = ghostShift();
    const { send } = open(project, [exportJob("running")]);
    await screen.findByRole("complementary", { name: "Inspector" });
    expect(scrolled).not.toHaveBeenCalled();

    const done = { ...project, assets: [...project.assets, { id: "export_1", kind: "video" as const, role: "export" as const, path: "export_1.mp4", width: 1080, height: 1920, durationSec: 8, createdAt: iso(11) }] };
    send({ type: "project", project: done });
    send({ type: "job", job: exportJob("done", ["export_1"]) });
    await screen.findByText("Ghost Shift.mp4");
    await waitFor(() => expect(scrolled).toHaveBeenCalledWith({ block: "nearest", behavior: "smooth" }));
    expect((scrolled.mock.contexts.at(-1) as HTMLElement).classList.contains("insp__file")).toBe(true);
  });

  it("gives a final's card one chip, Final, and a draft's its length", async () => {
    open(ghostShift(), []);
    const media = await screen.findByRole("complementary", { name: "Media" });
    const final = await within(media).findByTitle(/^Shot 1/);
    expect(within(final).getByText("Final")).toBeTruthy();
    expect(final.querySelector(".edm__dur")).toBeNull();
    const draft = within(media).getByTitle(/^Shot 2/);
    expect(draft.querySelector(".edm__dur")?.textContent).toBe("0:04");
  });
});
