/** Four linked visual states, one continuous film, one saved audio-video latent. */
import {
  KeyframeSchema, fallbackWhatIf, hasWhatIfPreset, ownShot, whatIfLook, whatIfLooks, WHAT_IF_DURATION,
  WHAT_IF_FPS, WHAT_IF_FRAMES, type Asset, type Job, type Keyframe, type Project,
  type Shot, type StepId, type Take,
} from "@nightshift/contract";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { sizeForAspect } from "../comfy/bind.js";
import { badRequest, conflict } from "../errors.js";
import { findFfmpeg, probeMedia } from "../media/ffmpeg.js";
import type { ExecContext, ExecResult } from "../queue/queue.js";
import type { JobPayload } from "../queue/store.js";
import type { StepOutput, StepRequest } from "../runner/types.js";
import { errorMessage, exists, newId, runStreaming } from "../util.js";
import { setOwnShot } from "./own-shot.js";
import type { ProjectStore } from "./store.js";
import { pickDraft } from "./versions.js";

type Plan = ReturnType<typeof fallbackWhatIf>;
interface Deps {
  store: ProjectStore;
  /** A line for the engine's log. */
  log?: (line: string) => void;
  run(step: StepId, values: Record<string, unknown>, hints: StepRequest["hints"], payload: JobPayload, ctx: ExecContext, span: [number, number]): Promise<{ outputs: StepOutput[]; peakGb?: number }>;
}

export function validateWhatIfBrief(brief: Project["brief"]): void {
  if (typeof brief.question !== "string" || brief.question.trim().length < 8 || brief.question.length > 300) {
    throw badRequest("Write a question between 8 and 300 characters.");
  }
  if (brief.look !== undefined && !whatIfLooks.some((look) => look.id === brief.look)) throw badRequest("Choose Cinematic or Miniature world.");
}

/** The film is the one shot with keyframes (`ownShot`). The project's other shots are extra cards made with the tools. */
export function validateWhatIfProject(project: Project): void {
  if (project.template !== "what_if") return;
  validateWhatIfBrief(project.brief);
  const films = project.shots.filter((shot) => shot.keyframes);
  if (films.length > 1) throw badRequest("A What-if project is one continuous film.");
  for (const shot of films) {
    if (shot.keyframes?.length !== 4) throw badRequest("A What-if film needs four keyframes.");
    if (new Set(shot.keyframes.map((frame) => frame.id)).size !== 4) throw badRequest("Keyframe IDs must be unique.");
    for (const frame of shot.keyframes) {
      if (frame.stillAssetId && !project.assets.some((asset) => asset.id === frame.stillAssetId && asset.kind === "image")) {
        throw badRequest("A keyframe refers to an image outside this project.");
      }
    }
  }
  if (project.brief.photoAssetId !== undefined && !project.assets.some((asset) => asset.id === project.brief.photoAssetId && asset.kind === "image")) {
    throw badRequest("The opening photo is missing from this project.");
  }
}

/** What a story's narration may total, in words: the writer is asked for 35 to 50, and the voice fits up to 55. */
const WORDS = { ask: [35, 50], take: [30, 55] } as const;

const Answer = z.object({
  prompt: z.string().trim().min(20).max(3000),
  cameraMove: z.unknown().optional(),
  keyframes: z.array(z.preprocess(
    // "narration" for "line" is the same answer.
    (frame) => (frame && typeof frame === "object" && !("line" in frame) && "narration" in frame ? { ...frame, line: (frame as { narration: unknown }).narration } : frame),
    z.object({ prompt: z.string().trim().min(12).max(3000), line: z.string().trim().min(1).max(400) }),
  )).length(4),
});

/** The placeholder values in the writer's JSON format. A small model sometimes copies them back as its answer. */
const FORMAT = { prompt: "the continuous action across the whole film", frame: "a complete visual state", line: "spoken narration" };
const echoesFormat = (text: string) => Object.values(FORMAT).some((placeholder) => text.toLowerCase().includes(placeholder));

