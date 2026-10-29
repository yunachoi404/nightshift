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
}
