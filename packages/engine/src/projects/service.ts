/**
 * Project operations behind the HTTP routes: create and edit projects, and turn "make a still / draft /
 * final / song / export" into queued jobs. When a job runs, `execute` fills the recipe step's inputs,
 * runs it (SDK or mock), and files the outputs into the project as assets, shots and takes.
 *
 * The timeline is cut by the editor (packages/editor, through editor.ts) until someone edits it by hand: every
 * change to the shots or the audio re-cuts it, and every export cuts it afresh with full analysis (beats, word times).
 * Measuring a song or a voiceover (beats, word times) is an analysis job on the CPU worker, queued for every one that
 * is uploaded or made, so it shows in the queue, can be cancelled, and never runs beside the GPU unseen.
 */
import type {
  Asset,
  AudioRequest,
  CreateProjectRequest,
  DraftRequest,
  ExportRequest,
  FinalRequest,
  Job,
  Project,
  Recipe,
  Shot,
  StepId,
  StillRequest,
  Take,
  Timeline,
  UpdateProjectRequest,
  WorkflowRef,
} from "@nightshift/contract";
import { finalFor } from "@nightshift/contract";
import { randomInt } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { floorFrames, frameCount, frameRule, graphDefault, longestClipSec, sizeForAspect, sizeForRatio, type Graph, type Size } from "../comfy/bind.js";
import { ApiError, badRequest, conflict, notFound } from "../errors.js";
import type { DataPaths } from "../paths.js";
import { WAITING_FOR_GPU, type ExecContext, type ExecResult, type JobQueue } from "../queue/queue.js";
import type { JobPayload } from "../queue/store.js";
import type { RecipeSet } from "../recipes.js";
import type { StepOutput, StepRequest, StepRunner } from "../runner/types.js";
import type { Runtime } from "../runtime/runtime.js";
import type { SettingsStore } from "../settings.js";
import { errorMessage, exists, isAbortError, newId, nowIso, round1, type Logger } from "../util.js";
import type { Assembled, EditorBridge } from "./editor.js";
import type { ProjectStore } from "./store.js";
import { effectDirection, effectPhoto, runEffect, runEffectFrame } from "./effects.js";
import { briefForLlm, conformsToTemplate, parseStoryboard, stylePrompt, TEMPLATES, VOICE_INSTRUCTIONS, type ShotPlan } from "./templates.js";
import { cameraSource, cameraMove, cameraPrompt, cameraLayout, prepareCameraProject } from "./camera-move.js";
import { applyReferences, projectReferences, referenceInstructions, referencePrompt, referencesForShot, requireReferenceSupport, validateReferences } from "./references.js";
import { contentKey, patchedTimeline, replaceTrack, stableJson } from "./timeline.js";
import { drawWhatIf, fitWhatIfVoice, renderWhatIf, validateWhatIfBrief, validateWhatIfProject, whatIfDraftSnapshot, writeWhatIf } from "./what-if.js";

export interface ProjectServiceDeps {
  store: ProjectStore;
  queue: JobQueue;
  recipes: () => RecipeSet;
  settings: SettingsStore;
  runtime: Runtime;
  runner: StepRunner;
  editor: EditorBridge;
  paths: DataPaths;
  /** Where recipes' workflows live: their own sizes and defaults are read from there. */
  workflowsDir: string;
  log: Logger;
}

/** Render sizes (landscape) when neither the recipe step nor its workflow says. */
const DEFAULT_SIZE: Partial<Record<StepId, Size>> = {
  still: { width: 1280, height: 720 },
  video_draft: { width: 960, height: 544 },
  video_final_same_take: { width: 1920, height: 1088 },
  video_final_remaster: { width: 1920, height: 1088 },
};

/**
 * The remaster re-renders with the draft as a reference video. MiniMax H3 names its references by tag in the order
 * they are wired (`<Video 1>`), and only follows one the prompt points at. A recipe's `promptPrefix` replaces this.
 */
export const REMASTER_REFERENCE = "Use <Video 1> as the exact composition, camera motion, subject and timing reference.";

const randomSeed = () => randomInt(0, 2 ** 31 - 1);
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
/** Seconds as people read them: 4.04, 6. */
const secs = (s: number) => String(Math.round(s * 100) / 100);

interface Recut {
  running: Promise<void>;
  again: boolean;
  controller: AbortController;
}

/** A same-take final that cannot be the same take. The route answers 409 with it; a queued job fails with it. */
class SameTakeError extends Error {
  override name = "SameTakeError";
}

export class ProjectService {
  private graphs = new Map<string, { mtimeMs: number; graph: Graph }>();
  private recuts = new Map<string, Recut>();
  private stopping = false;

  constructor(private readonly d: ProjectServiceDeps) {}

