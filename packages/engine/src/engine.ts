import type { Comfy } from "@comfyorg/sdk";
import type { ToolOverrides } from "@nightshift/editor";
import { loadEditor } from "./editorLib.js";
import { mkdir, readdir, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { createComfyClient } from "./comfy/client.js";
import { ApiError, RuntimeLostError } from "./errors.js";
import { EventBus } from "./events.js";
import { HardwareService } from "./hardware/service.js";
import { Installer } from "./install/installer.js";
import { OnboardingService } from "./onboarding.js";
import { dataPaths, defaultNodesDir, defaultRecipesDir, defaultWorkflowsDir, SAMPLE_RECIPES_DIR } from "./paths.js";
import { EditorBridge } from "./projects/editor.js";
import { ProjectService } from "./projects/service.js";
import { ProjectStore } from "./projects/store.js";
import { JobQueue } from "./queue/queue.js";
import { JobStore } from "./queue/store.js";
import { loadRecipes, type RecipeSet } from "./recipes.js";
import { remoteRuntimes, RemoteService } from "./remote/service.js";
import { RuntimeSwitch } from "./remote/switch.js";
import { MockStepRunner } from "./runner/mock.js";
import { SdkStepRunner } from "./runner/sdk.js";
import type { StepRunner } from "./runner/types.js";
import { AttachRuntime, LocalRuntime, MockRuntime, type Runtime } from "./runtime/runtime.js";
import { corsHeaders, HANDLED, isClientAbort, refuseRequest, Reply, sendError, sendFile, sendJson, type Ctx } from "./server/http.js";
import { buildRouter, type EngineContext } from "./server/routes.js";
import { SettingsStore } from "./settings.js";
import { consoleLogger, errorMessage, exists, type Logger } from "./util.js";

export interface EngineOptions {
  /** 0 picks a free port. */
  port: number;
  dataDir: string;
  /** Built UI (apps/web/dist) to serve at / in web mode. */
  webDir?: string;
  /** Attach to a running comfy-api-proxy instead of spawning ComfyUI. */
  comfyBaseUrl?: string;
  /** Fake the GPU runtime with quick placeholder media. */
  mock?: boolean;
  /** Interface to listen on. Default 127.0.0.1 (local only). */
  host?: string;
  recipesDir?: string;
  workflowsDir?: string;
  /** Our ComfyUI node pack, linked into custom_nodes on install. */
  nodesDir?: string;
  /** Use an existing ComfyUI checkout instead of dataDir/comfyui. */
  comfyDir?: string;
  /** Mock pacing: 1 realistic, 0 instant. */
  mockSpeed?: number;
  /** Extra origins allowed to make writes, e.g. a desktop shell's "app://nightshift". Loopback origins always are. */
  allowedOrigins?: string[];
  /** Runs recipe steps instead of the SDK or mock runner (tests, embedding). */
  runner?: StepRunner;
  /** Paths to the editor's tools (ffmpeg, whisper.cpp and its models, Chrome) when they are not found by themselves. */
  editorTools?: ToolOverrides;
  /** Attach and remote mode: how often to check that the proxy and the ComfyUI behind it answer, ms. Default 10 s. */
  attachCheckMs?: number;
  log?: Logger;
}

export interface EngineHandle {
  url: string;
  stop(): Promise<void>;
}

export async function startEngine(opts: EngineOptions): Promise<EngineHandle> {
  const log = opts.log ?? consoleLogger;
  const paths = dataPaths(opts.dataDir, opts.comfyDir ?? process.env.NIGHTSHIFT_COMFY_DIR);
  const mode: Runtime["mode"] = opts.mock ? "mock" : opts.comfyBaseUrl ? "attach" : "local";
  const mockSpeed = opts.mockSpeed ?? Number(process.env.NIGHTSHIFT_MOCK_SPEED ?? 1);
  const workflowsDir = opts.workflowsDir ?? defaultWorkflowsDir();
  await mkdir(paths.root, { recursive: true });
  // Leftovers from a crash: nothing is running yet, so the scratch space can go.
  await rm(paths.work, { recursive: true, force: true });
  await mkdir(paths.work, { recursive: true });

  const bus = new EventBus();
  const settings = new SettingsStore(paths.settings);
  await settings.load();
  const hardware = new HardwareService(paths.root, paths.hardware);
  await hardware.load();

  const recipesDir = opts.recipesDir ?? defaultRecipesDir();
  let recipeSet: RecipeSet = { dir: recipesDir, recipes: [], problems: [] };
  const reloadRecipes = async (): Promise<RecipeSet> => {
    let set = await loadRecipes(recipesDir, workflowsDir);
    if (set.recipes.length === 0 && mode === "mock") {
      // No recipes from the model lab yet: mock mode runs on the engine's sample recipes.
      set = await loadRecipes(SAMPLE_RECIPES_DIR, workflowsDir);
    }
    const before = JSON.stringify(recipeSet.problems);
    recipeSet = set;
    if (JSON.stringify(set.problems) !== before) {
      for (const p of set.problems) log(`recipe ${p.file} ${p.severity}: ${p.message}`);
    }
    return set;
  };
  await reloadRecipes();
  log(`${recipeSet.recipes.length} recipe(s) from ${recipeSet.dir}: ${recipeSet.recipes.map((r) => r.tier).join(", ") || "none"}`);

  const recipeFor = (tier: string) => recipeSet.recipes.find((r) => r.tier === tier);
  const nodesDir = opts.nodesDir ?? defaultNodesDir();
  // Loaded in the background: the engine starts without it, and only exports and the install plan wait for it.
  const editorLib = loadEditor();
  editorLib.catch((err: unknown) => log(`exports will not work: ${errorMessage(err)}`));
  /** Where the editor finds ffmpeg; ComfyUI gets it on its PATH too (Nightshift's final node runs it). */
  const toolDirs = async (): Promise<string[]> => {
    const ffmpeg = (await editorLib.catch(() => undefined))?.checkTools(opts.editorTools ?? {}).ffmpeg;
    return ffmpeg ? [dirname(ffmpeg)] : [];
  };
  // Started for this machine, the engine can also send its work to a GPU computer on the network (Settings.remote).
  const runtime: Runtime =
    mode === "mock"
      ? new MockRuntime(bus, mockSpeed, process.env.NIGHTSHIFT_MOCK_OTHER_GPU)
      : mode === "attach"
        ? new AttachRuntime(bus, opts.comfyBaseUrl!.replace(/\/+$/, ""), log, opts.attachCheckMs)
        : new RuntimeSwitch(
            bus,
            (b) => new LocalRuntime(b, { paths, recipe: recipeFor, hardware: () => hardware.effective(), settings: () => settings.get(), log, nodesDir, workflowsDir, toolDirs }),
            remoteRuntimes({ paths, workflowsDir, recipe: recipeFor, log, ...(opts.attachCheckMs ? { checkMs: opts.attachCheckMs } : {}) }),
          );

  let client: { url: string; comfy: Comfy } | undefined;
  const comfyClient = (): Comfy => {
    const url = runtime.baseUrl();
    if (!url) throw new RuntimeLostError("The GPU runtime is not ready");
    if (client?.url !== url) client = { url, comfy: createComfyClient(url) };
    return client.comfy;
  };
  const runner: StepRunner = opts.runner ?? (mode === "mock" ? new MockStepRunner(mockSpeed) : new SdkStepRunner(comfyClient, workflowsDir, log));

  const store = new ProjectStore(paths.projects, bus, log);
  await store.load();
  const jobStore = new JobStore(paths.db);
  const queue = new JobQueue(jobStore, bus, { settings: () => settings.get(), log, otherGpuUse: () => runtime.status().otherGpuUse });
  const editor = new EditorBridge({ store, log, lib: () => editorLib, ...(opts.editorTools ? { tools: opts.editorTools } : {}) });
  const service = new ProjectService({ store, queue, recipes: () => recipeSet, settings, runtime, runner, editor, paths, workflowsDir, log });
  const installer = new Installer({
    mode,
    paths,
    bus,
    runtime,
    recipes: () => recipeSet,
    hardware,
    settings,
    nodesDir,
    log,
    mockSpeed,
    exclusive: (fn) => queue.exclusive(fn),
    runningJob: () => queue.runningJob,
    editor: () => editorLib,
    ...(opts.editorTools ? { editorTools: opts.editorTools } : {}),
  });
  await installer.load();
  const remote = new RemoteService({ runtime, settings, installer, reloadRecipes, workflowsDir, paths, exclusive: (fn) => queue.exclusive(fn), log });
  await remote.load();
  const onboarding = new OnboardingService({ path: paths.onboarding, store, service, queue, bus, log });
  await onboarding.load();

  // Jobs waiting for the GPU say so while it is gone, and start as soon as it is back: a job that lost it mid-run
  // does not sit out the rest of its retry pause.
  let gpuWas = runtime.available();
  bus.subscribe((ev) => {
    if (ev.type !== "runtime") return;
    const gpu = runtime.available();
    if (gpu && !gpuWas) queue.retryNow();
    gpuWas = gpu;
    queue.kick();
  });
  // While a GPU job runs, local mode looks for other programs crowding the GPU (RuntimeStatus.otherGpuUse).
  bus.subscribe((ev) => {
    if (ev.type === "job") runtime.setGpuBusy(queue.runningJob?.status === "running");
  });
  queue.start({
    blocked: (j) => service.blocked(j),
    execute: (j, p, c) => service.execute(j, p, c),
    onSettled: (j, p) => service.onSettled(j, p),
    onRuntimeLost: () => runtime.noteLost(),
  });

  const ctx: EngineContext = { paths, bus, hardware, recipes: () => recipeSet, reloadRecipes, workflowsDir, installer, remote, runtime, settings, store, service, queue, onboarding, log, sseClients: new Set() };
  const router = buildRouter(ctx);
  const webDir = opts.webDir ? resolve(opts.webDir) : undefined;
  if (webDir && !(await exists(join(webDir, "index.html")))) log(`warning: ${webDir} has no index.html`);

  const host = opts.host ?? "127.0.0.1";
  const loopbackOnly = ["127.0.0.1", "localhost", "::1"].includes(host);
  let stopping = false;
  const server = createServer((req, res) => void handle(req, res));
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cors = corsHeaders(req.headers.origin);
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
    try {
      const refused = refuseRequest(req, loopbackOnly, opts.allowedOrigins ?? []);
      if (refused) throw new ApiError(403, refused);
      const url = new URL(req.url ?? "/", "http://localhost");
      if (stopping && url.pathname.startsWith("/api/")) throw new ApiError(503, "The engine is stopping");
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        return void res.end();
      }
      if (url.pathname.startsWith("/api/")) {
        const match = router.match(req.method ?? "GET", url.pathname);
        if (match === undefined) throw new ApiError(404, `No route ${req.method} ${url.pathname}`);
        if (match === "wrong_method") throw new ApiError(405, `${req.method} is not allowed on ${url.pathname}`);
        const c: Ctx = { req, res, params: match.params, query: url.searchParams };
        const out = await match.handler(c);
        if (out === HANDLED) return;
        if (out instanceof Reply) return sendJson(res, out.status, out.body);
        return sendJson(res, 200, out);
      }
      if (req.method !== "GET" && req.method !== "HEAD") throw new ApiError(405, "Method not allowed");
      if (!webDir) return sendJson(res, 200, { name: "nightshift-engine", mode, ui: "not served (start with --web-dir)" });
      await serveStatic(req, res, webDir, url.pathname);
    } catch (err) {
      // A client that hung up (a cancelled upload, a closed tab) gets no answer and is no failure of ours.
      if (isClientAbort(err, req, res)) return void res.destroy();
      if (!(err instanceof ApiError)) log(`${req.method} ${req.url} failed: ${errorMessage(err)}`);
      sendError(res, err);
    }
  }

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const addr = server.address() as AddressInfo;
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${addr.port}`;
  const target = mode === "attach" ? opts.comfyBaseUrl : runtime instanceof RuntimeSwitch ? runtime.remoteUrl : null;
  log(`Nightshift engine at ${url} (${runtime.mode}${target ? ` -> ${target}` : ""})`);

  void installer.resume().catch((err) => log(`resume failed: ${errorMessage(err)}`));

  let stopped: Promise<void> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      log("stopping");
      stopping = true;
      for (const close of [...ctx.sseClients]) close();
      server.closeIdleConnections?.();
      const closed = new Promise<void>((r) => server.close(() => r()));
      await installer.stop();
      await service.stop();
      await queue.stop();
      await runtime.stop();
      server.closeAllConnections?.();
      await closed;
      jobStore.close();
    })());
  return { url, stop };
}

/** Serve the built UI. Unknown paths get index.html so client-side routes work on reload. */
async function serveStatic(req: IncomingMessage, res: ServerResponse, webDir: string, pathname: string): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new ApiError(400, "Malformed URL");
  }
  const rel = normalize(decoded).replace(/^([/\\])+/, "");
  const file = resolve(webDir, rel);
  if (file !== webDir && !file.startsWith(webDir + sep)) throw new ApiError(404, "Not found");
  const isFile = rel && (await exists(file)) && !(await readdir(file).then(() => true).catch(() => false));
  if (isFile) {
    const hashed = /[.-][A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|svg|jpg|webp)$/.test(file);
    return sendFile(req, res, file, hashed ? "public, max-age=31536000, immutable" : "no-cache");
  }
  return sendFile(req, res, join(webDir, "index.html"), "no-cache");
}
