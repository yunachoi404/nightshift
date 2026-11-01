/**
 * The GPU status pill opens what the GPU is doing in place, over the page, instead of taking you to the queue: why it
 * waits, and a way on to the full queue when you want it.
 */
import type { HardwareProfile, RuntimeStatus, Settings } from "@nightshift/contract";
import { fireEvent, render, screen, within } from "@testing-library/react";
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

/** A set-up engine whose GPU computer is away. */
const AWAY: RuntimeStatus = { phase: "ready", tier: "unified-128-cuda", comfyui: { running: false, url: null, version: null }, memoryUsedGb: null, mode: "remote" };
const SETTINGS: Settings = { tier: "unified-128-cuda", memoryLimitGb: null, overnight: { enabled: false, startAt: "23:00", endAt: "07:00" }, remote: { url: "http://spark:8190", name: "NVIDIA GB10" } };

/** The judges' preview: the engine runs on the Spark itself and attaches to the GPU's proxy there. */
const ATTACHED: RuntimeStatus = { phase: "ready", tier: "unified-128-cuda", comfyui: { running: true, url: "http://127.0.0.1:8191", version: null }, memoryUsedGb: null, mode: "attach" };
const SPARK: HardwareProfile = { os: "linux", arch: "arm64", cpu: "Cortex-X925", ramGb: 121.7, gpus: [{ vendor: "nvidia", name: "NVIDIA GB10", vramGb: 121.7, computeCapability: "12.1", unifiedMemory: true }], freeDiskGb: 37, source: "detected" };

function engine(status = AWAY, settings = SETTINGS): NightshiftClient {
  const known: Partial<NightshiftClient> = {
    kind: "http",
    status: async () => status,
    settings: async () => settings,
    hardware: async () => SPARK,
    onboarding: async () => ({ done: true, sampleProjectId: null }),
    tiers: async () => [],
    listProjects: async () => [],
    listJobs: async () => [],
    assetUrl: (pid, aid) => `/api/projects/${pid}/assets/${aid}`,
    events: (_onEvent, onConnection) => {
      queueMicrotask(() => onConnection?.(true));
      return () => undefined;
    },
  };
  return new Proxy(known as NightshiftClient, {
    get: (target, key) => (typeof key !== "string" || key in target || key === "then" ? Reflect.get(target, key) : () => new Promise(() => undefined)),
  });
}

describe("the GPU status pill", () => {
  it("opens what the GPU is doing over the page, says why it waits, and closes on Escape", async () => {
    window.location.hash = "#/";
    render(
      <EngineProvider client={engine()}>
        <App />
      </EngineProvider>,
    );
    await screen.findByRole("heading", { name: "Projects" });
    // The foot of the sidebar names the GPU and says it waits.
    const [pill] = await screen.findAllByRole("button", { name: "NVIDIA GB10 · waiting" });
    fireEvent.click(pill!);

    const pop = screen.getByRole("dialog", { name: "What the GPU is doing" });
    expect(pop.textContent).toContain("busy with other work");
    expect(within(pop).getByRole("link", { name: /Open the queue/ }).getAttribute("href")).toBe("#/queue");
    // Still where you were.
    expect(window.location.hash).toBe("#/");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "What the GPU is doing" })).toBeNull();
  });

  it("names the GPU an attached engine runs next to, not its proxy", async () => {
    window.location.hash = "#/";
    render(
      <EngineProvider client={engine(ATTACHED, { ...SETTINGS, remote: null })}>
        <App />
      </EngineProvider>,
    );
    await screen.findByRole("heading", { name: "Projects" });
    expect((await screen.findAllByRole("button", { name: /NVIDIA GB10/ })).length).toBeGreaterThan(0);
    expect(screen.queryByText(/GPU proxy/)).toBeNull();
  });
});