  /** Stop background re-cuts (engine shutdown). */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const r of this.recuts.values()) r.controller.abort();
    await Promise.all([...this.recuts.values()].map((r) => r.running.catch(() => undefined)));
  }

  // ---------------------------------------------------------------- recipes

  /** The installed tier's recipe, or undefined before onboarding. */
  currentRecipe(): Recipe | undefined {
    const tier = this.d.settings.get().tier;
    return tier ? this.d.recipes().recipes.find((r) => r.tier === tier) : undefined;
  }

  private requireStep(step: StepId): { recipe: Recipe; ref: WorkflowRef } {
    const recipe = this.currentRecipe();
    if (!recipe) throw conflict("No tier is installed yet. Finish onboarding first.");
    const ref = recipe.steps[step];
    if (!ref) throw conflict(`The ${recipe.label} recipe has no ${step.replace(/_/g, " ")} step.`);
    return { recipe, ref };
  }

  /** Why a queued job cannot start yet: GPU steps wait for the GPU. Exports and analysis jobs need none. */
  blocked(job: Job): string | undefined {
    if (job.step === "export" || job.analysis) return undefined;
    if ((job.step === "text" || job.step === "still") && this.d.store.get(job.projectId)?.template === "vfx_effect") return undefined;
    if (job.step === "text" && this.d.store.get(job.projectId)?.template === "camera_move") return undefined;
    if (job.step === "text" && !this.currentRecipe()?.steps.text) return undefined; // template fallback, no GPU
    return this.d.runtime.available() ? undefined : WAITING_FOR_GPU;
  }

  // ---------------------------------------------------------------- projects

  async createProject(req: CreateProjectRequest & { brief: Record<string, unknown> }): Promise<Project> {
    if (req.references?.length) throw badRequest("Create the project, upload its reference images, then add references with PATCH.");
    if (req.template === "what_if") validateWhatIfBrief(req.brief);
    return this.d.store.create({ name: req.name.trim(), template: req.template, aspect: req.aspect, brief: req.brief, ...(req.references !== undefined ? { references: req.references } : {}) });
  }

  async updateProject(id: string, patch: UpdateProjectRequest): Promise<Project> {
    const before = this.d.store.require(id);
    const updated = await this.d.store.mutate(id, (p) => {
      if (patch.name !== undefined) p.name = patch.name.trim();
      if (patch.aspect !== undefined) p.aspect = patch.aspect;
      if (patch.brief !== undefined) p.brief = patch.brief;
      if (patch.timeline !== undefined) p.timeline = patch.timeline === null ? null : patchedTimeline(p, patch.timeline, this.d.store.timelines(id));
      if (patch.shots !== undefined) {
        const ids = new Set<string>();
        // Jobs set these while the UI may hold an older copy: leaving one out keeps the current value.
        const shots = patch.shots.map((incoming) => {
          const now = p.shots.find((s) => s.id === incoming.id);
          if (!now) return incoming;
          const merged: Shot = { ...incoming };
          for (const key of ["stillAssetId", "chosenDraftId", "chosenFinalId"] as const) {
            if (merged[key] === undefined && now[key] !== undefined) merged[key] = now[key];
          }
          // A new pick shows that draft's final, or none yet. A copy that still names the old draft's final cannot keep
          // it, and a draft picked again gets back the final it had.
          if (merged.chosenDraftId !== now.chosenDraftId) {
            const final = finalFor(p.takes, merged.chosenDraftId, merged.chosenFinalId);
            if (final) merged.chosenFinalId = final.id;
            else delete merged.chosenFinalId;
          }
          return merged;
        });
        for (const shot of shots) {
          if (ids.has(shot.id)) throw badRequest(`Duplicate shot id ${shot.id}`);
          ids.add(shot.id);
          if (shot.stillAssetId && !p.assets.some((a) => a.id === shot.stillAssetId)) throw badRequest(`Shot ${shot.id}: no asset ${shot.stillAssetId}`);
          for (const [field, takeId] of [
            ["chosenDraftId", shot.chosenDraftId],
            ["chosenFinalId", shot.chosenFinalId],
          ] as const) {
            if (takeId && !p.takes.some((t) => t.id === takeId && t.shotId === shot.id)) throw badRequest(`Shot ${shot.id}: ${field} ${takeId} is not a take of this shot`);
          }
        }
        // The array order is the storyboard order.
        p.shots = shots.map((s, i) => ({ ...s, index: i }));
      }
      applyReferences(p, patch, before);
      validateWhatIfProject(p);
    });
    // What the cut is made of changed, or the timeline was handed back: cut it again. A PATCH that only carries a
    // timeline does not, so a UI that mirrors the cut it was sent never ping-pongs with the engine.
    const changed = (k: "shots" | "brief" | "aspect") => stableJson(before[k]) !== stableJson(updated[k]);
    const handedBack = patch.timeline === null || (patch.timeline && patch.timeline.edited === false);
    if (changed("shots") || changed("brief") || changed("aspect") || handedBack) {
      await this.recutSoon(id);
      return this.d.store.require(id);
    }
    return updated;
  }

  async deleteProject(id: string): Promise<void> {
    this.d.store.require(id);
    this.recuts.get(id)?.controller.abort();
    await this.d.queue.cancelProject(id);
    await this.recuts.get(id)?.running.catch(() => undefined);
    await this.d.store.delete(id);
  }

  /**
   * Store an uploaded file (a product photo, a voice reference, a song) as a project asset. A song or a voiceover goes
   * on the timeline at once and is measured by an analysis job (beats, word times), so the cut follows it shortly after.
   */
  async addUpload(id: string, tmpPath: string, kind: Asset["kind"], role: Asset["role"] | undefined): Promise<Asset> {
    this.d.store.require(id);
    const asset = await this.d.store.importFile(id, tmpPath, kind, { move: true, ...(role ? { role } : {}) });
    await this.d.store.mutate(id, (p) => void p.assets.push(asset));
    if (kind === "audio" && (role === "music" || role === "voice")) {
      void this.recutSoon(id);
      this.analyze(id, asset, role);
    } else if (kind === "image") {
      void this.recutSoon(id);
    }
    return asset;
  }

  async deleteReferenceAsset(id: string, assetId: string): Promise<void> {
    const project = this.d.store.require(id);
    const asset = this.d.store.findAsset(project, assetId);
    if (!asset) throw notFound(`No asset ${assetId}`);
    if (asset.role !== "reference") throw conflict("Only uploaded references can be removed here.");
    if (this.d.queue.list({ projectId: id }).some(j => j.status === "running" || j.status === "queued")) throw conflict("Wait for this project's jobs to finish before removing a reference.");
    if (project.shots.some(s => s.stillAssetId === assetId || s.keyframes?.some(frame => frame.stillAssetId === assetId)) || project.takes.some(t => t.imageAssetId === assetId || t.videoAssetId === assetId || t.guideAssetIds?.includes(assetId))) throw conflict("This image is used by a shot or take.");
    await this.d.store.mutate(id, p => {
      const removed = new Set(projectReferences(p).filter(r => r.assetId === assetId).map(r => r.id));
      p.references = projectReferences(p).filter(r => r.assetId !== assetId);
      for (const s of p.shots) if (s.referenceIds) s.referenceIds = s.referenceIds.filter(r => !removed.has(r));
      for (const key of ["referenceAssetId", "productAssetId"]) if (p.brief[key] === assetId) delete p.brief[key];
      p.assets = p.assets.filter(a => a.id !== assetId);
    });
    await rm(this.d.store.assetPath(project, asset), { force: true });
    await this.recutSoon(id);
  }

  /** Queue the analysis of a song or a voiceover: its beats or its words' times, then the cut fitted to it. */
  private analyze(projectId: string, asset: Asset, role: "music" | "voice"): Job {
    const job: Job = { ...this.newJob(projectId, role, "now"), analysis: true };
    return this.d.queue.enqueue(job, { kind: "analyze", assetId: asset.id });
  }

  // ---------------------------------------------------------------- timeline

  /**
   * Re-cut an unedited timeline from what is measured so far (quick: what is not measured yet is estimated),
   * serialized per project: a request that arrives during a pass runs one more pass afterwards, so the last change
   * always lands. Measuring is for analysis jobs and exports.
   */
  private recutSoon(id: string): Promise<void> {
    const current = this.recuts.get(id);
    if (current) {
      current.again = true;
      return current.running;
    }
    const entry: Recut = { running: Promise.resolve(), again: false, controller: new AbortController() };
    entry.running = (async () => {
      try {
        do {
          entry.again = false;
          await this.recutOnce(id, entry.controller.signal);
        } while (entry.again && !this.stopping && !entry.controller.signal.aborted);
      } finally {
        this.recuts.delete(id);
      }
    })();
    this.recuts.set(id, entry);
    return entry.running;
  }

  private async recutOnce(id: string, signal: AbortSignal): Promise<void> {
    const project = this.d.store.get(id);
    if (!project || this.stopping || project.timeline?.edited) return;
    try {
      const hasPicture = project.shots.some((s) => s.stillAssetId || project.takes.some((t) => t.shotId === s.id && t.videoAssetId));
      if (!hasPicture && !project.timeline) return;
      const cut = await this.d.editor.assemble(project, { analyze: false, signal });
      if (signal.aborted) return;
      await this.storeCut(id, cut.timeline);
    } catch (err) {
      if (!signal.aborted && !isAbortError(err)) this.d.log(`project ${id}: could not cut the timeline: ${errorMessage(err)}`);
    }
  }

  /** Store a new cut unless someone edited the timeline meanwhile. Unchanged cuts are not written (no event). */
  private async storeCut(id: string, timeline: Timeline): Promise<void> {
    const current = this.d.store.get(id);
    if (!current || current.timeline?.edited) return;
    const next = { ...timeline, style: current.timeline?.style ?? timeline.style };
    if (contentKey(current.timeline) === contentKey(next)) return;
    await this.d.store.mutate(id, (p) => {
      // A quick cut owns clip timing. Keep style edits made while it was being assembled.
      if (!p.timeline?.edited) p.timeline = { ...timeline, style: p.timeline?.style ?? timeline.style };
    });
  }

  /** A new song or voice on a hand-edited timeline: it takes the old track's place, and brings its captions. */
  private async placeOnEdited(project: Project, asset: Asset, role: "music" | "voice", signal?: AbortSignal): Promise<void> {
    const tl = structuredClone(project.timeline!);
    const track = replaceTrack(tl, asset, role);
    const captionsFrom = project.template === "music_video" ? "music" : "voice";
    const end = Math.max(0, ...tl.clips.map((c) => c.start + (c.out - c.in)), ...(tl.overlays ?? []).map((ov) => ov.end));
    let captions = tl.captions;
    if (role === captionsFrom) {
      const kind = role === "music" ? "lyrics" : "speech";
      // `outSec` is in the file's own time: the track plays it from 0, so it ends where the timeline does.
      captions = (await this.d.editor.captionsFor(project, asset, { kind, start: track.start, outSec: Math.max(0, end - track.start), ...(signal ? { signal } : {}) })).captions;
    }
    // Applied to the timeline as it is now: it may have been edited again while the words were timed.
    await this.d.store.mutate(project.id, (p) => {
      if (!p.timeline?.edited) return; // handed back meanwhile: the next cut places the track
      const placed = replaceTrack(p.timeline, asset, role);
      if (role === captionsFrom) p.timeline.captions = shiftCaptions(captions, placed.start - track.start);
    });
  }

  /**
   * Cut the project with full analysis (beats, word times) and store the cut unless the timeline was edited, or for
   * an export that asks to `rebuild`. Measuring can take minutes while stills and drafts keep landing, so a cut made
   * from a project that changed meanwhile is made again from the current one; what was measured is kept, so that is
   * quick. Returns the stored cut and the project it was made from.
   */
  private async measuredCut(id: string, o: { signal: AbortSignal; rebuild?: boolean; onProgress?: (fraction: number, message: string) => void }): Promise<{ project: Project; cut: Assembled }> {
    for (let pass = 1; ; pass++) {
      const project = this.d.store.require(id);
      const cut = await this.d.editor.assemble(project, { analyze: true, signal: o.signal, ...(pass === 1 && o.onProgress ? { onProgress: o.onProgress } : {}) });
      let changed = false;
      const stored = await this.d.store.mutate(id, (p) => {
        changed = cutInputs(p) !== cutInputs(project);
        if (changed && pass < 4) return;
        if (o.rebuild || !p.timeline?.edited) p.timeline = cut.timeline;
      });
      if (!changed) return { project: stored, cut };
      // Still changing after a few passes: this cut stands, and the quick re-cut the last change asked for follows it.
      if (pass >= 4) {
        void this.recutSoon(id);
        return { project: stored, cut };
      }
    }
  }

  // ---------------------------------------------------------------- job submission

  private newJob(projectId: string, step: Job["step"], mode: Job["mode"], shotId?: string): Job {
    const job: Job = { id: newId("job"), projectId, step, mode, status: "queued", progress: 0, outputAssetIds: [], createdAt: nowIso() };
    if (shotId) job.shotId = shotId;
    return job;
  }

  private shot(project: Project, shotId: string): Shot {
    const shot = project.shots.find((s) => s.id === shotId);
    if (!shot) throw notFound(`No shot ${shotId} in project ${project.id}`);
    return shot;
  }

  async storyboard(id: string): Promise<Job> {
    const project = this.d.store.require(id);
    if (project.template === "what_if") {
      this.requireWhatIf();
      validateWhatIfProject(project);
      if (this.d.queue.list({ projectId: id }).some(j => j.status === "queued" || j.status === "running")) throw conflict("Wait for this film's jobs to finish before rewriting its story.");
    }
    if (project.template === "camera_move") {
      this.requireStep("camera_layout");
      this.requireStep("video_camera_move");
      const ready = await prepareCameraProject(project, this.d.store);
      await this.recutSoon(id);
      return this.draft(id, ready.shots[0]!.id, {});
    }
    if (project.template === "vfx_effect") {
      const direction = effectDirection(project.brief);
      this.requireStep(direction.end === null ? "video_draft" : "effect_end_frame");
      this.requireStep("video_effect");
      effectPhoto(project);
    }
    return this.d.queue.enqueue(this.newJob(id, "text", "now"), { kind: "storyboard", seed: randomSeed() });
  }

  still(id: string, shotId: string, req: StillRequest): Job {
    const project = this.d.store.require(id);
    const shot = this.shot(project, shotId);
    if (project.template === "what_if") {
      this.requireWhatIf();
      validateWhatIfProject(project);
      const frames = structuredClone(shot.keyframes!);
      const index = req.keyframeIndex ?? 0;
      if (index > 0 && !frames[index - 1]?.stillAssetId) throw conflict("Draw the preceding beat first.");
      if (req.prompt) frames[index]!.prompt = req.prompt;
      return this.d.queue.enqueue(this.newJob(id, "still", "now", shotId), { kind: "still", seed: req.seed ?? randomSeed(),
        keyframeIndex: index, whatIfFrames: frames, whatIfPhotoId: project.brief.photoAssetId, whatIfCameraMove: shot.cameraMove });
    }
    if (project.template === "camera_move") throw conflict("This shot starts from your photo. Change the photo to change its still.");
    if (project.template === "vfx_effect") effectPhoto(project);
    else {
      const { recipe } = this.requireStep("still");
      validateReferences(project);
      requireReferenceSupport(recipe, referencesForShot(project, this.shot(project, shotId)));
    }
    const payload: JobPayload = { kind: "still", seed: req.seed ?? randomSeed() };
    if (req.prompt) payload.prompt = req.prompt;
    return this.d.queue.enqueue(this.newJob(id, "still", "now", shotId), payload);
  }

  async draft(id: string, shotId: string, req: DraftRequest): Promise<Job> {
    const project = this.d.store.require(id);
    const shot = this.shot(project, shotId);
    if (project.template === "what_if") {
      this.requireWhatIf();
      return this.d.queue.enqueue(this.newJob(id, "video_what_if", "now", shotId), { kind: "draft", seed: req.seed ?? randomSeed(), ...whatIfDraftSnapshot(project, shot) });
    }
    if (project.template === "vfx_effect") {
      const direction = effectDirection(project.brief);
      this.requireStep(direction.end === null ? "video_draft" : "effect_end_frame");
      this.requireStep("video_effect");
      effectPhoto(project);
      return this.d.queue.enqueue(this.newJob(id, "video_effect", "now", shotId), {
        kind: "draft", seed: req.seed ?? randomSeed(), effectBrief: project.brief,
        effectPrompt: shot.prompt === TEMPLATES.vfx_effect.fallback(project.brief)[0]?.prompt ? str(project.brief.prompt) ?? "" : shot.prompt,
      });
    }
    const step = project.template === "camera_move" ? "video_camera_move" : "video_draft";
    const { ref } = this.requireStep(step);
    const payload: JobPayload = { kind: "draft", seed: req.seed ?? randomSeed() };
    if (project.template === "camera_move") {
      this.requireStep("camera_layout");
      payload.cameraPhotoId = cameraSource(project).id;
      payload.cameraMove = cameraMove(shot.cameraMove ?? project.brief.move);
      payload.cameraPrompt = cameraPrompt(shot.prompt, String(payload.cameraMove));
    }
    if (ref.inputs.image && !shot.stillAssetId) throw conflict("Make a still for this shot first: the draft starts from it.");
    // The take appears when the draft is done (a failed or cancelled job leaves nothing behind).
    return this.d.queue.enqueue(this.newJob(id, step, "now", shotId), payload);
  }

  async final(id: string, shotId: string, req: FinalRequest): Promise<Job> {
    const project = this.d.store.require(id);
    if (project.template === "what_if" && req.kind !== "same_take") throw conflict("What-if films finish from their saved take. Remastering a full film is not supported yet.");
    this.shot(project, shotId);
    const step: StepId = req.kind === "same_take" ? "video_final_same_take" : "video_final_remaster";
    const { ref } = this.requireStep(step);
    const draft = project.takes.find((t) => t.id === req.draftId && t.shotId === shotId && t.rung === "draft");
    if (!draft) throw notFound(`No draft ${req.draftId} for shot ${shotId}`);
    if (!draft.videoAssetId) throw conflict("That draft has not finished rendering yet.");
    if (req.kind === "same_take") {
      try {
        await this.sameTakeInputs(project, draft, ref);
      } catch (err) {
        if (err instanceof SameTakeError) throw conflict(err.message);
        throw err;
      }
    }
    return this.d.queue.enqueue(this.newJob(id, step, req.mode, shotId), { kind: "final", draftId: draft.id, finalKind: req.kind });
  }

  /**
   * What a same-take final is made from: exactly what its draft was made from. Every input the same-take workflow takes
   * (the saved latent, the prompt, the negative prompt, the still, the seed, the draft video) must come from the draft's
   * record, and its files must be in the project. A final made without one of them would be a different take, so it
   * is refused instead, saying what is missing.
   */
  private async sameTakeInputs(project: Project, draft: Take, ref: WorkflowRef): Promise<{ values: Record<string, unknown>; imageAssetId?: string }> {
    const takes = (name: string) => name in ref.inputs;
    const remaster = this.currentRecipe()?.steps.video_final_remaster ? " Make a new draft, or finish this one as a remaster." : " Make a new draft.";
    const refuse = (what: string): never => {
      throw new SameTakeError(`${what}, so it cannot be finished as the same take.${remaster}`);
    };
    const file = async (assetId: string | undefined) => {
      const path = this.assetFile(project, assetId);
      return path && (await exists(path)) ? path : undefined;
    };
    const values: Record<string, unknown> = {};
    const video = await file(draft.videoAssetId);
    if (!video) refuse("The draft's video is missing from the project folder");
    values.video = video;
    if (takes("latent")) {
      if (!draft.latentAssetId) refuse("This draft has no saved latent");
      values.latent = (await file(draft.latentAssetId)) ?? refuse("This draft's saved latent is missing from the project folder");
    }
    // Drafts made before the engine kept these records cannot promise the same take.
    const unrecorded = (what: string) => refuse(`This draft does not record the ${what} it was made with`);
    if (!Number.isFinite(draft.seed) && takes("seed")) unrecorded("seed");
    values.seed = draft.seed;
    if (draft.prompt !== undefined) values.prompt = draft.prompt;
    else if (takes("prompt")) unrecorded("prompt");
    if (draft.negative !== undefined) values.negative = draft.negative;
    else if (takes("negative")) unrecorded("negative prompt");
    if (!takes("image")) return { values };
    if (!draft.imageAssetId) unrecorded("still");
    values.image = (await file(draft.imageAssetId)) ?? refuse("The still this draft was made from is missing from the project folder");
    return { values, imageAssetId: draft.imageAssetId! };
  }

  audio(id: string, req: AudioRequest): Job {
    const project = this.d.store.require(id);
    this.requireStep(req.role);
    if (req.role === "music" && !str(req.prompt) && !str(req.lyrics)) throw badRequest("A song needs a prompt or lyrics.");
    if (req.role === "voice" && !str(req.text)) throw badRequest("A voiceover needs text.");
    if (req.voiceRefAssetId && !this.d.store.findAsset(project, req.voiceRefAssetId)) throw notFound(`No asset ${req.voiceRefAssetId}`);
    return this.d.queue.enqueue(this.newJob(id, req.role, "now"), { kind: "audio", ...req, seed: req.seed ?? randomSeed() });
  }

  exportVideo(id: string, req: ExportRequest): Job {
    const project = this.d.store.require(id);
    const payload: JobPayload = { kind: "export", aspect: req.aspect, quality: req.quality ?? "standard" };
    if (req.rebuild) payload.rebuild = true;
    if (req.kind === "reveal") {
      // The reveal is one shot's clip: the job carries the shot, and the shot must have a final with its draft.
      const shot = req.shotId ? this.shot(project, req.shotId) : project.shots.length === 1 ? project.shots[0]! : undefined;
      if (!shot) throw badRequest(project.shots.length === 0 ? "This project has no shots." : "Say which shot to reveal (shotId): this project has several.");
      const final = project.takes.find((t) => t.id === shot.chosenFinalId && t.rung === "final");
      if (!final) throw conflict("This shot has no final yet. Finish it first, then share the reveal.");
      if (!project.takes.some((t) => t.id === final.parentTakeId && t.rung === "draft" && t.videoAssetId)) throw conflict("This final does not point at the draft it was made from, so there is nothing to compare.");
      payload.kind = "reveal";
      payload.shotId = shot.id;
      return this.d.queue.enqueue(this.newJob(id, "export", "now", shot.id), payload);
    }
    return this.d.queue.enqueue(this.newJob(id, "export", "now"), payload);
  }

  // ---------------------------------------------------------------- execution (queue hooks)

  async execute(job: Job, payload: JobPayload, ctx: ExecContext): Promise<ExecResult> {
    if (job.analysis) return this.runAnalysis(job, payload, ctx);
    switch (job.step) {
      case "text":
        return this.runStoryboard(job, payload, ctx);
      case "still":
        return this.runStill(job, payload, ctx);
      case "video_draft":
        return this.runDraft(job, payload, ctx);
      case "video_what_if": {
        const project = this.d.store.require(job.projectId);
        try {
          const result = await renderWhatIf(this.whatIfDeps(job), project, this.shot(project, job.shotId!), job, payload, ctx, await this.stepDefault(this.currentRecipe()?.steps.video_what_if, "negative"));
          await this.recutSoon(project.id);
          return result;
        } finally { await this.cleanup(job); }
      }
      case "video_final_same_take":
      case "video_final_remaster":
        return this.runFinal(job, payload, ctx);
      case "music":
      case "voice":
        return this.runAudio(job, payload, ctx);
      case "export":
        return this.runExport(job, payload, ctx);
      case "video_effect": {
        const project = this.d.store.require(job.projectId);
        const direction = effectDirection((payload.effectBrief ?? project.brief) as Project["brief"]);
        const videoStep = direction.end === null ? "video_draft" : "video_effect";
        try {
          const result = await runEffect({
            store: this.d.store,
            run: (step, values, hints, stepPayload, stepCtx, span) => this.runStep(job, stepPayload, step, values, hints, stepCtx, span),
          }, project, this.shot(project, job.shotId!), job, payload, ctx,
          await this.sizeFor("video_effect", project), await this.stepDefault(this.currentRecipe()?.steps[videoStep], "negative"));
          await this.recutSoon(project.id);
          return result;
        } finally { await this.cleanup(job); }
      }
      case "effect_end_frame": {
        const project = this.d.store.require(job.projectId);
        try {
          return await runEffectFrame({
            store: this.d.store,
            run: (step, values, hints, stepPayload, stepCtx, span) => this.runStep(job, stepPayload, step, values, hints, stepCtx, span),
          }, project, payload, ctx, await this.sizeFor("video_effect", project));
        } finally { await this.cleanup(job); }
      }
      case "camera_layout":
      case "video_camera_move":
        return this.runDraft(job, payload, ctx);
    }
  }

  /**
   * Takes are made when a job finishes, so a failed or cancelled job leaves nothing behind. Jobs queued by
   * engines before that change carry a pending take; drop it if it never got a video.
   */
  async onSettled(job: Job, payload: JobPayload): Promise<void> {
    const takeId = str(payload.takeId);
    if (!takeId || !this.d.store.get(job.projectId)) return;
    await this.d.store.mutate(job.projectId, (p) => {
      p.takes = p.takes.filter((t) => t.id !== takeId || !!t.videoAssetId);
      for (const s of p.shots) {
        if (s.chosenDraftId === takeId) delete s.chosenDraftId;
        if (s.chosenFinalId === takeId) delete s.chosenFinalId;
      }
    });
  }

  private async runStep(
    job: Job,
    payload: JobPayload,
    step: StepId,
    values: Record<string, unknown>,
    hints: StepRequest["hints"],
    ctx: ExecContext,
    span: [number, number] = [0, 1],
  ): Promise<{ outputs: StepOutput[]; peakGb?: number }> {
    const { recipe, ref: defaultRef } = this.requireStep(step);
    const ref = step === "still" && values.image ? recipe.referenceStill ?? defaultRef : defaultRef;
    if (step === "still" && values.image && !ref.inputs.image) throw conflict("This recipe cannot make stills from a photo. Choose a recipe with a reference-image workflow.");
    const outDir = join(this.d.paths.work, job.id);
    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    let peak: number | undefined;
    const sample = async () => {
      const gb = await this.d.runtime.sampleMemoryGb();
      if (gb !== null) peak = Math.max(peak ?? 0, gb);
    };
    const timer = this.d.runtime.mode === "local" ? setInterval(() => void sample(), 2000) : undefined;
    try {
      const request: StepRequest = { jobId: job.id, step, ref, values, outDir, hints };
      const comfyKey = step === "camera_layout" ? "_cameraLayoutJobId" : "_comfyJobId";
      if (typeof payload[comfyKey] === "string") request.resumeComfyJobId = payload[comfyKey];
      // A job cancelled or stopped while its inputs were prepared starts no step: nothing is sent to ComfyUI after it.
      ctx.signal.throwIfAborted();
      const outputs = await this.d.runner.run(request, {
        signal: ctx.signal,
        onProgress: (p) => ctx.progress(span[0] + (span[1] - span[0]) * p.progress, p.message),
        onSubmitted: (id) => ctx.remember(comfyKey, id),
      });
      if (timer) await sample();
      // Mock runs report the recipe's estimate so the UI has a number to show.
      if (peak === undefined && this.d.runtime.mode === "mock") peak = recipe.estimates[step]?.peakGb;
      return peak === undefined ? { outputs } : { outputs, peakGb: round1(peak) };
    } finally {
      if (timer) clearInterval(timer);
    }
  }

  private async cleanup(job: Job): Promise<void> {
    await rm(join(this.d.paths.work, job.id), { recursive: true, force: true });
  }

  private requireWhatIf(): void {
    const { recipe } = this.requireStep("video_what_if");
    this.requireStep("still");
    this.requireStep("voice");
    this.requireStep("music");
    if (!recipe.referenceStill?.inputs.image2) throw conflict("This recipe cannot draw linked What-if keyframes.");
  }

  private whatIfDeps(job: Job): Parameters<typeof drawWhatIf>[0] {
    return { store: this.d.store, run: (step, values, hints, payload, ctx, span) => this.runStep(job, payload, step, values, hints, ctx, span) };
  }

  /** Remember child IDs before enqueueing, so retrying the parent never repeats a film or audio job. */
  private whatIfChild(parent: Job, payload: JobPayload, ctx: ExecContext, key: string, step: Job["step"], childPayload: JobPayload, shotId?: string): Job {
    const id = typeof payload[key] === "string" ? payload[key] : undefined;
    const existing = id ? this.d.queue.get(id) : undefined;
    if (existing) return existing;
    const child = this.newJob(parent.projectId, step, "now", shotId);
    if (id) child.id = id;
    ctx.remember(key, child.id);
    return this.d.queue.enqueue(child, childPayload);
  }

  // ---------------------------------------------------------------- sizes

  /** A workflow graph, cached until its file changes. */
  private async graph(ref: WorkflowRef): Promise<Graph | undefined> {
    const path = join(this.d.workflowsDir, ref.workflow);
    try {
      const { mtimeMs } = await stat(path);
      const hit = this.graphs.get(path);
      if (hit?.mtimeMs === mtimeMs) return hit.graph;
      const graph = JSON.parse(await readFile(path, "utf8")) as Graph;
      this.graphs.set(path, { mtimeMs, graph });
      return graph;
    } catch {
      return undefined;
    }
  }

  /** A named input's value before the engine sets it: the recipe's param, else the workflow's own. */
  private async stepDefault(ref: WorkflowRef | undefined, name: string): Promise<unknown> {
    if (!ref) return undefined;
    if (ref.params[name] !== undefined) return ref.params[name];
    const graph = await this.graph(ref);
    return graph ? graphDefault(graph, ref, name) : undefined;
  }

  /** A step's own size, in its own orientation: the recipe's, else its workflow's, else the engine default. */
  private async baseSize(step: StepId): Promise<Size> {
    const ref = this.currentRecipe()?.steps[step];
    const def = DEFAULT_SIZE[step] ?? { width: 1280, height: 720 };
    return { width: num(await this.stepDefault(ref, "width"), def.width), height: num(await this.stepDefault(ref, "height"), def.height) };
  }

  /**
   * The size a step renders a project's shots at, in the project's aspect (see `sizeForAspect`). Stills take their
   * draft's exact shape, so the draft starts from the whole still and the export crops nothing it did not have to.
   */
  async sizeFor(step: StepId, project: Pick<Project, "aspect">): Promise<Size> {
    if (step === "still") {
      const draft = await this.sizeFor("video_draft", project);
      const base = await this.baseSize("still");
      return sizeForRatio(base.width, base.height, draft.width / draft.height);
    }
    const base = await this.baseSize(step);
    return sizeForAspect(base.width, base.height, project.aspect);
  }

  private assetFile(project: Project, assetId: string | undefined): string | undefined {
    const asset = this.d.store.findAsset(project, assetId);
    return asset ? this.d.store.assetPath(project, asset) : undefined;
  }

  /**
   * How many frames a video step makes for a shot. Each model has a frame grid and a longest clip: the recipe step's
   * `maxFrames`, else what the model lab measured (LTX 2.5: 97 frames, about 4 s at 24 fps; H3: 124). A shot longer
   * than that is clamped, not split: the clip is as long as the model allows, and `clampedSec` is the clip's length,
   * which becomes the shot's duration. (Our workflows cannot extend a clip, so segments would not join up.)
   */
  private async frames(ref: WorkflowRef | undefined, durationSec: number, fps: number): Promise<{ frames: number; clampedSec?: number }> {
    const rule = frameRule(ref ? await this.graph(ref) : undefined);
    // A cap below the model's shortest clip is a recipe mistake (the recipe loader warns): the measured limit stands.
    const param = ref?.params.maxFrames;
    const max = typeof param === "number" && param >= rule.grid.step + rule.grid.offset ? param : rule.maxFrames;
    const frames = frameCount(durationSec, fps, max, rule.grid);
    if (max === undefined) return { frames };
    const longest = floorFrames(max, rule.grid) / fps;
    return durationSec > longest + 1e-3 ? { frames, clampedSec: longestClipSec(max, fps, rule.grid) } : { frames };
  }

  // ---------------------------------------------------------------- jobs

  private async runStoryboard(job: Job, payload: JobPayload, ctx: ExecContext): Promise<ExecResult> {
    const project = this.d.store.require(job.projectId);
    if (project.template === "what_if") {
      try {
        const result = await writeWhatIf(this.whatIfDeps(job), project, payload, ctx, !!this.currentRecipe()?.steps.text);
        const current = this.d.store.require(project.id);
        const shot = current.shots[0]!;
        this.whatIfChild(job, payload, ctx, "_whatIfStillJobId", "still", { kind: "still", seed: randomSeed(),
          whatIfFrames: structuredClone(shot.keyframes), whatIfPhotoId: current.brief.photoAssetId, whatIfCameraMove: shot.cameraMove, autoDraft: true }, shot.id);
        this.whatIfChild(job, payload, ctx, "_whatIfVoiceJobId", "voice", { kind: "audio", text: shot.line, voice: "mara",
          prompt: "A warm clear female voice, curious and conversational. Speak briskly and naturally, with short pauses. No dramatic trailer voice.", seed: randomSeed() });
        this.whatIfChild(job, payload, ctx, "_whatIfMusicJobId", "music", { kind: "audio", durationSec: 15,
          prompt: "Instrumental cinematic curiosity, gentle pulsing bass, soft mallets and rising warm synth texture. A playful sense of discovery building to a quiet ending. No vocals, no speech, no lyrics.", seed: randomSeed() });
        await this.recutSoon(project.id);
        return result;
      } finally { await this.cleanup(job); }
    }
    if (project.template === "vfx_effect") {
      const photo = effectPhoto(project);
      effectDirection(project.brief);
      const updated = await this.d.store.mutate(project.id, (p) => {
        p.shots = mergeShots(p.shots, TEMPLATES.vfx_effect.fallback(p.brief));
        for (const shot of p.shots) shot.stillAssetId = photo.id;
        p.takes = p.takes.filter((t) => p.shots.some((s) => s.id === t.shotId));
      });
      await this.recutSoon(project.id);
      for (const shot of updated.shots) {
        if (!shot.chosenDraftId) await this.draft(project.id, shot.id, {});
      }
      return { outputAssetIds: [photo.id], message: "Photo ready. Rendering the effect." };
    }
    if (project.template === "camera_move") {
      // Restore quick-shot requests queued by earlier engine versions.
      const ready = await prepareCameraProject(project, this.d.store);
      await this.recutSoon(project.id);
      await this.draft(project.id, ready.shots[0]!.id, {});
      return { outputAssetIds: [ready.shots[0]!.stillAssetId!], message: "Photo ready. Making the camera move." };
    }
    const template = TEMPLATES[project.template];
    let plans: ShotPlan[] = template.fallback(project.brief);
    let message = "Shot list drafted from the template (this tier has no local LLM step).";
    let peakGb: number | undefined;
    if (this.currentRecipe()?.steps.text) {
      try {
        const brief = briefForLlm(project.template, project.name, project.brief);
        const constraints = `Return exactly ${plans.length} shots.`;
        const values = { system: `${template.instructions} ${constraints} ${referenceInstructions(project)}`, prompt: brief, text: brief, seed: num(payload.seed, 0), fallback: JSON.stringify({ shots: plans }) };
        const res = await this.runStep(job, payload, "text", values, { aspect: project.aspect, width: 0, height: 0 }, ctx);
        peakGb = res.peakGb;
        const out = res.outputs.find((o) => o.kind === "text");
        const parsed = out ? parseStoryboard(await readFile(out.path, "utf8"), template.lines) : undefined;
        if (parsed && conformsToTemplate(project.template, project.brief, parsed)) {
          plans = parsed;
          message = "Shot list drafted.";
        } else {
          message = "The language model's answer did not match this template, so the template's shot list was used.";
        }
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        this.d.log(`storyboard LLM failed, using the template: ${errorMessage(err)}`);
        message = `The language model failed (${errorMessage(err)}), so the template's shot list was used.`;
      } finally {
        await this.cleanup(job);
      }
    }
    const names = projectReferences(project).slice(0, 3).filter(r => r.kind !== "style").map(r => r.label);
    for (const plan of plans) {
      const missing = names.filter(name => !plan.prompt.toLowerCase().includes(name.toLowerCase()));
      if (missing.length) plan.prompt += ` Featuring ${missing.join(" and ")}.`;
    }
    // A shot is one clip of the draft model: none is planned longer than the longest clip it makes, so the storyboard
    // and the cut show from the start the lengths the drafts will have.
    const draftRef = this.currentRecipe()?.steps.video_draft;
    let longest: number | undefined;
    for (const plan of plans) {
      const { clampedSec } = await this.frames(draftRef, plan.durationSec, num(draftRef?.params.fps, 24));
      if (clampedSec === undefined) continue;
      plan.durationSec = clampedSec;
      longest = clampedSec;
    }
    if (longest !== undefined) message += ` Shots are at most ${secs(longest)} s, the longest clip this video model makes.`;
    const updated = await this.d.store.mutate(job.projectId, (p) => {
      p.shots = mergeShots(p.shots, plans);
      // Takes of shots the new list replaced go with them.
      p.takes = p.takes.filter((t) => p.shots.some((s) => s.id === t.shotId));
    });
    await this.recutSoon(updated.id);
    // A new project fills in by itself: every shot without a still gets one queued.
    if (this.currentRecipe()?.steps.still) {
      let unsupported: string | undefined;
      for (const shot of updated.shots) if (!shot.stillAssetId) {
        try { this.still(updated.id, shot.id, {}); }
        catch (error) {
          if (!(error instanceof ApiError) || error.status !== 409) throw error;
          unsupported = error.message;
        }
      }
      if (unsupported) message += ` ${unsupported}`;
    }
    return withPeak({ outputAssetIds: [], message }, peakGb);
  }

  private async runStill(job: Job, payload: JobPayload, ctx: ExecContext): Promise<ExecResult> {
    const project = this.d.store.require(job.projectId);
    const shot = this.shot(project, job.shotId!);
    if (project.template === "what_if") {
      try {
        const result = await drawWhatIf(this.whatIfDeps(job), project, shot, payload, ctx);
        await this.recutSoon(project.id);
        if (payload.autoDraft) {
          const current = this.d.store.require(project.id);
          this.whatIfChild(job, payload, ctx, "_whatIfDraftJobId", "video_what_if", { kind: "draft", seed: randomSeed(), ...whatIfDraftSnapshot(current, this.shot(current, shot.id)) }, shot.id);
        }
        return result;
      } finally { await this.cleanup(job); }
    }
    if (project.template === "vfx_effect") {
      const photo = effectPhoto(project);
      await this.d.store.mutate(project.id, (p) => {
        const current = p.shots.find((s) => s.id === shot.id);
        if (current) current.stillAssetId = photo.id;
      });
      await this.recutSoon(project.id);
      return { outputAssetIds: [photo.id], message: "Original photo ready" };
    }
    const size = await this.sizeFor("still", project);
    const refs = referencesForShot(project, shot);
    requireReferenceSupport(this.currentRecipe()!, refs);
    const prompt = [referencePrompt(refs), stylePrompt(project.template, str(payload.prompt) ?? shot.prompt)].filter(Boolean).join(" ");
    const values: Record<string, unknown> = { prompt, seed: num(payload.seed, 0), ...size };
    refs.forEach((ref, i) => {
      const path = this.assetFile(project, ref.assetId);
      if (!path) throw new Error(`Reference ${ref.label} is missing its image`);
      values[i ? `image${i + 1}` : "image"] = path;
    });
    try {
      const { outputs, peakGb } = await this.runStep(job, payload, "still", values, { aspect: project.aspect, ...size, label: `Shot ${shot.index + 1}` }, ctx);
      const image = outputs.find((o) => o.kind === "image");
      if (!image) throw new Error("The still step produced no image");
      const asset = await this.d.store.importFile(project.id, image.path, "image", { move: true });
      await this.d.store.mutate(project.id, (p) => {
        p.assets.push(asset);
        const s = p.shots.find((x) => x.id === shot.id);
        if (s) s.stillAssetId = asset.id;
      });
      await this.recutSoon(project.id);
      return withPeak({ outputAssetIds: [asset.id], message: "Still ready" }, peakGb);
    } finally {
      await this.cleanup(job);
    }
  }

  private async runDraft(job: Job, payload: JobPayload, ctx: ExecContext): Promise<ExecResult> {
    const project = this.d.store.require(job.projectId);
    const shot = this.shot(project, job.shotId!);
    const camera = project.template === "camera_move";
    const step = camera ? "video_camera_move" : "video_draft";
    const ref = this.currentRecipe()?.steps[step];
    const size = await this.sizeFor(step, project);
    const fps = num(ref?.params.fps, 24);
    const prompt = camera ? str(payload.cameraPrompt) ?? cameraPrompt(shot.prompt, cameraMove(shot.cameraMove)) : stylePrompt(project.template, shot.prompt, shot.cameraMove);
    const { frames, clampedSec } = await this.frames(ref, shot.durationSec, fps);
    const durationSec = clampedSec ?? shot.durationSec;
    const values: Record<string, unknown> = { prompt, seed: num(payload.seed, 0), ...size, fps, frames, durationSec };
    const imageAssetId = camera ? cameraSource(project, payload.cameraPhotoId).id : shot.stillAssetId;
    const still = this.assetFile(project, imageAssetId);
    if (still) values.image = still;
    // The negative prompt the workflow will use, so the finals can be given exactly the same.
    const negative = await this.stepDefault(ref, "negative");
    try {
      const hints = { aspect: project.aspect, ...size, durationSec, ...(shot.cameraMove ? { cameraMove: shot.cameraMove } : {}) };
      if (camera) {
        values.move = cameraMove(payload.cameraMove ?? shot.cameraMove);
        values.layout = await cameraLayout({ project, shot, payload, ctx, store: this.d.store, values,
          run: (v) => this.runStep(job, payload, "camera_layout", v, hints, ctx, [0, 0.3]) });
      }
      const { outputs, peakGb } = await this.runStep(job, payload, step, values, hints, ctx, camera ? [0.3, 1] : [0, 1]);
      const video = outputs.find((o) => o.kind === "video");
      if (!video) throw new Error("The draft step produced no video");
      const latent = outputs.find((o) => o.kind === "latent");
      const videoAsset = await this.d.store.importFile(project.id, video.path, "video", { move: true });
      const latentAsset = latent ? await this.d.store.importFile(project.id, latent.path, "latent", { move: true }) : undefined;
      const take: Take = { id: str(payload.takeId) ?? newId("take"), shotId: shot.id, rung: "draft", seed: num(payload.seed, 0), videoAssetId: videoAsset.id, jobId: job.id, prompt };
      if (latentAsset) take.latentAssetId = latentAsset.id;
      if (typeof negative === "string") take.negative = negative;
      if (still && imageAssetId) take.imageAssetId = imageAssetId;
      await this.d.store.mutate(project.id, (p) => {
        p.assets.push(videoAsset, ...(latentAsset ? [latentAsset] : []));
        p.takes = [...p.takes.filter((t) => t.id !== take.id), take];
        // The first draft of a shot is picked for it, so the fast path needs no clicks.
        const s = p.shots.find((x) => x.id === shot.id);
        if (s && !s.chosenDraftId) s.chosenDraftId = take.id;
        clampShot(s, clampedSec);
      });
      await this.recutSoon(project.id);
      return withPeak({ outputAssetIds: [videoAsset.id, ...(latentAsset ? [latentAsset.id] : [])], message: `Draft ready${clampNote(shot.durationSec, clampedSec)}` }, peakGb);
    } finally {
      await this.cleanup(job);
    }
  }

  /**
   * A final continues its draft. A same-take final gets exactly what the draft was made from (prompt, negative prompt,
   * still, seed) plus its latent and video, or refuses to run (see `sameTakeInputs`), so it cannot drift from the
   * approved take even if the shot was edited or given a new still since. A remaster re-renders with the draft as its
   * reference video; for drafts from before the engine recorded these it takes the shot's current prompt and still.
   */
  private async runFinal(job: Job, payload: JobPayload, ctx: ExecContext): Promise<ExecResult> {
    const project = this.d.store.require(job.projectId);
    const shot = this.shot(project, job.shotId!);
    const step = job.step as StepId;
    const { ref } = this.requireStep(step);
    const draft = project.takes.find((t) => t.id === str(payload.draftId));
    if (!draft) throw new Error("The draft this final continues was deleted");
    const remaster = step === "video_final_remaster";
    let values: Record<string, unknown>;
    let imageAssetId: string | undefined;
    if (remaster) {
      const draftVideo = this.assetFile(project, draft.videoAssetId);
      if (!draftVideo || !(await exists(draftVideo))) throw new Error("The draft's video is missing from the project folder");
      const prefix = typeof ref.params.promptPrefix === "string" ? ref.params.promptPrefix : REMASTER_REFERENCE;
      const draftPrompt = draft.prompt ?? stylePrompt(project.template, shot.prompt, shot.cameraMove);
      values = { prompt: [prefix.trim(), draftPrompt].filter(Boolean).join(" "), seed: draft.seed, video: draftVideo };
      if (draft.negative !== undefined) values.negative = draft.negative;
      const latent = this.assetFile(project, draft.latentAssetId);
      if (latent) values.latent = latent;
      imageAssetId = draft.imageAssetId ?? shot.stillAssetId;
      const image = this.assetFile(project, imageAssetId);
      if (image) values.image = image;
      else imageAssetId = undefined;
    } else {
      ({ values, imageAssetId } = await this.sameTakeInputs(project, draft, ref));
    }
    const fps = num(ref.params.fps, 24);
    // A workflow that takes a frame count makes the shot's length, up to its model's longest clip. A same-take
    // workflow continues the draft's latent, which has the draft's length already.
    const { frames, clampedSec } = ref.inputs.frames ? await this.frames(ref, shot.durationSec, fps) : { frames: frameCount(shot.durationSec, fps), clampedSec: undefined };
    const durationSec = clampedSec ?? shot.durationSec;
    Object.assign(values, { fps, frames, durationSec });
    // A same-take workflow takes its size from the draft's latent; a remaster renders at its own size.
    let size: Size;
    if (ref.inputs.width && ref.inputs.height) {
      size = await this.sizeFor(step, project);
      Object.assign(values, size);
    } else {
      const video = this.d.store.findAsset(project, draft.videoAssetId);
      size = video?.width && video.height ? { width: video.width * 2, height: video.height * 2 } : await this.sizeFor(step, project);
    }
    try {
      const { outputs, peakGb } = await this.runStep(job, payload, step, values, { aspect: project.aspect, ...size, durationSec }, ctx);
      const video = outputs.find((o) => o.kind === "video");
      if (!video) throw new Error("The final step produced no video");
      const asset = await this.d.store.importFile(project.id, video.path, "video", { move: true });
      const take: Take = {
        id: str(payload.takeId) ?? newId("take"),
        shotId: shot.id,
        rung: "final",
        finalKind: remaster ? "remaster" : "same_take",
        parentTakeId: draft.id,
        seed: draft.seed,
        videoAssetId: asset.id,
        jobId: job.id,
      };
      if (typeof values.prompt === "string") take.prompt = values.prompt;
      if (draft.negative !== undefined) take.negative = draft.negative;
      if (imageAssetId) take.imageAssetId = imageAssetId;
      if (draft.guideAssetIds) take.guideAssetIds = [...draft.guideAssetIds];
      await this.d.store.mutate(project.id, (p) => {
        p.assets.push(asset);
        p.takes = [...p.takes.filter((t) => t.id !== take.id), take];
        const s = p.shots.find((x) => x.id === shot.id);
        // This is now the draft's newest final (`finalFor`), so it takes over the shot. Finishing an older take must not
        // replace a newer choice made while it was queued; picking that take again brings this final back.
        if (s?.chosenDraftId === draft.id) s.chosenFinalId = take.id;
        clampShot(s, clampedSec);
      });
      await this.recutSoon(project.id);
      return withPeak({ outputAssetIds: [asset.id], message: `${remaster ? "Remaster" : "Same-take final"} ready${clampNote(shot.durationSec, clampedSec)}` }, peakGb);
    } finally {
      await this.cleanup(job);
    }
  }

  /**
   * A song or a voiceover from the GPU. Its words become the asset's `text` (TTS input, lyrics). The track goes on an
   * unedited timeline at once, and an analysis job (on the CPU worker) measures it and fits the cut to it, so the GPU
   * is free for the next job meanwhile.
   */
  private async runAudio(job: Job, payload: JobPayload, ctx: ExecContext): Promise<ExecResult> {
    const project = this.d.store.require(job.projectId);
    const role = job.step as "music" | "voice";
    const values: Record<string, unknown> = { seed: num(payload.seed, 0) };
    let words: string | undefined;
    if (role === "music") {
      values.prompt = str(payload.prompt) ?? str(payload.lyrics) ?? "";
      words = str(payload.lyrics);
      if (words) values.lyrics = words;
      values.durationSec = num(payload.durationSec, 30);
    } else {
      words = str(payload.text) ?? "";
      values.text = words;
      if (str(payload.voice)) values.voice = payload.voice;
      const instruction = str(payload.prompt) ?? VOICE_INSTRUCTIONS[str(payload.voice) ?? ""];
      if (instruction) values.prompt = instruction;
      const voiceRef = this.assetFile(project, str(payload.voiceRefAssetId));
      if (voiceRef) values.voiceRef = voiceRef;
    }
    try {
      const { outputs, peakGb } = await this.runStep(job, payload, role, values, { aspect: project.aspect, width: 0, height: 0 }, ctx);
      const audio = outputs.find((o) => o.kind === "audio");
      if (!audio) throw new Error(`The ${role} step produced no audio`);
      const audioPath = project.template === "what_if" && role === "voice" ? await fitWhatIfVoice(audio.path, ctx.signal) : audio.path;
      const asset = await this.d.store.importFile(project.id, audioPath, "audio", { move: true, role });
      if (words) asset.text = words;
      await this.d.store.mutate(project.id, (p) => void p.assets.push(asset));
      await this.recutSoon(project.id);
      this.analyze(project.id, asset, role);
      return withPeak({ outputAssetIds: [asset.id], message: role === "music" ? "Song ready" : "Voiceover ready" }, peakGb);
    } finally {
      await this.cleanup(job);
    }
  }

  /**
   * An analysis job: measure a song (its beats, its sung words) or a voiceover (its words' times) and fit the cut to
   * it. An unedited timeline is cut again around it; an edited one gets it in place of the old track of its role, with
   * new captions when its words are the captions. A track a newer one of its role replaced is left alone.
   */
  private async runAnalysis(job: Job, payload: JobPayload, ctx: ExecContext): Promise<ExecResult> {
    const project = this.d.store.require(job.projectId);
    const role = job.step === "voice" ? "voice" : "music";
    const noun = role === "music" ? "song" : "voiceover";
    const asset = project.assets.find((a) => a.id === str(payload.assetId) && a.kind === "audio");
    if (!asset) return { outputAssetIds: [], message: `The ${noun} is gone` };
    if (project.assets.some((a) => a.kind === "audio" && a.role === role && a.createdAt > asset.createdAt)) {
      return { outputAssetIds: [], message: `A newer ${noun} took its place` };
    }
    ctx.progress(0.02, role === "music" ? "Finding the beat" : "Timing the words");
    if (project.timeline?.edited) {
      await this.placeOnEdited(project, asset, role, ctx.signal);
      return { outputAssetIds: [], message: `The ${noun} is on the edited cut` };
    }
    const { cut } = await this.measuredCut(project.id, { signal: ctx.signal, onProgress: (f, m) => ctx.progress(0.02 + 0.96 * f, m) });
    const beats = cut.timeline.markers?.filter((m) => m.kind === "beat").length ?? 0;
    const found = [
      role === "music" && project.template === "music_video" ? (beats ? `${beats} beats` : "no steady beat") : undefined,
      cut.captionMethod === "aligned" || cut.captionMethod === "transcribed" ? "words timed" : cut.captionMethod === "estimated" ? "words timed from the text" : undefined,
    ].filter(Boolean);
    return { outputAssetIds: [], message: `${role === "music" ? "Song" : "Voiceover"} measured${found.length ? `: ${found.join(", ")}` : ""}` };
  }

  /**
   * The finished video: the timeline cut afresh with full analysis (unless it was edited by hand and no rebuild was
   * asked for), rendered by the editor with the template's cards and captions, filed as an `export` asset.
   */
  private async runExport(job: Job, payload: JobPayload, ctx: ExecContext): Promise<ExecResult> {
    let project = this.d.store.require(job.projectId);
    const aspect = payload.aspect === "9:16" || payload.aspect === "1:1" ? payload.aspect : "16:9";
    const quality = payload.quality === "preview" || payload.quality === "high" ? payload.quality : "standard";
    const workDir = join(this.d.paths.work, job.id);
    await rm(workDir, { recursive: true, force: true });
    await mkdir(workDir, { recursive: true });
    try {
      if (payload.kind === "reveal") {
        const shotId = typeof payload.shotId === "string" ? payload.shotId : job.shotId;
        ctx.progress(0.01, "Preparing the reveal");
        const out = join(workDir, `reveal-${aspect.replace(":", "x")}.mp4`);
        const result = await this.d.editor.renderReveal(project, { aspect, quality, outPath: out, workDir: join(workDir, "render"), signal: ctx.signal, onProgress: (f, m) => ctx.progress(0.01 + 0.98 * f, m), ...(shotId ? { shotId } : {}) });
        for (const w of result.warnings) this.d.log(`reveal ${job.id}: ${w}`);
        const asset = await this.d.store.importFile(project.id, out, "video", { move: true, role: "reveal" });
        await this.d.store.mutate(project.id, (p) => void p.assets.push(asset));
        const { size } = await stat(this.d.store.assetPath(project, asset));
        const kind = result.kind === "same_take" ? `same take, frame ${result.freezeFrame} of ${result.frames}` : "remaster";
        return { outputAssetIds: [asset.id], message: `Reveal ${result.width}x${result.height}, ${result.durationSec.toFixed(1)} s, ${megabytes(size)}, ${kind}` };
      }
      let timeline = project.timeline;
      let captionMethod: string | null = null;
      if (!timeline?.edited || payload.rebuild === true) {
        ctx.progress(0.01, "Cutting the timeline");
        const measured = await this.measuredCut(project.id, { signal: ctx.signal, rebuild: payload.rebuild === true, onProgress: (f, m) => ctx.progress(0.01 + 0.14 * f, m) });
        ({ project } = measured);
        timeline = measured.cut.timeline;
        captionMethod = measured.cut.captionMethod;
        for (const w of measured.cut.warnings) this.d.log(`export ${job.id}: ${w}`);
      }
      if (!timeline || timeline.clips.length === 0) throw new Error("Nothing to export yet: make a still or a draft for at least one shot.");
      const out = join(workDir, `export-${aspect.replace(":", "x")}.mp4`);
      const result = await this.d.editor.render(project, timeline, { aspect, quality, outPath: out, workDir: join(workDir, "render"), signal: ctx.signal, onProgress: (f, m) => ctx.progress(0.15 + 0.83 * f, m) });
      for (const w of result.warnings) this.d.log(`export ${job.id}: ${w}`);
      const asset = await this.d.store.importFile(project.id, out, "video", { move: true, role: "export" });
      await this.d.store.mutate(project.id, (p) => void p.assets.push(asset));
      const { size } = await stat(this.d.store.assetPath(project, asset));
      const captions =
        timeline.captions.length === 0
          ? "no captions"
          : captionMethod === "estimated"
            ? `captions timed from the text (${(await this.d.editor.canRecognize()) ? "no words were heard in the audio" : "speech recognition is not installed"})`
            : captionMethod === "aligned" || captionMethod === "transcribed"
              ? "captions timed to the words"
              : "captions";
      return { outputAssetIds: [asset.id], message: `Exported ${result.width}x${result.height}, ${result.durationSec.toFixed(1)} s, ${megabytes(size)}, ${captions}` };
    } finally {
      await this.cleanup(job);
    }
  }
}

