/**
 * The left sidebar collapses from its own toggle or with Cmd/Ctrl+\, opens again from the toggle that takes its
 * place at the start of the toolbar, and stays the way it was left when the app opens again.
 */
import type { Event, Job, Project, Settings } from "@nightshift/contract";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NightshiftClient } from "@/api/client";
import { EngineProvider } from "@/store/engine";
import { App } from "./App";

vi.mock("@/api/config", () => ({
  API_KEY: "nightshift.api",
  buildApiBase: () => "",
  isMock: () => false,
  isDevMock: () => false,
  isBrowserDemo: () => false,
  getClient: () => {
    throw new Error("the test gives the app its own client");
  },
}));

const iso = () => new Date().toISOString();
const PROJECT: Project = { id: "prj_one", name: "Lighthouse", template: "blank", aspect: "16:9", brief: {}, shots: [], takes: [], assets: [], timeline: null, createdAt: iso(), updatedAt: iso() };

function engine(jobs: Job[] = [], overnight: Settings["overnight"] = { enabled: false, startAt: "23:00", endAt: "07:00" }): NightshiftClient {
  const known: Partial<NightshiftClient> = {
    kind: "http",
    status: async () => ({ phase: "ready", tier: "nvidia-8", comfyui: { running: true, url: "http://127.0.0.1:8188", version: "0.41.3" }, memoryUsedGb: null, mode: "local" }),
    settings: async () => ({ tier: "nvidia-8", memoryLimitGb: null, overnight, remote: null }),
    hardware: async () => ({ os: "linux", arch: "x64", cpu: "Ryzen 7", ramGb: 32, gpus: [{ vendor: "nvidia", name: "NVIDIA GeForce RTX 4070", vramGb: 12, unifiedMemory: false }], freeDiskGb: 400, source: "detected" }),
    onboarding: async () => ({ done: true, sampleProjectId: null }),
    tiers: async () => [],
    listProjects: async () => [PROJECT],
    listJobs: async () => jobs,
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

function open(client = engine()) {
  window.location.hash = "#/";
  return render(
    <EngineProvider client={client}>
      <App />
    </EngineProvider>,
  );
}

/** The project's row in the sidebar, or null when the sidebar is hidden. */
const projectRow = () => screen.queryByRole("link", { name: "Lighthouse" });

describe("the sidebar", () => {
  it("collapses from its toggle, opens from the toolbar, and remembers across a restart", async () => {
    const first = open();
    await screen.findByRole("heading", { name: "Projects" });
    expect(projectRow()).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Show sidebar" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
    expect(projectRow()).toBeNull();
    expect(screen.getByRole("complementary", { hidden: true }).hasAttribute("inert")).toBe(true);
    expect(localStorage.getItem("nightshift.sidebar.collapsed")).toBe("true");
    first.unmount();

    // Opened again: still collapsed, with the toggle first in the toolbar.
    const second = open();
    await screen.findByRole("heading", { name: "Projects" });
    expect(projectRow()).toBeNull();
    const show = screen.getByRole("button", { name: "Show sidebar" });
    expect(show.closest(".toolbar")).not.toBeNull();
    expect(show.getAttribute("title")).toMatch(/\\\)$/);

    fireEvent.click(show);
    expect(projectRow()).not.toBeNull();
    expect(localStorage.getItem("nightshift.sidebar.collapsed")).toBe("false");
    second.unmount();

    open();
    await screen.findByRole("heading", { name: "Projects" });
    expect(projectRow()).not.toBeNull();
  });

  it("toggles with Cmd or Ctrl and backslash, even from a field", async () => {
    open();
    await screen.findByRole("heading", { name: "Projects" });
    // Let the page's effects settle first, so the shortcut's listener is there on a slow machine too.
    await act(async () => undefined);

    act(() => void fireEvent.keyDown(window, { key: "\\", metaKey: true }));
    expect(projectRow()).toBeNull();

    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    act(() => void fireEvent.keyDown(field, { key: "\\", ctrlKey: true }));
    expect(projectRow()).not.toBeNull();
    field.remove();
  });
});

/** A final for the night of the project. */
const final = (id: string, status: Job["status"] = "queued"): Job => ({ id, projectId: PROJECT.id, shotId: "shot_1", step: "video_final_same_take", mode: "overnight", status, progress: 0, outputAssetIds: [], createdAt: iso() });
/** "HH:00" `hours` from now, so the night window is closed while the test runs, whatever the time. */
const later = (hours: number) => `${String((new Date().getHours() + hours) % 24).padStart(2, "0")}:00`;
const twelveHour = (hhmm: string) => {
  const h = Number(hhmm.slice(0, 2));
  return `${h % 12 === 0 ? 12 : h % 12} ${h >= 12 ? "pm" : "am"}`;
};

describe("the sidebar's foot", () => {
  it("names the graphics card and says it is idle, beside Settings", async () => {
    open();
    const foot = await screen.findByRole("button", { name: "NVIDIA GeForce RTX 4070 · idle" });
    expect(foot.closest(".sidebar__foot")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("#/settings");
    // No finals wait for tonight, so there is no Tonight card.
    expect(screen.queryByRole("link", { name: /^Tonight/ })).toBeNull();
  });

  it("shows tonight's finals in a card with when the night starts and a mark per final, and opens the queue", async () => {
    const startAt = later(2);
    open(engine([final("job_a"), final("job_b"), final("job_c")], { enabled: true, startAt, endAt: later(4) }));
    const card = await screen.findByRole("link", { name: `Tonight, ${twelveHour(startAt)}. 3 finals queued. Open the queue` });
    // The same words and numbers as the Queue's Tonight: without the setup's estimates a final counts five minutes.
    expect(card.textContent).toContain("3 finals, about 15 min of work");
    expect(within(card).getByText(twelveHour(startAt))).toBeTruthy();
    expect(card.querySelectorAll(".side__tonight-mark")).toHaveLength(3);
    // The card takes the place of the foot's old "for tonight" line: the foot still names the machine.
    expect(screen.queryByText(/for tonight/)).toBeNull();
    expect(screen.getByRole("button", { name: "NVIDIA GeForce RTX 4070 · idle" })).toBeTruthy();
    // The Queue row counts them in its pill.
    expect(screen.getByRole("link", { name: "Queue 3" })).toBeTruthy();

    fireEvent.click(card);
    await waitFor(() => expect(window.location.hash).toBe("#/queue"));
  });

  it("says when the night shift is off, so the finals wait", async () => {
    open(engine([final("job_a")], { enabled: false, startAt: "23:00", endAt: "07:00" }));
    const card = await screen.findByRole("link", { name: "Tonight, Paused. 1 final queued. Open the queue" });
    expect(card.textContent).toContain("1 final queued. The night shift is off in Settings.");
  });
});