/**
 * The writer's answer as a story, or what it broke, in words the writer is told when it is asked again. `starter`: the
 * outline it was given; an answer that only repeats a generic outline (no tested story fits the question) is filler.
 */
export function readWhatIf(raw: string, starter?: { plan: Plan; generic: boolean }): { plan: Plan } | { misfit: string } {
  let value: unknown;
  try { value = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); } catch {
    return { misfit: "Your last answer was not one JSON object. Answer with the JSON object only, in the shape asked for, with no markdown." };
  }
  const answer = Answer.safeParse(value);
  if (!answer.success) {
    const frames = value && typeof value === "object" && Array.isArray((value as { keyframes?: unknown }).keyframes) ? (value as { keyframes: unknown[] }).keyframes.length : undefined;
    if (frames !== undefined && frames !== 4) return { misfit: `Your last answer had ${frames} keyframes. Write exactly four: ordinary, first change, escalation, consequence.` };
    const where = [...new Set(answer.error.issues.map((issue) => issue.path.filter((part) => typeof part === "string").join(".") || "the answer"))].slice(0, 4).join(", ");
    return { misfit: `Your last answer did not have the shape asked for (${where}). Give a prompt of at least a sentence, and four keyframes, each with a prompt and a line.` };
  }
  if (echoesFormat(answer.data.prompt) || answer.data.keyframes.some((frame) => echoesFormat(frame.prompt) || echoesFormat(frame.line))) {
    return { misfit: "Your last answer copied the placeholder words of the format. Write the story itself: what we see in each state, and what the narrator says." };
  }
  const line = answer.data.keyframes.map((frame) => frame.line).join(" ");
  const words = line.split(/\s+/).length;
  if (words < WORDS.take[0] || words > WORDS.take[1]) {
    return { misfit: `Your last four narration lines total ${words} words. Make them total ${WORDS.ask[0]} to ${WORDS.ask[1]} words.` };
  }
  // A small writer sometimes copies the format's "static or dolly_in", or writes "dolly in": only a dolly alone moves.
  const move = answer.data.cameraMove;
  const cameraMove = typeof move === "string" && /dolly/i.test(move) && !/static/i.test(move) ? "dolly_in" : "static";
  const plan = { ...answer.data, cameraMove, keyframes: answer.data.keyframes.map((frame, index) => ({ ...frame, id: `beat-${index}` })), line, durationSec: WHAT_IF_DURATION };
  if (starter?.generic && sameStory(plan, starter.plan)) {
    return { misfit: "Your last answer repeated the outline word for word. Write this question's own story: four states of one place, and narration about them." };
  }
  return { plan };
}

/** The writer's answer as a story, or undefined when it is not one. */
export function parseWhatIf(raw: string): Plan | undefined {
  const read = readWhatIf(raw);
  return "plan" in read ? read.plan : undefined;
}

function sameStory(a: Plan, b: Plan): boolean {
  const text = (plan: Plan) => [plan.prompt, ...plan.keyframes.flatMap((frame) => [frame.prompt, frame.line])].join("\n");
  return text(a) === text(b);
}

/** Each stage has its own durable Comfy job ID, including each image in the chain. */
async function stage(deps: Deps, key: string, step: StepId, values: Record<string, unknown>, hints: StepRequest["hints"], payload: JobPayload, ctx: ExecContext, span: [number, number]) {
  const frame = /Frame(\d)/.exec(key);
  const message = step === "text" ? "Writing your story" : frame ? `Drawing beat ${Number(frame[1]) + 1} of 4` : "Rendering your film";
  return deps.run(step, values, hints, { ...payload, _comfyJobId: payload[key] }, {
    ...ctx, progress: progress => ctx.progress(progress, message),
    remember: (name, value) => ctx.remember(name === "_comfyJobId" ? key : name, value),
  }, span);
}