/** What a cut is made of. A cut measured from a project whose parts changed meanwhile is out of date. */
function cutInputs(p: Project): string {
  return stableJson([p.template, p.aspect, p.brief, p.shots, p.takes, p.assets, p.timeline?.style ?? null, p.timeline?.edited ?? false]);
}

/** Captions moved along the timeline by `by` seconds. */
function shiftCaptions(captions: Timeline["captions"], by: number): Timeline["captions"] {
  if (Math.abs(by) < 1e-6) return captions;
  const move = (t: number) => Math.round((t + by) * 1000) / 1000;
  return captions.map((c) => ({ ...c, start: move(c.start), end: move(c.end), ...(c.words ? { words: c.words.map((w) => ({ ...w, start: move(w.start), end: move(w.end) })) } : {}) }));
}

/** A shot longer than the clip its model could make takes the clip's length, unless it was shortened meanwhile. */
function clampShot(shot: Shot | undefined, clampedSec: number | undefined): void {
  if (shot && clampedSec !== undefined && shot.durationSec > clampedSec) shot.durationSec = clampedSec;
}

/** What a job's message adds when its shot was clamped, in plain words. */
function clampNote(wasSec: number, clampedSec: number | undefined): string {
  if (clampedSec === undefined) return "";
  return `. This model makes clips of at most ${secs(clampedSec)} s, so the shot is ${secs(clampedSec)} s now (it was ${secs(wasSec)} s).`;
}

/** A file size as people read it: "4.2 MB" (decimal megabytes, as file browsers show them). */
export function megabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

function withPeak(result: ExecResult, peakGb: number | undefined): ExecResult {
  return peakGb === undefined ? result : { ...result, peakGb };
}

/** Locked shots keep their place; the new plan fills the other slots in order, then continues after them. */
export function mergeShots(current: Shot[], plans: ShotPlan[]): Shot[] {
  const ordered = [...current].sort((a, b) => a.index - b.index);
  const out: Shot[] = [];
  let next = 0;
  const fresh = (plan: ShotPlan): Shot => {
    const shot: Shot = { id: newId("shot"), index: 0, prompt: plan.prompt, durationSec: plan.durationSec, locked: false };
    if (plan.cameraMove) shot.cameraMove = plan.cameraMove;
    if (plan.line) shot.line = plan.line;
    return shot;
  };
  for (const shot of ordered) {
    if (shot.locked) out.push(shot);
    else if (next < plans.length) out.push(fresh(plans[next++]!));
  }
  while (next < plans.length) out.push(fresh(plans[next++]!));
  return out.map((s, i) => ({ ...s, index: i }));
}
