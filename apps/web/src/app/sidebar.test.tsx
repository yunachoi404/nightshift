/**
 * The left sidebar collapses from its own toggle or with Cmd/Ctrl+\, opens again from the toggle that takes its
 * place at the start of the toolbar, and stays the way it was left when the app opens again.
 */
import type { Event, Project } from "@nightshift/contract";
import { act, fireEvent, render, screen } from "@testing-library/react";
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

function engine(): NightshiftClient {
  const known: Partial<NightshiftClient> = {
    kind: "http",
    status: async () => ({ phase: "ready", tier: "nvidia-8", comfyui: { running: true, url: "http://127.0.0.1:8188", version: "0.41.3" }, memoryUsedGb: null, mode: "local" }),
    settings: async () => ({ tier: "nvidia-8", memoryLimitGb: null, overnight: { enabled: false, startAt: "23:00", endAt: "07:00" }, remote: null }),
    onboarding: async () => ({ done: true, sampleProjectId: null }),
    tiers: async () => [],
    listProjects: async () => [PROJECT],
    listJobs: async () => [],
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

function open() {
  window.location.hash = "#/";
  return render(
    <EngineProvider client={engine()}>
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
