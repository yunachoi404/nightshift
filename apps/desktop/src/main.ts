import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, powerSaveBlocker, session, shell, utilityProcess } from 'electron';
import type { IpcMainInvokeEvent, MenuItemConstructorOptions, UtilityProcess } from 'electron';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectSchema, RuntimeStatusSchema } from '@nightshift/contract';
import type { Job } from '@nightshift/contract';
import { JobTracker } from './jobs.js';
import { watchJobs } from './events.js';
import { containedPath, externalUrl, safeId } from './paths.js';
import type { DesktopStatus } from './types.js';
import { launchOptions, mergeDisabledFeatures, resourcePaths } from './runtime.js';

app.setName('Nightshift');
// Before ready: never register as the Mac's Now Playing source or take the media keys (see runtime.ts).
app.commandLine.appendSwitch('disable-features', mergeDisabledFeatures(app.commandLine.getSwitchValue('disable-features')));
// Keep browser storage beside the engine data, including isolated demo runs.
app.setPath('userData', launchOptions(process.argv, process.env, app.getPath('userData')).dataDir);
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
let window: BrowserWindow | undefined;
let worker: UtilityProcess | undefined;
let eventAbort: AbortController | undefined;
let blocker: number | undefined;
let quitting = false;
let allowQuit = false;
let quitPrompt = false;
let starting: Promise<void> | undefined;
let uiUrl = '';
let dataDir = '';
let activeJobs = 0;
let lastNotification = 'none';
type ThemeMode = 'system' | 'light' | 'dark';
const themeModes: ThemeMode[] = ['system', 'light', 'dark'];
let themeMode: ThemeMode = 'system';
let statusWrites: Promise<void> = Promise.resolve();
const notices = new Set<Notification>();
const state: DesktopStatus = { engineUrl: '', engineState: 'starting', eventsConnected: false, keepingAwake: false, activeOvernightJobs: 0, notificationsSupported: false, mode: 'local' };

function persistStatus(): void {
  if (!dataDir) return;
  // Opt-in diagnostic snapshot for local package verification. No job contents or environment.
  if (!process.argv.includes('--desktop-diagnostics')) return;
  const snapshot = JSON.stringify({ ...state, pid: process.pid, enginePid: worker?.pid, lastNotification }, null, 2);
  statusWrites = statusWrites.then(async () => {
    const path = join(dataDir, 'desktop-status.json');
    await writeFile(`${path}.tmp`, snapshot);
    await rename(`${path}.tmp`, path);
  }).catch(() => {});
}
function awake(count: number): void {
  activeJobs = count;
  if (count > 0 && blocker === undefined) blocker = powerSaveBlocker.start('prevent-app-suspension');
  if (count === 0 && blocker !== undefined) { powerSaveBlocker.stop(blocker); blocker = undefined; }
  state.keepingAwake = blocker !== undefined && powerSaveBlocker.isStarted(blocker);
  state.activeOvernightJobs = count;
  persistStatus();
}
function showWindow(): void {
  if (!window || window.isDestroyed()) createWindow();
  if (window?.isMinimized()) window.restore();
  window?.show();
  app.focus({ steal: true });
  window?.focus();
}
function openStudioRoute(route: '/new' | '/settings'): void {
  showWindow();
  const view = window;
  if (!view) return;
  const navigate = () => {
    if (view.isDestroyed()) return;
    const target = new URL(view.webContents.getURL() || uiUrl);
    target.hash = route;
    void view.loadURL(target.href);
  };
  if (view.webContents.isLoadingMainFrame()) view.webContents.once('did-finish-load', navigate);
  else navigate();
}
function notify(job: Job): void {
  if (!Notification.isSupported()) { lastNotification = 'unsupported'; persistStatus(); return; }
  const notice = new Notification({
    title: job.status === 'done' ? 'Your overnight final is ready' : 'An overnight final needs attention',
    body: job.status === 'done' ? 'Open Nightshift to review your finished take.' : 'Open Nightshift to review the job and try again.',
    silent: false,
  });
  notices.add(notice);
  notice.on('click', showWindow);
  notice.on('show', () => { lastNotification = `${job.status}:shown`; persistStatus(); });
  notice.on('failed', () => { lastNotification = `${job.status}:failed`; persistStatus(); notices.delete(notice); });
  notice.on('close', () => notices.delete(notice));
  lastNotification = `${job.status}:requested`;
  notice.show();
  persistStatus();
}
const tracker = new JobTracker(notify, awake);

