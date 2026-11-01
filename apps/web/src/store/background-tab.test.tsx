/**
 * A browser keeps six connections open to one address, and each tab's live stream holds one. A tab left in the
 * background lets go of its stream, so another tab still loads; back in front it listens again and catches up.
 */
import type { Event, Project } from "@nightshift/contract";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NightshiftClient } from "@/api/client";
import { BACKGROUND_RELEASE_MS, EngineProvider } from "./engine";

vi.mock("@/api/config", () => ({
  API_KEY: "nightshift.api",
  buildApiBase: () => "",
  isMock: () => false,
  isDevMock: () => false,
  isBrowserDemo: () => false,
  getClient: () => {
    throw new Error("the test gives the provider its own client");
  },
}));

const iso = () => new Date().toISOString();
const PROJECT: Project = { id: "prj_one", name: "Lighthouse", template: "blank", aspect: "16:9", brief: {}, shots: [], takes: [], assets: [], timeline: null, createdAt: iso(), updatedAt: iso() };

/** A client that counts its open streams and how often the app read its projects. */
function engine() {
  const seen = { open: 0, opened: 0, reads: 0 };
  const client: Partial<NightshiftClient> = {
    kind: "http",
    status: async () => ({ phase: "ready", tier: "nvidia-8", comfyui: { running: true, url: "http://127.0.0.1:8188", version: "0.41.3" }, memoryUsedGb: null, mode: "local" }),
    settings: async () => ({ tier: "nvidia-8", memoryLimitGb: null, overnight: { enabled: false, startAt: "23:00", endAt: "07:00" }, remote: null }),
    onboarding: async () => ({ done: true, sampleProjectId: null }),
    tiers: async () => [],
    listProjects: async () => (seen.reads++, [PROJECT]),
    listJobs: async () => [],
    events: (_onEvent: (e: Event) => void, onConnection) => {
      seen.open++;
      seen.opened++;
      queueMicrotask(() => onConnection?.(true));
      return () => void seen.open--;
    },
  };
  return { client: client as NightshiftClient, seen };
}

let hidden = false;
Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
const show = (visible: boolean) => {
  hidden = !visible;
  document.dispatchEvent(new window.Event("visibilitychange"));
};

afterEach(() => {
  hidden = false;
  vi.useRealTimers();
});

describe("a tab in the background", () => {
  it("lets go of its live stream after a while, and listens again and catches up when it comes back", async () => {
    vi.useFakeTimers();
    const { client, seen } = engine();
    render(
      <EngineProvider client={client}>
        <div />
      </EngineProvider>,
    );
    await act(async () => void (await vi.runOnlyPendingTimersAsync()));
    expect(seen.open).toBe(1);

    // A quick look at another tab keeps the stream.
    act(() => show(false));
    await act(async () => void (await vi.advanceTimersByTimeAsync(BACKGROUND_RELEASE_MS / 2)));
    act(() => show(true));
    await act(async () => void (await vi.advanceTimersByTimeAsync(BACKGROUND_RELEASE_MS)));
    expect([seen.open, seen.opened]).toEqual([1, 1]);

    // Left in the background, it closes.
    act(() => show(false));
    await act(async () => void (await vi.advanceTimersByTimeAsync(BACKGROUND_RELEASE_MS)));
    expect(seen.open).toBe(0);

    // Back in front: one stream again, and the projects read again to catch up.
    const reads = seen.reads;
    act(() => show(true));
    await act(async () => void (await vi.runOnlyPendingTimersAsync()));
    expect([seen.open, seen.opened]).toEqual([1, 2]);
    expect(seen.reads).toBeGreaterThan(reads);
  });
});
