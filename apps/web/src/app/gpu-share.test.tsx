/**
 * The warning when another app holds part of the graphics card during a render (RuntimeStatus.otherGpuUse): it shows
 * while the engine says so, goes when the engine stops saying it, and a dismissed one stays away for the same apps.
 */
import type { Event, OtherGpuUse, RuntimeStatus, Settings } from "@nightshift/contract";
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

const READY: RuntimeStatus = { phase: "ready", tier: "nvidia-8", comfyui: { running: true, url: "http://127.0.0.1:8188", version: "0.41.3" }, memoryUsedGb: 5.1, mode: "local" };
const SETTINGS: Settings = { tier: "nvidia-8", memoryLimitGb: null, overnight: { enabled: false, startAt: "23:00", endAt: "07:00" }, remote: null };

/** A set-up engine on an 8 GB card that sends whatever runtime status the test gives it. */
function engine() {
  let status = READY;
  const windows = new Set<(e: Event) => void>();
  const known: Partial<NightshiftClient> = {
    kind: "http",
    status: async () => status,
    settings: async () => SETTINGS,
    onboarding: async () => ({ done: true, sampleProjectId: null }),
    tiers: async () => [],
    listProjects: async () => [],
    listJobs: async () => [],
    assetUrl: (pid, aid) => `/api/projects/${pid}/assets/${aid}`,
    events: (onEvent, onConnection) => {
      windows.add(onEvent);
      queueMicrotask(() => onConnection?.(true));
      return () => void windows.delete(onEvent);
    },
  };
  const client = new Proxy(known as NightshiftClient, {
    get: (target, key) => (typeof key !== "string" || key in target || key === "then" ? Reflect.get(target, key) : () => new Promise(() => undefined)),
  });
  const send = (otherGpuUse?: OtherGpuUse) =>
    act(() => {
      status = otherGpuUse ? { ...READY, otherGpuUse } : READY;
      for (const w of windows) w({ type: "runtime", status });
    });
  return { client, send };
}

/** The warning's words, or null when it is not there. */
const warning = () => screen.queryByRole("status")?.textContent ?? null;

describe("another app on the graphics card", () => {
  it("shows while the engine says so and goes when the other app lets go", async () => {
    const { client, send } = engine();
    window.location.hash = "#/";
    render(
      <EngineProvider client={client}>
        <App />
      </EngineProvider>,
    );
    await screen.findByRole("heading", { name: "Projects" });
    expect(warning()).toBeNull();

    send({ usedGb: 3.5, apps: ["python"] });
    expect(warning()).toBe("Another app is using 3.5 GB of your graphics card (python). Renders may be slower until it stops.");

    send();
    expect(warning()).toBeNull();

    send({ usedGb: 4, apps: ["python", "blender"] });
    expect(warning()).toBe("Other apps are using 4 GB of your graphics card (python, blender). Renders may be slower until they stop.");

    send({ usedGb: 1.2, apps: [] });
    expect(warning()).toBe("Another app is using 1.2 GB of your graphics card. Renders may be slower until it stops.");
  });

  it("a dismissed warning stays away for the same apps and comes back for others", async () => {
    const { client, send } = engine();
    window.location.hash = "#/";
    render(
      <EngineProvider client={client}>
        <App />
      </EngineProvider>,
    );
    await screen.findByRole("heading", { name: "Projects" });

    send({ usedGb: 3.5, apps: ["python"] });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(warning()).toBeNull();

    // The same app, holding a little more: still dismissed.
    send({ usedGb: 4.1, apps: ["python"] });
    expect(warning()).toBeNull();

    send({ usedGb: 5, apps: ["blender", "python"] });
    expect(warning()).toContain("(blender, python)");
  });
});
