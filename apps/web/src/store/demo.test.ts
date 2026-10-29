/**
 * "Look around first" and back: who may switch, and what switching does. The Mac app asks its shell to relaunch in the
 * other mode; a browser on a real engine moves to the in-browser demo and back; the static demo has no real setup.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ built: "", stored: null as string | null, mock: false }));
vi.mock("@/api/config", () => ({
  API_KEY: "nightshift.api",
  buildApiBase: () => api.built,
  isMock: () => api.mock,
  isBrowserDemo: () => api.mock && (api.stored ?? api.built) === "demo",
}));

import { initializeDesktop } from "@/lib/desktop";
import { demoSwitch, enterDemo, leaveDemo } from "./demo";

function desktop(mode: "local" | "mock" | "attach", canSwitchDemo: boolean) {
  const setDemo = vi.fn(async () => undefined);
  window.nightshiftDesktop = {
    platform: "darwin",
    titlebarHeight: 52,
    getStatus: async () => ({ engineUrl: "http://127.0.0.1:9000", mode, canSwitchDemo }),
    revealProject: async () => undefined,
    revealExport: async () => undefined,
    openExternal: async () => undefined,
    setDemo,
  };
  return setDemo;
}

beforeEach(() => Object.assign(api, { built: "", stored: null, mock: false }));
afterEach(() => {
  delete window.nightshiftDesktop;
  vi.restoreAllMocks();
});

describe("in the Mac app", () => {
  it("a real setup offers the demo, and the demo the user chose offers the way back", async () => {
    const setDemo = desktop("local", true);
    await initializeDesktop();
    expect(demoSwitch("local")).toEqual({ canEnter: true, canLeave: false, staticDemo: false });
    await enterDemo();
    expect(setDemo).toHaveBeenCalledWith(true);

    desktop("mock", true);
    await initializeDesktop();
    expect(demoSwitch("mock")).toEqual({ canEnter: false, canLeave: true, staticDemo: false });
    await leaveDemo();
    expect(window.nightshiftDesktop!.setDemo).toHaveBeenCalledWith(false);
  });

  it("an app opened with --mock or another mode switch offers neither", async () => {
    desktop("mock", false);
    await initializeDesktop();
    expect(demoSwitch("mock")).toEqual({ canEnter: false, canLeave: false, staticDemo: false });
    desktop("attach", false);
    await initializeDesktop();
    expect(demoSwitch("attach")).toEqual({ canEnter: false, canLeave: false, staticDemo: false });
  });
});

describe("in a browser", () => {
  it("on a real engine, offers the demo; on an engine started with --mock, it already is one", () => {
    expect(demoSwitch("local").canEnter).toBe(true);
    expect(demoSwitch("remote").canEnter).toBe(true);
    expect(demoSwitch("mock").canEnter).toBe(false);
    // Not known yet: nothing is offered until the engine has answered.
    expect(demoSwitch(undefined).canEnter).toBe(false);
  });

  it("the demo it chose goes back to its engine; the static demo has none to go back to", () => {
    Object.assign(api, { mock: true, stored: "demo", built: "" });
    expect(demoSwitch(undefined)).toEqual({ canEnter: false, canLeave: true, staticDemo: false });
    Object.assign(api, { mock: true, stored: null, built: "demo" });
    expect(demoSwitch(undefined)).toEqual({ canEnter: false, canLeave: false, staticDemo: true });
  });

  it("switching keeps the choice in this browser and reloads, leaving the engine's data alone", async () => {
    // jsdom does not navigate; the reload is only asked for.
    await enterDemo().catch(() => undefined);
    expect(localStorage.getItem("nightshift.api")).toBe("demo");
    await leaveDemo().catch(() => undefined);
    expect(localStorage.getItem("nightshift.api")).toBeNull();
  });
});