/**
 * How many times the writer is asked for a story. A small writer answers the same input the same way, so each new ask
 * also says what the last answer broke (`readWhatIf`), as a film's shot list does.
 */
export const WHAT_IF_TRIES = 3;

/**
 * The story a storyboard job wrote, and whether the film is drawn from it. `ready` is false when the writer's story did
 * not come: the project's `shotList` says why, and nothing is drawn, voiced or rendered until the user asks.
 */
export interface WhatIfStory { result: ExecResult; ready: boolean }

/**
 * Write the film's story from the question. A new story replaces the film's beats and narration, on the same shot, so
 * every take and final of the film stays (its pick too, until a new take lands). A writer whose story does not fit after
 * `WHAT_IF_TRIES` asks leaves the film as it was, or a new film with the starter beats, and a note (`Project.shotList`).
 * `keepStory`: the film's beats as they are now are used, with no writer.
 */
export async function writeWhatIf(deps: Deps, project: Project, payload: JobPayload, ctx: ExecContext, canWrite: boolean): Promise<WhatIfStory> {
  validateWhatIfBrief(project.brief);
  if (typeof payload._whatIfPreparedShotId === "string" && project.shots.some((shot) => shot.id === payload._whatIfPreparedShotId)) {
    const ready = payload._whatIfStory !== "note";
    return { result: { outputAssetIds: [], message: ready ? "Story ready" : "The story was not written." }, ready };
  }
  const film = ownShot(project);
  if (payload.keepStory === true && film?.keyframes) {
    await deps.store.mutate(project.id, (p) => void (p.shotList = { by: p.shotList?.by ?? "writer" }));
    ctx.remember("_whatIfShotId", film.id);
    ctx.remember("_whatIfPreparedShotId", film.id);
    return { result: { outputAssetIds: [], message: "Story ready. Drawing your beats." }, ready: true };
  }
  const starter = fallbackWhatIf(project.brief);
  let plan = starter;
  let message = "Story ready. Using the starter story.";
  let peakGb: number | undefined;
  /** Why the writer's story was not used. */
  let note: string | undefined;
  if (canWrite) {
    const system = `Write a fictional 15-second What-if film as ONE uninterrupted shot. Return JSON only: {"prompt":"${FORMAT.prompt}","cameraMove":"static or dolly_in","keyframes":[{"prompt":"${FORMAT.frame}","line":"${FORMAT.line}"}]}. Exactly four keyframes: ordinary, first change, escalation, consequence. Keep the same place, objects, lighting and visual style. No cuts, montage, fades, text in images, close-up faces, crowds, precise hand actions or brands. Describe four clearly DIFFERENT states, not four camera angles. The first is ordinary, before the change. Prefer a fixed camera; dolly_in is only for a continuous first-person journey. The four narration lines TOTAL ${WORDS.ask[0]} to ${WORDS.ask[1]} words. Tell an imagined premise plainly; do not assert scientific facts, numbers, causes or predictions as truth. The last line has a consequence. Each image prompt must name the same setting and objects, and describe what has changed. ${whatIfLook(project.brief)}`;
    const prompt = `Question: ${project.brief.question}\n${project.brief.photoAssetId ? "The user's photo is the opening frame. Describe changes to that scene without inventing a new place." : "Choose a simple, striking place and a few objects."}\nUse this visual outline when it fits the question. Keep the narration about the same objects and changes:\n${JSON.stringify(starter)}`;
    const outline = { plan: starter, generic: !hasWhatIfPreset(project.brief) };
    let again = "";
    let written: Plan | undefined;
    try {
      for (let attempt = 0; attempt < WHAT_IF_TRIES && !written; attempt++) {
        const result = await stage(deps, attempt ? `_whatIfWriterJobId${attempt}` : "_whatIfWriterJobId", "text", {
          system: [system, again].filter(Boolean).join(" "), prompt, text: prompt, maxTokens: 1024, seed: Number(payload.seed ?? 0) + attempt, fallback: JSON.stringify(starter),
        }, { aspect: project.aspect, width: 0, height: 0 }, payload, ctx, [attempt / WHAT_IF_TRIES, (attempt + 1) / WHAT_IF_TRIES]);
        if (result.peakGb !== undefined) peakGb = Math.max(peakGb ?? 0, result.peakGb);
        const output = result.outputs.find((item) => item.kind === "text");
        const raw = output ? await readFile(output.path, "utf8") : "";
        const read = readWhatIf(raw, outline);
        if ("plan" in read) written = read.plan;
        else {
          // What it wrote, so a writer that keeps missing can be seen and its instructions fixed.
          deps.log?.(`project ${project.id}: the What if? writer's story (try ${attempt + 1} of ${WHAT_IF_TRIES}) did not fit: ${read.misfit} It wrote: ${raw.replace(/\s+/g, " ").slice(0, 6000)}`);
          again = read.misfit;
        }
      }
      if (written) {
        plan = written;
        // An answer that only repeats a tested outline is still the starter story; say so.
        message = sameStory(written, starter) ? message : "Story ready";
      } else note = `The writer tried ${WHAT_IF_TRIES} times, but its story did not fit.`;
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      deps.log?.(`project ${project.id}: the What if? writer failed: ${errorMessage(error)}`);
      note = `The writer could not finish: ${errorMessage(error).replace(/\.?$/, ".")}`;
    }
  }
  if (note && film?.keyframes) {
    // The film keeps its story, its keyframes and its takes. The note says why on the board, with a way to try again.
    await deps.store.mutate(project.id, (p) => void (p.shotList = { by: p.shotList?.by ?? "writer", note: note! }));
    ctx.remember("_whatIfStory", "note");
    ctx.remember("_whatIfShotId", film.id);
    ctx.remember("_whatIfPreparedShotId", film.id);
    return { result: { outputAssetIds: [], message: `${note} The story stays as it was.`, ...(peakGb === undefined ? {} : { peakGb }) }, ready: false };
  }
  const id = film?.id ?? (typeof payload._whatIfShotId === "string" ? payload._whatIfShotId : newId("sht"));
  ctx.remember("_whatIfShotId", id);
  await deps.store.mutate(project.id, (p) => {
    const old = ownShot(p);
    // A new story is written on the film's own shot: its takes, its finals and its pick stay. The beats are new, so
    // they have no keyframes yet; extra cards made with the tools stay as they are.
    if (old) setOwnShot(p, { ...old, prompt: plan.prompt, cameraMove: plan.cameraMove, durationSec: plan.durationSec, line: plan.line, keyframes: plan.keyframes });
    else setOwnShot(p, { ...plan, id, index: 0, locked: false });
    p.shotList = note ? { by: "template", note } : { by: canWrite ? "writer" : "template" };
  });
  if (note) ctx.remember("_whatIfStory", "note");
  ctx.remember("_whatIfPreparedShotId", id);
  const result = { outputAssetIds: [], message: note ? `${note} Nothing was drawn. Try again, or use the starter beats.` : message, ...(peakGb === undefined ? {} : { peakGb }) };
  return { result, ready: !note };
}

