/** The sandboxed Electron preload. Browser mode has no bridge. */
export interface DesktopBridge {
  platform: string;
  titlebarHeight: number;
  /** True when the window paints a translucent material behind the sidebar. */
  vibrancy?: boolean;
  getStatus(): Promise<{ engineUrl: string; mode?: "local" | "mock" | "attach"; canSwitchDemo?: boolean }>;
  revealProject(projectId: string): Promise<void>;
  revealExport(projectId: string, assetId: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** Tell the shell which theme the user chose so the native window follows. */
  setTheme?(mode: "system" | "light" | "dark"): Promise<void>;
  /**
   * Relaunch into the demo (sample renders, its own data folder) or back to the real setup. Only when the app was
   * opened without mode switches (`canSwitchDemo`). The window closes and the app opens again in the other mode.
   */
  setDemo?(on: boolean): Promise<void>;
}

declare global {
  interface Window {
    nightshiftDesktop?: DesktopBridge;
  }
}

let engineUrl: string | null = null;
let runtimeMode: "local" | "mock" | "attach" | null = null;
let canSwitchDemo = false;

export function desktopRuntimeMode(): typeof runtimeMode {
  return runtimeMode;
}

/** The app may switch between the demo and the real setup: it was opened without --mock or another mode switch. */
export function desktopCanSwitchDemo(): boolean {
  return canSwitchDemo && !!window.nightshiftDesktop?.setDemo;
}

export function desktopEngineUrl(): string | null {
  return engineUrl;
}

export function isDesktop(): boolean {
  return !!window.nightshiftDesktop;
}

export async function initializeDesktop(): Promise<void> {
  const bridge = window.nightshiftDesktop;
  engineUrl = null;
  runtimeMode = null;
  canSwitchDemo = false;
  if (!bridge) return;
  const root = document.documentElement;
  root.dataset.desktopPlatform = bridge.platform;
  if (bridge.vibrancy) root.dataset.desktopVibrancy = "";
  // Production is same-origin. Vite in Electron uses the engine origin supplied by the shell.
  engineUrl = window.location.origin;
  try {
    const status = await bridge.getStatus();
    if (status.engineUrl) engineUrl = status.engineUrl;
    runtimeMode = status.mode ?? null;
    canSwitchDemo = status.canSwitchDemo === true;
  } catch {
    // The normal engine-unreachable screen handles a shell that is still starting.
  }
}
