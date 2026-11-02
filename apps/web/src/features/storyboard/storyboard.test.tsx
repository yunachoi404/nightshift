/**
 * The Storyboard page's shot list: its rewrite says what it keeps, as the Media board's does; a writer's list that was
 * not used says why, with Try again; and the writer at work can be stopped.
 */
import type { Event, Job, Project, Settings, TierSummary } from "@nightshift/contract";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeAll, describe, expect, it } from "vitest";
import type { NightshiftClient } from "@/api/client";
import { EngineProvider, useProject } from "@/store/engine";
import { Toaster } from "@/ui/primitives";
import { Storyboard } from "./Storyboard";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new window.Event("close"));
  };
});

const iso = () => new Date(Date.UTC(2026, 10, 1, 9, 0)).toISOString();
const PID = "prj_board";
const TIER = { tier: "apple-64", label: "Mac", steps: ["text", "still", "video_draft"], models: {}, estimates: {} } as unknown as TierSummary;

function ad(extra: Partial<Project> = {}): Project {
  return {
    id: PID,
    name: "Lumi ad",
    template: "product_ad",
    aspect: "9:16",
    brief: { product: "Lumi, a sunrise lamp" },
    shots: [
      { id: "shot_1", index: 0, prompt: "Lumi glows on a nightstand", cameraMove: "static", durationSec: 3, locked: false },
      { id: "shot_2", index: 1, prompt: "A sleeper smiles awake", cameraMove: "static", durationSec: 3, locked: false },
    ],
    takes: [],
    assets: [],
    timeline: null,
    createdAt: iso(),
    updatedAt: iso(),
    ...extra,
  };
}

/** One project and its jobs; it records what the page asks for. */
function engine(project: Project, jobs: Job[] = []) {
  const asked = { storyboards: 0, cancelled: [] as string[] };
  const answer = <T,>(fn: () => T): Promise<T> => Promise.resolve().then(() => structuredClone(fn()));
  const settings = { tier: "apple-64", memoryLimitGb: null, overnight: { enabled: false, startAt: "23:00", endAt: "07:00" }, remote: null } as Settings;
  const known: Partial<NightshiftClient> = {
    kind: "http",
    status: () => answer(() => ({ phase: "ready" as const, tier: "apple-64" as const, comfyui: { running: true, url: "http://127.0.0.1:8188", version: "0.3" }, memoryUsedGb: null, mode: "local" as const })),
    settings: () => answer(() => settings),
    onboarding: () => answer(() => ({ done: true, sampleProjectId: null })),
    tiers: () => answer(() => [TIER]),
    listProjects: () => answer(() => [project]),
    listJobs: () => answer(() => jobs),
    getProject: () => answer(() => project),
    storyboard: () => answer(() => (asked.storyboards++, { id: "job_text", projectId: PID, step: "text" as const, mode: "now" as const, status: "queued" as const, progress: 0, outputAssetIds: [], createdAt: iso() })),
    cancelJob: (id) => answer(() => (asked.cancelled.push(id), { ...jobs.find((j) => j.id === id)!, status: "cancelled" as const })),
    assetUrl: (pid, aid) => `/api/projects/${pid}/assets/${aid}`,
    events: (_onEvent: (e: Event) => void, onConnection) => {
      queueMicrotask(() => onConnection?.(true));
      return () => undefined;
    },
  };
  const client = new Proxy(known as NightshiftClient, {
    get: (target, key) => (typeof key !== "string" || key in target || key === "then" ? Reflect.get(target, key) : () => new Promise(() => undefined)),
  });
  return { client, asked };
}

/** The page once its project is in, as the project's layout shows it. */
function Page() {
  return useProject(PID) ? <Storyboard /> : null;
}

function open(client: NightshiftClient) {
  return render(
    <EngineProvider client={client}>
      <MemoryRouter initialEntries={[`/p/${PID}/storyboard`]}>
        <Routes>
          <Route path="/p/:id/storyboard" element={<Page />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </EngineProvider>,
  );
}

describe("the Storyboard page's shot list", () => {
  it("asks before a rewrite and says nothing made is deleted, as the Media board does", async () => {
    const { client, asked } = engine(ad());
    open(client);
    fireEvent.click(await screen.findByRole("button", { name: "Rewrite shot list" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/so nothing you made is deleted/)).toBeTruthy();
    expect(screen.queryByText(/Takes for replaced shots are removed/)).toBeNull();
    await act(async () => void fireEvent.click(within(dialog).getByRole("button", { name: "Rewrite shot list" })));
    expect(asked.storyboards).toBe(1);
  });

  it("says when the writer's list was not used, with Try again", async () => {
    const { client, asked } = engine(ad({ shotList: { by: "template", note: "The writer tried 3 times, but its shot list did not fit this template." } }));
    open(client);
    expect(await screen.findByText("The writer tried 3 times, but its shot list did not fit this template.")).toBeTruthy();
    expect(screen.getByText("These are the template's shots, not your brief's")).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Try again" })));
    expect(asked.storyboards).toBe(1);
  });

  it("lets the writer at work be stopped", async () => {
    const writing: Job = { id: "job_writing", projectId: PID, step: "text", mode: "now", status: "running", progress: 0.2, outputAssetIds: [], createdAt: iso(), startedAt: iso() };
    const { client, asked } = engine(ad(), [writing]);
    open(client);
    await screen.findByText(/Writing the shot list/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(asked.cancelled).toEqual(["job_writing"]));
  });
});
