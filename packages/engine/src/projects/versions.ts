/**
 * A shot is one card with its versions: the stills it had, its drafts (plain motion, effects, camera moves) and their
 * finals. A new version becomes the shot's pick when it lands. Picking an older one is a PATCH (see updateProject).
 */
import { DraftToolSchema, finalFor, quickEffects, quickMoves, type DraftTool, type Project, type Shot } from "@nightshift/contract";
import { badRequest } from "../errors.js";
import { nowIso } from "../util.js";

type History = NonNullable<Shot["stillHistory"]>;

/** A shot's still history as it is, or seeded with its current still (a shot from before the engine kept one). */
export function stillHistory(p: Pick<Project, "assets">, shot: Shot): History {
  if (shot.stillHistory) return shot.stillHistory;
  if (!shot.stillAssetId) return [];
  const asset = p.assets.find((a) => a.id === shot.stillAssetId);
  return [{ assetId: shot.stillAssetId, createdAt: asset?.createdAt ?? nowIso() }];
}

/** A new still lands: it is the shot's still and its pick, and joins its history with the prompt it was drawn from. */
export function addStill(p: Pick<Project, "assets">, shot: Shot, assetId: string, prompt: string | undefined): void {
  const history = stillHistory(p, shot).filter((h) => h.assetId !== assetId);
  shot.stillHistory = [...history, { assetId, ...(prompt?.trim() ? { prompt: prompt.trim() } : {}), createdAt: nowIso() }];
  shot.stillAssetId = assetId;
  shot.useStill = true;
}

/** A new draft lands: it is the shot's pick, and the shot shows that draft's final when it has one. */
export function pickDraft(p: Pick<Project, "takes">, shot: Shot, takeId: string): void {
  shot.chosenDraftId = takeId;
  delete shot.useStill;
  const final = finalFor(p.takes, takeId, shot.chosenFinalId);
  if (final) shot.chosenFinalId = final.id;
  else delete shot.chosenFinalId;
}

/** The tool a job's draft is made with, if any. */
export function draftTool(value: unknown): DraftTool | undefined {
  const parsed = DraftToolSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** An effect id from the gallery (`quickEffects`), or a 400 in plain words. */
export function toolEffect(id: string | undefined): string {
  if (!id || !quickEffects.some((e) => e.id === id)) throw badRequest("Choose an effect from the gallery.");
  return id;
}

/** A camera move id from `quickMoves`, or a 400 in plain words. */
export function toolMove(id: string | undefined): string {
  if (!id) throw badRequest("Choose a camera move.");
  if (!quickMoves.some((m) => m.id === id)) throw badRequest(`Unknown camera move: ${id}`);
  return id;
}

/** Whether a shot is in the cut. Shots made by the tools stay on their board until they are sent to the timeline. */
export const onTimeline = (shot: Pick<Shot, "onTimeline">): boolean => shot.onTimeline !== false;