function imageAsset(project: Project, id: unknown): Asset {
  const asset = project.assets.find((item) => item.id === id && item.kind === "image");
  if (!asset) throw conflict("A keyframe image is missing. Redraw the storyboard before making this film.");
  return asset;
}

function styled(prompt: string, project: Project): string {
  // A starter miniature scene also works in the photographic look.
  const body = project.brief.look === "miniature" ? prompt : prompt
    .replace(/photographic handmade miniature diorama/gi, "cinematic photograph")
    .replace(/tilt-shift macro photography/gi, "cinematic photography")
    .replace(/scale-model materials|finely crafted scale model/gi, "natural materials")
    .replace(/miniature/gi, "small");
  return `${body} ${whatIfLook(project.brief)}`;
}

export async function drawWhatIf(deps: Deps, project: Project, shot: Shot, payload: JobPayload, ctx: ExecContext): Promise<ExecResult> {
  const frames = z.array(KeyframeSchema).length(4).parse(payload.whatIfFrames ?? shot.keyframes);
  const start = typeof payload.keyframeIndex === "number" ? payload.keyframeIndex : 0;
  const size = sizeForAspect(1280, 768, project.aspect);
  const moving = (payload.whatIfCameraMove ?? shot.cameraMove) === "dolly_in";
  const photoId = payload.whatIfPhotoId;
  let current = deps.store.require(project.id);
  let previous = start ? imageAsset(current, frames[start - 1]!.stillAssetId) : undefined;
  let anchor = start ? imageAsset(current, frames[0]!.stillAssetId) : undefined;
  const outputs: string[] = [];
  let peakGb: number | undefined;
  for (let index = start; index < frames.length; index++) {
    ctx.signal.throwIfAborted();
    const frame = frames[index]!;
    current = deps.store.require(project.id);
    if (!current.shots.some((item) => item.id === shot.id)) throw conflict("The story changed while these keyframes were being drawn.");
    const savedId = payload[`_whatIfFrame${index}AssetId`];
    let asset = typeof savedId === "string" ? current.assets.find((item) => item.id === savedId && item.kind === "image") : undefined;
    if (asset && !await exists(deps.store.assetPath(current, asset))) asset = undefined;
    if (!asset && index === 0 && photoId) asset = imageAsset(current, photoId);
    if (!asset) {
      const prefix = !previous ? "" : moving
        ? "Continue a single forward camera journey from the supplied image. Keep the same visual world, lighting and materials while moving the viewpoint. "
        : "Image 1 is the current state. Image 2 is the original scene, supplied only to preserve the exact camera, objects and setting. Keep the exact camera position, framing, place, lighting, materials and all unchanged objects. ";
      const values: Record<string, unknown> = { prompt: styled(prefix + frame.prompt, project), seed: Number(payload.seed ?? 0) + index, ...size };
      if (previous) values.image = deps.store.assetPath(current, previous);
      if (previous && anchor && !moving) values.image2 = deps.store.assetPath(current, anchor);
      const result = await stage(deps, `_whatIfFrame${index}JobId`, "still", values,
        { aspect: project.aspect, ...size, label: `Beat ${index + 1}` }, payload, ctx,
        [(index - start) / (4 - start), (index - start + 1) / (4 - start)]);
      if (result.peakGb !== undefined) peakGb = Math.max(peakGb ?? 0, result.peakGb);
      const output = result.outputs.find((item) => item.kind === "image");
      if (!output) throw new Error(`Beat ${index + 1} produced no image.`);
      asset = await deps.store.importFile(project.id, output.path, "image", { move: true });
      await deps.store.mutate(project.id, (p) => { p.assets.push(asset!); });
    }
    const ready = asset;
    await deps.store.mutate(project.id, (p) => {
      const target = p.shots.find((item) => item.id === shot.id);
      const beat = target?.keyframes?.find((item) => item.id === frame.id);
      if (beat) beat.stillAssetId = ready.id;
      if (target && index === 0) target.stillAssetId = ready.id;
    });
    ctx.remember(`_whatIfFrame${index}AssetId`, ready.id);
    outputs.push(ready.id);
    previous = ready;
    if (index === 0) anchor = ready;
    ctx.progress((index - start + 1) / (4 - start), `Beat ${index + 1} ready`);
  }
  return { outputAssetIds: outputs, message: "Keyframes ready", ...(peakGb === undefined ? {} : { peakGb }) };
}