function trusted(event: IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame || !uiUrl || new URL(event.senderFrame.url).origin !== new URL(uiUrl).origin) throw new Error('Untrusted caller');
}
async function project(id: unknown) {
  const key = safeId(id);
  const response = await fetch(`${state.engineUrl}/api/projects/${key}`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Project is unavailable');
  const value = ProjectSchema.parse(await response.json());
  if (value.id !== key) throw new Error('Project does not match');
  return value;
}
/** The UI's theme choice drives the native window material, controls and menus. Remembered for the next launch. */
async function applyTheme(mode: unknown): Promise<void> {
  if (!themeModes.includes(mode as ThemeMode)) throw new Error('Unknown theme');
  themeMode = mode as ThemeMode;
  nativeTheme.themeSource = themeMode;
  if (dataDir) await writeFile(join(dataDir, 'desktop-theme.json'), JSON.stringify({ theme: themeMode })).catch(() => {});
}
async function restoreTheme(): Promise<void> {
  const saved = await readFile(join(dataDir, 'desktop-theme.json'), 'utf8').then(value => JSON.parse(value) as { theme?: string }).catch(() => ({} as { theme?: string }));
  if (themeModes.includes(saved.theme as ThemeMode)) { themeMode = saved.theme as ThemeMode; nativeTheme.themeSource = themeMode; }
}
function installIpc(): void {
  ipcMain.handle('desktop:status', event => { trusted(event); return { ...state }; });
  ipcMain.handle('desktop:theme', async (event, mode: unknown) => { trusted(event); await applyTheme(mode); });
  ipcMain.handle('desktop:external', async (event, value: unknown) => { trusted(event); await shell.openExternal(externalUrl(value)); });
  ipcMain.handle('desktop:reveal-project', async (event, id: unknown) => { trusted(event); await revealProject(id); });
  ipcMain.handle('desktop:reveal-export', async (event, id: unknown, assetId: unknown) => { trusted(event); await revealExport(id, assetId); });
}
async function revealProject(id: unknown): Promise<void> {
  const value = await project(id);
  const root = await containedPath(dataDir, join('projects', safeId(value.id)));
  if (await shell.openPath(root)) throw new Error('Finder could not open the project');
}
async function revealExport(id: unknown, assetId: unknown): Promise<void> {
  const value = await project(id);
  const asset = value.assets.find(item => item.id === safeId(assetId) && item.role === 'export');
  if (!asset) throw new Error('Export is unavailable');
  const root = await containedPath(dataDir, join('projects', safeId(value.id)));
  shell.showItemInFolder(await containedPath(root, asset.path));
}
function currentProjectId(): string {
  const path = new URL(window?.webContents.getURL() || uiUrl).hash;
  const id = /^#\/p\/([^/]+)/.exec(path)?.[1];
  if (!id) throw new Error('Open a project first');
  return safeId(decodeURIComponent(id));
}
async function finderAction(action: () => Promise<void>): Promise<void> {
  try { await action(); }
  catch (error) { await dialog.showMessageBox({ type: 'info', message: error instanceof Error ? error.message : 'Finder could not open this item' }); }
}
function openLink(url: string): void {
  const target = new URL(url);
  const asset = /^\/api\/projects\/([^/]+)\/assets\/([^/]+)$/.exec(target.pathname);
  if (target.origin === new URL(state.engineUrl).origin && asset) {
    void finderAction(() => revealExport(decodeURIComponent(asset[1]!), decodeURIComponent(asset[2]!)));
    return;
  }
  try { void shell.openExternal(externalUrl(url)).catch(() => {}); } catch { /* Ignore non-web URLs. */ }
}
function createWindow(): void {
  if (!uiUrl || quitting) return;
  const view = new BrowserWindow({
    width: 1280, height: 820, minWidth: 920, minHeight: 620, show: false,
    title: 'Nightshift',
    // The UI draws its own toolbar in the title area and keeps the traffic lights in the sidebar's top strip.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 20 },
    // The sidebar is see-through: the window paints the macOS sidebar material behind the page.
    ...(process.platform === 'darwin' ? { vibrancy: 'sidebar' as const, visualEffectState: 'followWindow' as const, backgroundColor: '#00000000' } : { backgroundColor: nativeTheme.shouldUseDarkColors ? '#000000' : '#fcfcfc' }),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
  });
  window = view;
  view.once('ready-to-show', () => { view.show(); app.focus({ steal: true }); view.focus(); });
  view.on('closed', () => { if (window === view) window = undefined; });
  view.webContents.setWindowOpenHandler(({ url }) => {
    openLink(url);
    return { action: 'deny' };
  });
  view.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== new URL(uiUrl).origin) {
      event.preventDefault();
      openLink(url);
    }
  });
  view.webContents.on('will-attach-webview', event => event.preventDefault());
  view.webContents.on('render-process-gone', () => {
    if (!quitting) void dialog.showMessageBox({ type: 'error', message: 'The studio window stopped responding.', detail: 'The engine is still running. Reopen the window to continue.', buttons: ['Reopen window'] }).then(() => {
      view.destroy(); showWindow();
    });
  });
  void view.loadURL(uiUrl).catch(() => {
    if (!quitting) void dialog.showMessageBox({ type: 'error', message: 'The studio page could not load.', detail: 'Check the engine or Vite server, then choose Reload in the View menu.' });
  });
}
async function statusDialog(): Promise<void> {
  // The engine may send its work to a GPU computer on the network (Settings.remote) though it was started for this Mac.
  const runtime = await fetch(`${state.engineUrl}/api/status`, { signal: AbortSignal.timeout(2000) }).then(async res => RuntimeStatusSchema.parse(await res.json())).catch(() => undefined);
  await dialog.showMessageBox({ type: 'info', message: 'Nightshift desktop status', detail: [
    runtime?.mode === 'remote' ? `Real engine, on a GPU computer on the network${runtime.comfyui.url ? ` (${runtime.comfyui.url})` : ''}.` : `Real engine (${state.mode} mode).`,
    `Engine: ${state.engineState}`,
    `Queue events: ${state.eventsConnected ? 'connected' : 'reconnecting'}`,
    `Overnight jobs: ${activeJobs}`,
    `Keep awake: ${state.keepingAwake ? 'on (display may sleep)' : 'off'}`,
    `Notifications: ${state.notificationsSupported ? 'supported' : 'unavailable'}`,
    `Last notification: ${lastNotification}`,
    `App data: ${dataDir}`,
  ].join('\n') });
}
function installMenu(): void {
  const items: MenuItemConstructorOptions[] = [
    { label: 'Nightshift', submenu: [
      { role: 'about' }, { type: 'separator' },
      { label: 'Settings...', accelerator: 'CmdOrCtrl+,', click: () => openStudioRoute('/settings') },
      { type: 'separator' },
      { label: 'Desktop status...', click: () => void statusDialog() },
      { label: 'Open app data in Finder', click: () => void shell.openPath(dataDir) },
      { type: 'separator' }, { role: 'services' }, { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'File', submenu: [
      { label: 'New project', accelerator: 'CmdOrCtrl+N', click: () => openStudioRoute('/new') },
      { label: 'Open studio', accelerator: 'CmdOrCtrl+0', click: showWindow },
      { label: 'Show project in Finder', click: () => void finderAction(() => revealProject(currentProjectId())) },
      { label: 'Show latest export in Finder', click: () => void finderAction(async () => {
        const value = await project(currentProjectId());
        const asset = [...value.assets].reverse().find(item => item.role === 'export');
        if (!asset) throw new Error('Export a video first');
        await revealExport(value.id, asset.id);
      }) },
      { type: 'separator' }, { role: 'close' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]), { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [{ label: 'Desktop status...', click: () => void statusDialog() }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(items));
}
async function start(): Promise<void> {
  state.engineState = 'starting';
  persistStatus();
  const launch = launchOptions(process.argv, process.env, app.getPath('userData'));
  state.mode = launch.mode;
  const runtime = app.isPackaged ? join(process.resourcesPath, 'runtime') : join(__dirname, 'runtime');
  const resources = resourcePaths(runtime);
  const manifest = JSON.parse(await readFile(join(runtime, 'resources.json'), 'utf8')) as { chrome: string };
  const saved = await readFile(join(dataDir, 'desktop-port.json'), 'utf8').then(value => JSON.parse(value) as { port?: number }).catch(() => ({} as { port?: number }));
  const preferredPort = Number.isInteger(saved.port) && saved.port! > 0 && saved.port! < 65536 ? saved.port : undefined;
  const child = utilityProcess.fork(join(__dirname, 'engine-worker.cjs'), [JSON.stringify({
    ...resources, dataDir, preferredPort, mock: launch.mode === 'mock',
    ...(launch.comfyBaseUrl ? { comfyBaseUrl: launch.comfyBaseUrl } : {}),
  })], { serviceName: 'Nightshift engine', stdio: 'ignore', cwd: dataDir, env: {
    ...process.env,
    NIGHTSHIFT_UV: process.env.NIGHTSHIFT_UV ?? join(runtime, 'bin/uv'),
    NIGHTSHIFT_FFMPEG: process.env.NIGHTSHIFT_FFMPEG ?? join(runtime, 'bin/ffmpeg'),
    NIGHTSHIFT_FFPROBE: process.env.NIGHTSHIFT_FFPROBE ?? join(runtime, 'bin/ffprobe'),
    PRODUCER_HEADLESS_SHELL_PATH: process.env.PRODUCER_HEADLESS_SHELL_PATH ?? join(runtime, 'render-browser', manifest.chrome),
  } });
  worker = child;
  let ready = false;
  child.once('exit', () => {
    if (worker !== child) return;
    worker = undefined;
    eventAbort?.abort();
    state.engineState = 'error';
    state.eventsConnected = false;
    tracker.clear();
    if (ready && !quitting) void engineFailure();
    persistStatus();
  });
  state.engineUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Engine start timed out')); }, 60_000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Engine exited')); });
    child.on('message', (message: { type?: string; url?: string }) => {
      if (message.type === 'ready' && message.url) { clearTimeout(timer); ready = true; resolve(message.url); }
      else if (message.type === 'failed') { clearTimeout(timer); reject(new Error('Engine could not start')); }
    });
  });
  // A stable origin preserves the UI's first-run marker and preferences across app launches.
  await writeFile(join(dataDir, 'desktop-port.json'), JSON.stringify({ port: Number(new URL(state.engineUrl).port) }));
  state.engineState = 'ready';
  const devUrl = !app.isPackaged ? process.env.NIGHTSHIFT_UI_URL : undefined;
  if (devUrl) {
    const url = new URL(devUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Vite must run on loopback');
  }
  // Explicitly select this engine even when a Vite page defaults to its in-browser mock.
  const page = new URL(devUrl || state.engineUrl);
  page.searchParams.set('api', state.engineUrl);
  uiUrl = page.href;
  eventAbort = new AbortController();
  void watchJobs(state.engineUrl, tracker, eventAbort.signal, connected => { state.eventsConnected = connected; persistStatus(); });
  if (window && !window.isDestroyed()) await window.loadURL(uiUrl);
  else createWindow();
  persistStatus();
}
async function startOnce(): Promise<void> {
  if (starting) return starting;
  starting = start().catch(async () => {
    eventAbort?.abort();
    const child = worker;
    worker = undefined;
    if (child?.pid) child.kill();
    tracker.clear();
    state.engineState = 'error';
    state.eventsConnected = false;
    persistStatus();
    void engineFailure();
  }).finally(() => { starting = undefined; });
  return starting;
}
async function engineFailure(): Promise<void> {
  const answer = await dialog.showMessageBox({ type: 'error', message: 'The local engine stopped.', detail: 'Rendering has stopped. Restart the engine to reconnect. Saved projects stay in app data. The engine must recover unfinished jobs from disk.', buttons: ['Restart engine', 'Quit Nightshift'], defaultId: 0, cancelId: 1 });
  if (answer.response === 0) { if (starting) await starting; await startOnce(); }
  else { allowQuit = true; app.quit(); }
}
app.on('second-instance', showWindow);
app.on('activate', () => { if (state.engineState === 'ready') showWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin' && activeJobs === 0) app.quit(); });
app.on('before-quit', event => {
  if (allowQuit) return;
  event.preventDefault();
  if (quitPrompt || quitting) return;
  quitPrompt = true;
  void (async () => {
    if (activeJobs > 0) {
      const result = await dialog.showMessageBox({ type: 'warning', message: 'Stop the overnight queue and quit?', detail: 'Keep Nightshift open while jobs run. You can close the window and rendering will continue. The engine must recover unfinished jobs when the app reopens.', buttons: ['Keep rendering', 'Stop and quit'], defaultId: 0, cancelId: 0 });
      if (result.response === 0) { quitPrompt = false; return; }
    }
    quitting = true;
    eventAbort?.abort();
    tracker.clear();
    if (worker?.pid) {
      const child = worker;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { child.kill(); resolve(); }, 10_000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.postMessage({ type: 'stop' });
      });
    }
    allowQuit = true;
    app.quit();
  })();
});
if (locked) void app.whenReady().then(async () => {
  dataDir = launchOptions(process.argv, process.env, app.getPath('userData')).dataDir;
  await mkdir(dataDir, { recursive: true });
  await restoreTheme();
  state.notificationsSupported = Notification.isSupported();
  app.setAboutPanelOptions({ applicationName: 'Nightshift', applicationVersion: app.getVersion(), copyright: 'Local creation. Overnight finishing.' });
  installIpc();
  installMenu();
  // No camera, microphone, geolocation, or arbitrary renderer permissions in the shell.
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  await startOnce();
});
