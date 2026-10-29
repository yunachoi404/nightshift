import { resolve, join } from 'node:path';

export interface LaunchOptions {
  mode: 'local' | 'mock' | 'attach';
  comfyBaseUrl?: string;
  dataDir: string;
  /**
   * The app may switch between the demo and a real setup from the UI: it was opened without --mock,
   * --comfy-base-url or their environment variables. --data-dir alone still allows it.
   */
  canSwitchDemo: boolean;
}

export function launchOptions(args: string[], env: NodeJS.ProcessEnv, defaultDataDir: string): LaunchOptions {
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name);
    const inline = args.find(arg => arg.startsWith(`${name}=`));
    const value = index >= 0 ? args[index + 1] : inline?.slice(name.length + 1);
    if (index >= 0 && (!value || value.startsWith('--'))) throw new Error(`${name} needs a value`);
    return value;
  };
  const mock = args.includes('--mock') || env.NIGHTSHIFT_MOCK === '1';
  const base = option('--comfy-base-url') ?? env.NIGHTSHIFT_COMFY_BASE_URL;
  if (mock && base) throw new Error('Choose mock or attach mode, one at a time');
  let comfyBaseUrl: string | undefined;
  if (base) {
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Comfy proxy must be an HTTP URL without credentials');
    comfyBaseUrl = url.href.replace(/\/+$/, '');
  }
  return { mode: mock ? 'mock' : comfyBaseUrl ? 'attach' : 'local', dataDir: resolve(option('--data-dir') ?? env.NIGHTSHIFT_DATA_DIR ?? defaultDataDir), canSwitchDemo: !mock && !comfyBaseUrl, ...(comfyBaseUrl ? { comfyBaseUrl } : {}) };
}

/** Where the user's choice of the demo is kept: in the real data folder, so the demo's own folder can be thrown away. */
export const DEMO_CHOICE_FILE = 'desktop-demo.json';

/** The demo's own data folder, beside the real one: "Nightshift" gets "Nightshift Demo". Nothing in it mixes with a real setup. */
export function demoDataDir(realDataDir: string): string {
  return `${realDataDir.replace(/[/\\]+$/, '')} Demo`;
}

/** The choice file's content, read leniently: anything but an explicit yes is the real setup. */
export function demoChosen(raw: string | undefined): boolean {
  if (!raw) return false;
  try { return (JSON.parse(raw) as { demo?: unknown }).demo === true; } catch { return false; }
}

/**
 * The mode the app opens in. Switches on the command line or in the environment win. Without them, the demo the user
 * chose ("Look around first") runs the engine in mock mode on its own data folder.
 */
export function withDemoChoice(options: LaunchOptions, chosen: boolean): LaunchOptions {
  if (!options.canSwitchDemo || !chosen) return options;
  return { mode: 'mock', dataDir: demoDataDir(options.dataDir), canSwitchDemo: true };
}

export function resourcePaths(runtime: string) {
  return {
    entry: join(runtime, 'packages/engine/dist/engine.mjs'),
    webDir: join(runtime, 'web'),
    recipesDir: join(runtime, 'recipes'),
    workflowsDir: join(runtime, 'workflows'),
    nodesDir: join(runtime, 'comfy_nodes'),
  };
}

/**
 * Chromium features the shell turns off. Playing a take or a preview must not make Nightshift the Mac's Now
 * Playing source: Chromium's media session and hardware media key handling register the app with MediaRemote,
 * whose UI service then taps the process's audio and crashes ("MediaRemoteUI quit unexpectedly"). Previews in a
 * video app should not take over the media keys either.
 */
export const DISABLED_CHROMIUM_FEATURES = ['HardwareMediaKeyHandling', 'MediaSessionService'];

/** The --disable-features value to set: what was already disabled (Electron's own list, or a user's), plus ours, each once. */
export function mergeDisabledFeatures(existing: string | undefined, add: readonly string[] = DISABLED_CHROMIUM_FEATURES): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of [...(existing ?? '').split(','), ...add]) {
    const feature = name.trim();
    if (!feature || seen.has(feature)) continue;
    seen.add(feature);
    out.push(feature);
  }
  return out.join(',');
}
