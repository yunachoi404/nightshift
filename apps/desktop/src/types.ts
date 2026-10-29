export interface EngineOptions {
  port: number;
  dataDir: string;
  webDir?: string;
  recipesDir?: string;
  workflowsDir?: string;
  nodesDir?: string;
  log?: (message: string) => void;
  comfyBaseUrl?: string;
  mock?: boolean;
}
export interface EngineHandle { url: string; stop(): Promise<void> }
export interface DesktopStatus {
  engineUrl: string;
  engineState: 'starting' | 'ready' | 'error';
  eventsConnected: boolean;
  keepingAwake: boolean;
  activeOvernightJobs: number;
  notificationsSupported: boolean;
  mode: 'local' | 'mock' | 'attach';
  /** The UI may offer "Look around first" or "Set up for real": no mode switch was given at launch. */
  canSwitchDemo: boolean;
}
export interface DesktopBridge {
  platform: string;
  /** Height of the title strip the UI draws its toolbar into. */
  titlebarHeight: number;
  /** True when the window paints a translucent material behind the page; the UI leaves its sidebar see-through. */
  vibrancy: boolean;
  getStatus(): Promise<DesktopStatus>;
  /** The user's theme choice. The shell switches the native window and controls to match. */
  setTheme(mode: 'system' | 'light' | 'dark'): Promise<void>;
  revealProject(projectId: string): Promise<void>;
  revealExport(projectId: string, assetId: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** Relaunch in the demo (true) or the real setup (false). Rejected when the app was opened with a mode switch. */
  setDemo(on: boolean): Promise<void>;
}
