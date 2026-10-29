import { API_KEY, buildApiBase, isBrowserDemo, isMock } from "@/api/config";
import { desktopCanSwitchDemo, desktopRuntimeMode } from "@/lib/desktop";
import { useEngineState } from "./engine";

/** Renders are simulated: the engine runs in mock mode, or the UI talks to its in-browser mock. */
export function useDemoMode(): boolean {
  return useEngineState().status?.mode === "mock" || isMock();
}

/**
 * "Look around first": the demo, with sample renders and its own data, never mixed with a real setup.
 *   - The Mac app relaunches its engine in mock mode on a separate data folder ("Nightshift Demo").
 *   - A browser on a real engine switches to the in-browser demo, kept in this browser's storage. The engine and its
 *     data are untouched.
 *   - The static browser demo (GitHub Pages) has no real setup to go back to.
 */
export interface DemoSwitch {
  /** This is a real setup, and the demo is one click away. */
  canEnter: boolean;
  /** This is the demo the user chose, and the real setup is one click away. */
  canLeave: boolean;
  /** No engine is behind this page: the static demo. */
  staticDemo: boolean;
}

export function useDemoSwitch(): DemoSwitch {
  const mode = useEngineState().status?.mode;
  return demoSwitch(mode);
}

export function demoSwitch(mode: string | undefined): DemoSwitch {
  const built = buildApiBase();
  const staticDemo = built === "demo";
  if (window.nightshiftDesktop) {
    const can = desktopCanSwitchDemo();
    const demo = desktopRuntimeMode() === "mock";
    return { canEnter: can && !demo, canLeave: can && demo, staticDemo: false };
  }
  // Leaving goes back to the engine this page came from. The static demo and the dev server's mock have none.
  if (isBrowserDemo()) return { canEnter: false, canLeave: built !== "demo" && built !== "mock", staticDemo };
  // A browser on a real engine. An engine started with --mock is a demo already.
  return { canEnter: !isMock() && mode !== undefined && mode !== "mock", canLeave: false, staticDemo: false };
}

export async function enterDemo(): Promise<void> {
  const desktop = window.nightshiftDesktop;
  if (desktop?.setDemo) return desktop.setDemo(true);
  localStorage.setItem(API_KEY, "demo");
  window.location.replace(window.location.pathname);
}

export async function leaveDemo(): Promise<void> {
  const desktop = window.nightshiftDesktop;
  if (desktop?.setDemo) return desktop.setDemo(false);
  localStorage.removeItem(API_KEY);
  window.location.replace(window.location.pathname);
}

/** What "Open file" says on an in-browser engine, where nothing is written to disk. */
export function noFileToast(): { title: string; text: string; tone: "accent" } {
  return isBrowserDemo()
    ? { title: "This is the browser demo", text: "Nothing was rendered or saved. The app writes real MP4s to your Nightshift folder.", tone: "accent" }
    : { title: "This is the mock engine", text: "Nothing was written to disk. The real engine saves to your Nightshift folder.", tone: "accent" };
}
