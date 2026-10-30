/** Photo effects through LTX, with an edited end frame where the effect has a clear final state. */
import { quickEffects, type Aspect, type Asset, type Job, type Project, type Shot, type Take } from "@nightshift/contract";
import { conflict } from "../errors.js";
import { exists, newId } from "../util.js";
import type { ExecContext, ExecResult } from "../queue/queue.js";
import type { JobPayload } from "../queue/store.js";
import type { StepOutput, StepRequest } from "../runner/types.js";
import type { ProjectStore } from "./store.js";
import { draftTool, pickDraft } from "./versions.js";

interface EffectDirection { end: string | null; action: string; staticCamera?: boolean }
const DIRECTIONS: Record<string, EffectDirection> = {
  earth_zoom: { end: null, staticCamera: false, action: "The camera rockets backwards and upwards, rapidly zooming out from the subject, through clouds above a city, then revealing the curved blue Earth from space. One continuous accelerating zoom out" },
  levitate: { end: null, action: "The subject gently lifts off the ground and levitates, floating upward a short distance, slowly rotating. Its detached shadow remains visible below" },
  freeze: { end: "covered in thick translucent blue ice and fine white frost crystals", action: "White frost spreads across the subject, then jagged translucent ice crystals grow outward, with drifting cold mist" },
  ignite: { end: "engulfed in tall orange flames, with glowing embers and dark smoke rising", action: "Orange flames ignite at the base and spread upward around the subject, flickering and throwing sparks into the air" },
  disintegrate: { end: "completely absent, replaced by a thin cloud of fine dust and a small pile of powder on the ground. No solid subject or upright silhouette remains", action: "The subject crumbles from the top down into thousands of fine dust particles that blow sideways and disperse" },
  melt: { end: "completely collapsed into a wide low glossy puddle on the ground. No upright subject remains; only flowing liquid and a few low folds", action: "The subject softens, sags downward and melts into a glossy puddle, with thick liquid flowing under gravity" },
  explode: { end: "completely absent, replaced by dozens of broken fragments of its material scattered on the ground and flying through the air. The center is empty. No solid subject or upright silhouette remains", action: "The subject bursts outward in a sudden explosive impact. Fragments fly radially outward with a shockwave of dust" },
  bloom: { end: "covered in abundant small colorful wildflowers and curling green vines, same original silhouette", action: "Green vines climb the subject, leaves unfurl, and pink and white flowers rapidly bloom all over its surface" },
  gold: { end: "made entirely of polished reflective gold metal, same shape and silhouette", action: "A wave of liquid gold spreads across the subject from bottom to top, replacing every surface with polished reflective gold" },
  crystal: { end: "made entirely from translucent iridescent faceted crystal, same silhouette", action: "Translucent prismatic crystals grow across the subject from bottom to top, with sparkling reflections and rainbow refractions" },
};

export function effectPhoto(project: Project, brief = project.brief): Asset {
  const photo = project.assets.find((a) => a.id === brief.photoAssetId && a.kind === "image");
  if (!photo) throw conflict("Add a photo to this Effect project first.");
  return photo;
}

export function effectDirection(brief: Project["brief"]): EffectDirection {
  const id = typeof brief.effect === "string" ? brief.effect : "";
  const direction = DIRECTIONS[id];
  if (!direction || !quickEffects.some((e) => e.id === id)) throw conflict("Choose an effect from the gallery.");
  return direction;
}

export function effectPrompts(brief: Project["brief"], subject: string) {
  const { end, action, staticCamera } = effectDirection(brief);
  const scene = subject.trim() ? `The subject is ${subject.trim()}. ` : "";
  return {
    end: end === null ? null : `${scene}Keep the exact camera, framing, background and lighting of the photo. Transform only the main subject: it is now ${end}. Photorealistic VFX end frame, no text.`,
    video: `${scene}${staticCamera === false ? "" : "Locked-off shot. "}${action}. Keep the scene, subject identity and lighting consistent. The first frame is exactly the supplied photo. One continuous physical action, no cuts, no crossfade, no text. Cinematic visual effects.`,
  };
}

interface EffectDeps {
  store: ProjectStore;
  run(step: "effect_end_frame" | "video_effect" | "video_draft", values: Record<string, unknown>, hints: StepRequest["hints"], payload: JobPayload, ctx: ExecContext, span: [number, number]): Promise<{ outputs: StepOutput[]; peakGb?: number }>;
}

/**
 * The image-edit step can also finish an already queued end-frame job on its own. `shape` is the size it renders at,
 * and the shape of its shot (the project's when it does not say).
 */
