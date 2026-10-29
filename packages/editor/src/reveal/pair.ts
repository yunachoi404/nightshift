/**
 * Which draft and final a reveal clip compares, and how the clip may describe them.
 *
 * The rules are the clip's honesty: a final is only ever paired with the draft it was made from (`parentTakeId`),
 * never with whichever draft the shot has picked since. A same-take final may be called "same take"; a remaster is
 * called a remaster, because a stronger model rendered it again and it can drift. A final whose kind is unknown
 * is not revealed at all.
 */
import type { Asset, FinalKind, Project, Shot, Take } from "@nightshift/contract";

/**
 * What the draft started from, so the clip's first card tells the truth: a photo the user gave, a keyframe
 * drawn from a typed What-if question, or a still the storyboard made.
 */
export type RevealSourceKind = "photo" | "question" | "still";

export interface RevealPair {
  shot: Shot;
  /** "Shot 2": how the clip names the shot when it has no source photo to open on. */
  shotLabel: string;
  draft: Take;
  final: Take;
  draftAsset: Asset;
  finalAsset: Asset;
  /** The photo or still the draft started from, when the project still has it. */
  source?: Asset;
  sourceKind?: RevealSourceKind;
  /** The headline over the first card: "One photo.", the question itself, or "One still." */
  opening: string;
  kind: FinalKind;
}

/** The most characters a What-if question may have to be the headline itself; longer ones get "One question." */
export const OPENING_QUESTION_MAX = 48;

/**
 * How the clip opens, from what the draft started with. A photo the user uploaded is "One photo."; a What-if made
 * from a typed question shows the question (or "One question." when it is too long for one line); a still the
 * storyboard drew is "One still."; and with no picture at all the clip opens on the draft, named by its shot.
 */
export function revealOpening(project: Pick<Project, "template" | "brief">, source: Asset | undefined, shotLabel: string): { kind?: RevealSourceKind; opening: string } {
  if (!source) return { opening: `${shotLabel}.` };
  const photoId = typeof project.brief.photoAssetId === "string" ? project.brief.photoAssetId : undefined;
  if (source.role === "reference" || (photoId !== undefined && source.id === photoId)) return { kind: "photo", opening: "One photo." };
  const question = typeof project.brief.question === "string" ? project.brief.question.trim().replace(/\s+/g, " ") : "";
  if (project.template === "what_if" && question) {
    const asked = /[?!.]$/.test(question) ? question : `${question}?`;
    return { kind: "question", opening: asked.length <= OPENING_QUESTION_MAX ? asked : "One question." };
  }
  return { kind: "still", opening: "One still." };
}

export class RevealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevealError";
  }
}

/** The shot a reveal is about: the one asked for, else the project's only shot. */
export function revealShot(project: Pick<Project, "shots">, shotId?: string): Shot {
  if (shotId) {
    const shot = project.shots.find((s) => s.id === shotId);
    if (!shot) throw new RevealError(`No shot ${shotId} in this project.`);
    return shot;
  }
  if (project.shots.length === 1) return project.shots[0]!;
  throw new RevealError(project.shots.length === 0 ? "This project has no shots." : "Say which shot to reveal: this project has several.");
}

/**
 * The draft and final a shot's reveal compares. Throws a RevealError in plain words when the shot cannot be
 * revealed: no chosen final, a final that does not point at its draft, media missing, or a final of unknown kind.
 */
export function revealPair(project: Project, shotId?: string): RevealPair {
  const shot = revealShot(project, shotId);
  const index = [...project.shots].sort((a, b) => a.index - b.index).findIndex((s) => s.id === shot.id);
  const shotLabel = `Shot ${index + 1}`;
  const asset = (id: string | undefined) => (id ? project.assets.find((a) => a.id === id) : undefined);
  const take = (id: string | undefined) => (id ? project.takes.find((t) => t.id === id) : undefined);

  const final = take(shot.chosenFinalId);
  if (!final || final.rung !== "final") throw new RevealError(`${shotLabel} has no final yet. Finish it first.`);
  if (final.finalKind !== "same_take" && final.finalKind !== "remaster") throw new RevealError(`${shotLabel}'s final does not say how it was made, so it cannot be revealed.`);
  const finalAsset = asset(final.videoAssetId);
  if (!finalAsset || finalAsset.kind !== "video") throw new RevealError(`${shotLabel}'s final has no video.`);

  const draft = take(final.parentTakeId);
  if (!draft || draft.rung !== "draft") throw new RevealError(`${shotLabel}'s final does not point at the draft it was made from.`);
  if (draft.shotId !== shot.id) throw new RevealError(`${shotLabel}'s final was made from another shot's draft.`);
  const draftAsset = asset(draft.videoAssetId);
  if (!draftAsset || draftAsset.kind !== "video") throw new RevealError(`${shotLabel}'s draft has no video any more.`);

  const photoId = typeof project.brief.photoAssetId === "string" ? project.brief.photoAssetId : undefined;
  const source = [shot.stillAssetId, draft.imageAssetId, photoId].map(asset).find((a) => a?.kind === "image");
  const { kind: sourceKind, opening } = revealOpening(project, source, shotLabel);

  return { shot, shotLabel, draft, final, draftAsset, finalAsset, ...(source ? { source, sourceKind } : {}), opening, kind: final.finalKind };
}

/** Whether a shot can be revealed as a same-take proof: a same-take final that points at its own draft, both with video. */
export function canRevealSameTake(project: Project, shot: Shot): boolean {
  try {
    return revealPair(project, shot.id).kind === "same_take";
  } catch {
    return false;
  }
}
