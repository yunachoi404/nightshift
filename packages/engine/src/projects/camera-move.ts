/** One photo, one explicit camera path. Kept separate from the film storyboard pipeline. */
import { quickMoves, type Asset, type Project, type Shot } from "@nightshift/contract";
import { newId } from "../util.js";
import { badRequest, conflict } from "../errors.js";
import type { ExecContext } from "../queue/queue.js";
import type { JobPayload } from "../queue/store.js";
import type { StepOutput } from "../runner/types.js";
import type { ProjectStore } from "./store.js";

export function cameraSource(project: Project, photoId: unknown = project.brief.photoAssetId): Asset {
  const photo = project.assets.find((a) => a.id === photoId && a.kind === "image");
  if (!photo) throw conflict("Add a photo before making a camera move.");
  return photo;
}

export function cameraMove(value: unknown): string {
  const move = value === undefined ? "dolly_in" : String(value);
  if (!quickMoves.some((p) => p.id === move)) throw badRequest(`Unknown camera move: ${move}`);
  return move;
}

export function cameraPrompt(scene: string, move: string): string {
  const preset = quickMoves.find((p) => p.id === move)!;
  const motion = move === "dolly_zoom"
    ? "Strong vertigo dolly zoom. The camera pulls far back while the lens zooms in. The foreground subject stays the same size and position while the background visibly expands behind it"
    : preset.hint;
  return `${scene.trim() || "The scene in the photo."} Camera movement: ${preset.label}. ${motion}. Follow the guide's camera path and preserve the scene, objects, colors and lighting in the first frame. One continuous shot. Natural quiet ambience.`;
}

export async function cameraLayout(o: {
  project: Project; shot: Shot; payload: JobPayload; ctx: ExecContext; store: ProjectStore;
  run: (values: Record<string, unknown>) => Promise<{ outputs: StepOutput[] }>;
  values: Record<string, unknown>;
}): Promise<string> {
  const remembered = o.project.assets.find((a) => a.id === o.payload._cameraLayoutAssetId && a.kind === "video");
  if (remembered) return o.store.assetPath(o.project, remembered);
  const result = await o.run(o.values);
  const video = result.outputs.find((v) => v.kind === "video");
  if (!video) throw new Error("The camera layout produced no video");
  const asset = await o.store.importFile(o.project.id, video.path, "video", { move: true });
  await o.store.mutate(o.project.id, (p) => { p.assets.push(asset); });
  o.ctx.remember("_cameraLayoutAssetId", asset.id);
  return o.store.assetPath(o.project, asset);
}

/** Prepare the photo shot immediately, even while another project is using the GPU. */
export async function prepareCameraProject(project: Project, store: ProjectStore): Promise<Project> {
  const photo = cameraSource(project);
  const move = cameraMove(project.brief.move);
  return store.mutate(project.id, (p) => {
    const existing = p.shots[0];
    p.shots = [{ ...(existing ?? { id: newId("shot"), locked: false }), index: 0,
      prompt: typeof p.brief.prompt === "string" && p.brief.prompt.trim() ? p.brief.prompt.trim() : "The scene in the photo.",
      cameraMove: move, durationSec: 4, stillAssetId: photo.id }];
    p.takes = p.takes.filter((t) => t.shotId === p.shots[0]!.id);
  });
}
