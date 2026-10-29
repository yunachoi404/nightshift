/** Every route in the contract's `routes`, wired to the engine. Request bodies are validated with the contract's schemas. */
import {
  AssetSchema,
  AudioRequestSchema,
  CreateProjectRequestSchema,
  DraftRequestSchema,
  ExportRequestSchema,
  FinalRequestSchema,
  HardwareProfileSchema,
  InstallRequestSchema,
  OnboardingSampleRequestSchema,
  RemoteCheckRequestSchema,
  RemoteUseRequestSchema,
  routes,
  StillRequestSchema,
  UpdateProjectRequestSchema,
  type Event,
  type TemplateId,
} from "@nightshift/contract";
import { mkdir, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { kindFromFilename } from "../comfy/bind.js";
import { ApiError, badRequest, notFound } from "../errors.js";
import type { EventBus } from "../events.js";
import type { HardwareService } from "../hardware/service.js";
import type { Installer } from "../install/installer.js";
import type { OnboardingService } from "../onboarding.js";
import type { DataPaths } from "../paths.js";
import type { ProjectService } from "../projects/service.js";
import { SAFE_ID, type ProjectStore } from "../projects/store.js";
import type { JobQueue } from "../queue/queue.js";
import { recommendTier, tierSummaries, type RecipeSet } from "../recipes.js";
import type { RemoteService } from "../remote/service.js";
import type { Runtime } from "../runtime/runtime.js";
import { SettingsPatchSchema, type SettingsStore } from "../settings.js";
import { errorMessage, newId, type Logger } from "../util.js";
import { extFromMime, HANDLED, readBody, Reply, Router, saveBody, saveMultipartFile, sendFile, type Ctx } from "./http.js";

export interface EngineContext {
  paths: DataPaths;
  bus: EventBus;
  hardware: HardwareService;
  recipes: () => RecipeSet;
  reloadRecipes: () => Promise<RecipeSet>;
  installer: Installer;
  remote: RemoteService;
  runtime: Runtime;
  settings: SettingsStore;
  store: ProjectStore;
  service: ProjectService;
  queue: JobQueue;
  onboarding: OnboardingService;
  log: Logger;
  /** Open SSE streams; each entry closes its stream and unsubscribes. Called on shutdown. */
  sseClients: Set<() => void>;
}

const MAX_UPLOAD_BYTES = 2 * 1024 ** 3;

const RoleSchema = AssetSchema.shape.role;

/** What an upload is: from its MIME type, else its extension. Latents are never uploaded. */
function uploadKind(mime: string, filename: string): "image" | "video" | "audio" | undefined {
  const top = mime.split("/")[0];
  if (top === "image" || top === "video" || top === "audio") return top;
  const kind = kindFromFilename(filename);
  return kind === "image" || kind === "video" || kind === "audio" ? kind : undefined;
}

/** An upload's role when the request does not name one: a song for a music video, a reference for everything else. */
export function defaultUploadRole(template: TemplateId, kind: "image" | "video" | "audio"): "music" | "reference" {
  return template === "music_video" && kind === "audio" ? "music" : "reference";
}

export function buildRouter(e: EngineContext): Router {
  const r = new Router();
  const id = (ctx: Ctx, key = "id") => {
    const v = ctx.params[key] ?? "";
    if (!SAFE_ID.test(v)) throw notFound(`No ${key === "id" ? "project" : key} ${v}`);
    return v;
  };

  // ---------------------------------------------------------------- hardware and tiers
  // Recipes are matched against the computer that runs them: a GPU computer on the network while one is in use.
  const matched = async () => e.remote.hardware() ?? (await e.hardware.effective());
  r.add(routes.hardware, matched);
  r.add(routes.hardwareManual, async ({ req }) => e.hardware.setManual(await readBody(req, HardwareProfileSchema)));
  r.add(routes.hardwareReset, () => e.hardware.clearManual());
  r.add(routes.tiers, async () => tierSummaries((await e.reloadRecipes()).recipes, await matched()));

  // ---------------------------------------------------------------- install and runtime
  r.add(routes.installPlan, async ({ query }) => {
    const set = await e.reloadRecipes();
    const tier = query.get("tier") || recommendTier(set.recipes, await matched())?.tier;
    if (!tier) throw notFound("No tier fits this machine; pass ?tier=");
    return e.installer.plan(tier);
  });
  r.add(routes.install, async ({ req }) => {
    const body = await readBody(req, InstallRequestSchema);
    await e.reloadRecipes();
    e.installer.start(body.tier, body.memoryLimitGb);
    return new Reply(202, e.runtime.status());
  });
  r.add(routes.remoteCheck, async ({ req }) => e.remote.check((await readBody(req, RemoteCheckRequestSchema)).url));
  r.add(routes.remoteUse, async ({ req }) => new Reply(202, await e.remote.use(await readBody(req, RemoteUseRequestSchema))));
  r.add(routes.remoteForget, () => e.remote.forget());
  r.add(routes.status, () => e.runtime.status());
  r.add(routes.settings, () => e.settings.get());
  r.add(routes.updateSettings, async ({ req }) => {
    const patch = await readBody(req, SettingsPatchSchema);
    const before = e.settings.get();
    const after = await e.settings.update(patch);
    applySettings(e, before, after);
    return after;
  });

  // ---------------------------------------------------------------- onboarding
  r.add(routes.onboarding, () => e.onboarding.get());
  r.add(routes.onboardingSample, async ({ req }) => e.onboarding.sample((await readBody(req, OnboardingSampleRequestSchema)).again === true));
  r.add(routes.onboardingDone, () => e.onboarding.finish());

  // ---------------------------------------------------------------- projects
  r.add(routes.listProjects, () => e.store.list());
  r.add(routes.createProject, async ({ req }) => {
    const project = await e.service.createProject(await readBody(req, CreateProjectRequestSchema));
    // A project of the user's own means setup is behind them.
    await e.onboarding.finish();
    return new Reply(201, project);
  });
  r.add(routes.getProject, (ctx) => e.store.require(id(ctx)));
  r.add(routes.updateProject, async (ctx) => e.service.updateProject(id(ctx), await readBody(ctx.req, UpdateProjectRequestSchema)));
  r.add(routes.deleteProject, async (ctx) => {
    await e.service.deleteProject(id(ctx));
    return new Reply(204);
  });
  r.add(routes.storyboard, async (ctx) => new Reply(202, await e.service.storyboard(id(ctx))));
  r.add(routes.still, async (ctx) => new Reply(202, e.service.still(id(ctx), id(ctx, "shotId"), await readBody(ctx.req, StillRequestSchema))));
  r.add(routes.draft, async (ctx) => new Reply(202, await e.service.draft(id(ctx), id(ctx, "shotId"), await readBody(ctx.req, DraftRequestSchema))));
  r.add(routes.final, async (ctx) => new Reply(202, await e.service.final(id(ctx), id(ctx, "shotId"), await readBody(ctx.req, FinalRequestSchema))));
  r.add(routes.audio, async (ctx) => new Reply(202, e.service.audio(id(ctx), await readBody(ctx.req, AudioRequestSchema))));
  r.add(routes.exportVideo, async (ctx) => new Reply(202, e.service.exportVideo(id(ctx), await readBody(ctx.req, ExportRequestSchema))));

  r.add(routes.deleteAsset, async (ctx) => {
    await e.service.deleteReferenceAsset(id(ctx), id(ctx, "assetId"));
    return new Reply(204);
  });

  r.add(routes.asset, async (ctx) => {
    const project = e.store.require(id(ctx));
    const asset = e.store.findAsset(project, ctx.params.assetId);
    if (!asset) throw notFound(`No asset ${ctx.params.assetId}`);
    // Asset files never change once written, so browsers may cache them for good.
    await sendFile(ctx.req, ctx.res, e.store.assetPath(project, asset), "private, max-age=31536000, immutable");
    return HANDLED;
  });

  // The UI sends multipart with the field "file". Raw bytes with ?filename= (or a Content-Type) work too.
  // Role: ?role= (or a "role" form field) when given, else "music" for audio in a music video, else "reference".
  r.add(routes.uploadAsset, async (ctx) => {
    const projectId = id(ctx);
    const project = e.store.require(projectId);
    const dir = join(e.paths.work, "uploads");
    await mkdir(dir, { recursive: true });
    const tmpName = (ext: string) => join(dir, `${newId("up")}${ext}`);
    const contentType = ctx.req.headers["content-type"] ?? "";
    let upload: { path: string; filename: string; mimeType: string; role: string | undefined };
    if (contentType.startsWith("multipart/form-data")) {
      const saved = await saveMultipartFile(ctx.req, tmpName, MAX_UPLOAD_BYTES);
      upload = { ...saved, role: ctx.query.get("role") ?? saved.fields.role };
    } else {
      const filename = ctx.query.get("filename") ?? "";
      const ext = extname(filename).toLowerCase() || extFromMime(contentType);
      if (!/^\.[a-z0-9]{1,6}$/.test(ext) || ext === ".bin") throw badRequest('Send multipart with a "file" field, or raw bytes with ?filename=');
      const path = tmpName(ext);
      await saveBody(ctx.req, path, MAX_UPLOAD_BYTES).catch(async (err: unknown) => {
        await rm(path, { force: true });
        throw err;
      });
      upload = { path, filename, mimeType: contentType, role: ctx.query.get("role") ?? undefined };
    }
    try {
      const asked = ctx.query.get("kind");
      const kind = asked === "image" || asked === "video" || asked === "audio" ? asked : uploadKind(upload.mimeType, upload.filename || upload.path);
      if (!kind) throw new ApiError(415, "Upload an image, a video or an audio file");
      const role = RoleSchema.safeParse(upload.role || defaultUploadRole(project.template, kind));
      if (!role.success) throw badRequest("role must be one of reference, music, voice, sfx");
      return new Reply(201, await e.service.addUpload(projectId, upload.path, kind, role.data));
    } finally {
      await rm(upload.path, { force: true });
    }
  });

  // ---------------------------------------------------------------- jobs and events
  r.add(routes.listJobs, ({ query }) => e.queue.list(query.get("projectId") ? { projectId: query.get("projectId")! } : {}));
  r.add(routes.cancelJob, async (ctx) => {
    const job = await e.queue.cancel(id(ctx));
    if (!job) throw notFound(`No job ${ctx.params.id}`);
    return job;
  });
  r.add(routes.events, ({ req, res }) => {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const send = (event: Event) => {
      if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    res.write("retry: 2000\n\n");
    send({ type: "runtime", status: e.runtime.status() });
    const unsubscribe = e.bus.subscribe(send);
    const ping = setInterval(() => !res.writableEnded && res.write(": ping\n\n"), 15_000);
    const close = () => {
      clearInterval(ping);
      unsubscribe();
      e.sseClients.delete(close);
      if (!res.writableEnded) res.end();
    };
    e.sseClients.add(close);
    req.on("close", close);
    res.on("close", close);
    return HANDLED;
  });

  return r;
}

/** React to a settings change: new tier or memory limit means new launch flags; overnight changes re-check the queue. */
function applySettings(e: EngineContext, before: ReturnType<SettingsStore["get"]>, after: ReturnType<SettingsStore["get"]>): void {
  e.queue.kick();
  const tierChanged = before.tier !== after.tier;
  const limitChanged = before.memoryLimitGb !== after.memoryLimitGb;
  if (!tierChanged && !limitChanged) return;
  const tier = after.tier;
  if (!tier) return e.runtime.setPhase("not_installed", null);
  // A GPU computer on the network has any tier's models; this machine only the tiers installed here.
  if (e.runtime.mode === "remote" ? !e.installer.recipe(tier) : !e.installer.isInstalled(tier)) return e.runtime.setPhase("not_installed", tier);
  const phase = e.runtime.status().phase;
  // Installing or stopped: the next start reads the new settings anyway. Ready, starting or error: restart now.
  if (!tierChanged && (phase === "installing" || phase === "not_installed" || phase === "stopped")) return;
  void e.queue
    .exclusive(async () => {
      e.log(tierChanged ? `switching runtime to tier ${tier}` : `memory limit now ${after.memoryLimitGb ?? "recipe default"} GB, restarting the runtime`);
      await e.runtime.restart(tier);
    })
    .catch((err) => e.log(`runtime restart failed: ${errorMessage(err)}`));
}