export function whatIfDraftSnapshot(project: Project, shot: Shot): JobPayload {
  if (shot.keyframes?.length !== 4) throw conflict("Write the four beats first.");
  const ids = shot.keyframes.map((frame) => imageAsset(project, frame.stillAssetId).id);
  return { whatIfGuideIds: ids, whatIfPrompt: shot.prompt, whatIfCameraMove: shot.cameraMove,
    whatIfLook: whatIfLook(project.brief), whatIfAspect: project.aspect };
}

export async function renderWhatIf(deps: Deps, project: Project, shot: Shot, job: Job, payload: JobPayload, ctx: ExecContext, negative: unknown): Promise<ExecResult> {
  const ids = z.array(z.string()).length(4).parse(payload.whatIfGuideIds);
  const images = ids.map((id) => imageAsset(project, id));
  for (const asset of images) if (!await exists(deps.store.assetPath(project, asset))) throw conflict("A saved keyframe file is missing. Redraw the story first.");
  const aspect = z.enum(["16:9", "9:16", "1:1"]).parse(payload.whatIfAspect ?? project.aspect);
  const size = sizeForAspect(640, 384, aspect);
  const seed = Number(payload.seed ?? 0);
  const prompt = `${String(payload.whatIfPrompt)} One uninterrupted shot with smooth motion through every state. No cuts, no crossfade, no text. Quiet natural ambience, no speech, no music. ${payload.whatIfLook ?? whatIfLook(project.brief)}`;
  const values = { image: deps.store.assetPath(project, images[0]!), image2: deps.store.assetPath(project, images[1]!), image3: deps.store.assetPath(project, images[2]!), lastImage: deps.store.assetPath(project, images[3]!),
    prompt, seed, ...size, frames: WHAT_IF_FRAMES, fps: WHAT_IF_FPS, durationSec: WHAT_IF_DURATION };
  const result = await stage(deps, "_whatIfVideoJobId", "video_what_if", values, { aspect, ...size, durationSec: WHAT_IF_DURATION }, payload, ctx, [0, 1]);
  const videoOutput = result.outputs.find((item) => item.kind === "video");
  const latentOutput = result.outputs.find((item) => item.kind === "latent");
  if (!videoOutput || !latentOutput) throw new Error("The film must save both its video and its joint latent.");
  const video = await deps.store.importFile(project.id, videoOutput.path, "video", { move: true });
  const latent = await deps.store.importFile(project.id, latentOutput.path, "latent", { move: true });
  const take: Take = { id: newId("take"), jobId: job.id, shotId: shot.id, rung: "draft", seed, prompt,
    imageAssetId: images[0]!.id, guideAssetIds: ids, videoAssetId: video.id, latentAssetId: latent.id,
    ...(typeof negative === "string" ? { negative } : {}) };
  await deps.store.mutate(project.id, (p) => {
    p.assets.push(video, latent);
    p.takes = [...p.takes.filter((item) => item.jobId !== job.id), take];
    const current = p.shots.find((item) => item.id === shot.id);
    // A new take of the film is its pick when it lands, like any draft.
    if (current) { pickDraft(p, current, take.id); current.durationSec = WHAT_IF_DURATION; }
  });
  return { outputAssetIds: [video.id, latent.id], message: "Continuous film ready", ...(result.peakGb === undefined ? {} : { peakGb: result.peakGb }) };
}

/** Keep all the spoken words inside the film without changing the voice's pitch. */
export async function fitWhatIfVoice(path: string, signal: AbortSignal): Promise<string> {
  const seconds = (await probeMedia(path)).durationSec;
  const target = WHAT_IF_DURATION - 0.8;
  if (!seconds || seconds <= target) return path;
  const rate = seconds / target;
  if (rate > 1.6) throw new Error("The narration is too long for this film. Shorten it and make the voice again.");
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) throw new Error("ffmpeg is needed to fit the narration to the film.");
  const out = join(path.slice(0, path.lastIndexOf("/")), "what-if-voice.wav");
  await runStreaming(ffmpeg, ["-v", "error", "-y", "-i", path, "-af", `atempo=${rate}`, out], { signal });
  return out;
}