export async function runEffectFrame(deps: EffectDeps, project: Project, payload: JobPayload, ctx: ExecContext, shape: { aspect?: Aspect; width: number; height: number }): Promise<ExecResult> {
  const brief = (payload.effectBrief ?? project.brief) as Project["brief"];
  const photo = effectPhoto(project, brief);
  const prompts = effectPrompts(brief, typeof brief.prompt === "string" ? brief.prompt : "");
  if (prompts.end === null) throw conflict("This effect animates the photo directly and has no end frame.");
  const size = { width: shape.width, height: shape.height };
  const result = await deps.run("effect_end_frame", { image: deps.store.assetPath(project, photo), prompt: prompts.end, seed: payload.seed ?? 0, ...size }, { aspect: shape.aspect ?? project.aspect, ...size }, payload, ctx, [0, 1]);
  const output = result.outputs.find((o) => o.kind === "image");
  if (!output) throw new Error("The effect's end-frame step produced no image.");
  const image = await deps.store.importFile(project.id, output.path, "image", { move: true });
  await deps.store.mutate(project.id, (p) => { p.assets.push(image); });
  return { outputAssetIds: [image.id], message: "Effect end frame ready", ...(result.peakGb === undefined ? {} : { peakGb: result.peakGb }) };
}

/** Separate resume keys prevent the second stage from reattaching to the first stage's Comfy job. */
export async function runEffect(deps: EffectDeps, project: Project, shot: Shot, job: Job, payload: JobPayload, ctx: ExecContext, size: { width: number; height: number }, negative: unknown): Promise<ExecResult> {
  const brief = (payload.effectBrief ?? project.brief) as Project["brief"];
  const photo = effectPhoto(project, brief);
  const prompts = effectPrompts(brief, typeof payload.effectPrompt === "string" ? payload.effectPrompt : shot.prompt);
  const image = deps.store.assetPath(project, photo);
  const seed = typeof payload.seed === "number" ? payload.seed : 0;
  // The shot's own shape when it has one (a card made in another shape), else the project's.
  const hints = { aspect: shot.aspect ?? project.aspect, ...size, durationSec: 4 };
  let peak: number | undefined;
  const run = async (step: "effect_end_frame" | "video_effect" | "video_draft", values: Record<string, unknown>, span: [number, number]) => {
    const key = step === "effect_end_frame" ? "_effectEndJobId" : "_effectVideoJobId";
    const result = await deps.run(step, values, hints, { ...payload, _comfyJobId: payload[key] }, {
      ...ctx,
      remember: (name, value) => ctx.remember(name === "_comfyJobId" ? key : name, value),
    }, span);
    if (result.peakGb !== undefined) peak = Math.max(peak ?? 0, result.peakGb);
    return result.outputs;
  };
  let end: Asset | undefined;
  if (prompts.end !== null) {
    end = deps.store.findAsset(project, typeof payload._effectEndAssetId === "string" ? payload._effectEndAssetId : undefined);
    if (!end || !(await exists(deps.store.assetPath(project, end)))) {
      const outputs = await run("effect_end_frame", { image, prompt: prompts.end, seed, ...size }, [0, 0.25]);
      const output = outputs.find((o) => o.kind === "image");
      if (!output) throw new Error("The effect's end-frame step produced no image.");
      end = await deps.store.importFile(project.id, output.path, "image", { move: true });
      await deps.store.mutate(project.id, (p) => { p.assets.push(end!); });
      ctx.remember("_effectEndAssetId", end.id);
    }
  }
  const values = { image, ...(end ? { lastImage: deps.store.assetPath(project, end) } : {}), prompt: prompts.video, seed, ...size, fps: 24, frames: 97, durationSec: 4 };
  const outputs = await run(end ? "video_effect" : "video_draft", values, end ? [0.25, 1] : [0, 1]);
  const output = outputs.find((o) => o.kind === "video");
  if (!output) throw new Error("The effect step produced no video.");
  const video = await deps.store.importFile(project.id, output.path, "video", { move: true });
  const latentOutput = outputs.find((o) => o.kind === "latent");
  const latent = latentOutput ? await deps.store.importFile(project.id, latentOutput.path, "latent", { move: true }) : undefined;
  const take: Take = { id: newId("take"), shotId: shot.id, rung: "draft", seed, jobId: job.id, videoAssetId: video.id, imageAssetId: photo.id, prompt: prompts.video };
  if (latent) take.latentAssetId = latent.id;
  if (typeof negative === "string") take.negative = negative;
  const tool = draftTool(payload.tool);
  if (tool) take.tool = tool;
  await deps.store.mutate(project.id, (p) => {
    p.assets.push(video, ...(latent ? [latent] : []));
    p.takes = [...p.takes.filter((t) => t.jobId !== job.id), take];
    // A new effect is the shot's pick when it lands.
    const current = p.shots.find((s) => s.id === shot.id);
    if (current) pickDraft(p, current, take.id);
  });
  return { outputAssetIds: [...(end ? [end.id] : []), video.id, ...(latent ? [latent.id] : [])], message: "Effect ready", ...(peak === undefined ? {} : { peakGb: peak }) };
}
