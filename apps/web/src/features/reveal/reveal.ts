import type { Asset, Job, Project, Shot, Take } from "@nightshift/contract";

/** What a shot's reveal clip compares: its same-take final and the draft that final was made from. */
export interface Revealable {
  shot: Shot;
  draft: Take;
  final: Take;
  draftAsset: Asset;
  finalAsset: Asset;
  /** The still or photo the draft started from, when the project has it. */
  source?: Asset;
  /** What that picture is: a photo the user gave, a keyframe drawn from a typed What-if question, or a storyboard still. */
  sourceKind?: "photo" | "question" | "still";
}

/** The first card's label, in the sheet and the clip: the same words the editor's reveal uses. No false claims. */
export function sourceLabel(r: Pick<Revealable, "sourceKind">, shotNo: number): string {
  return r.sourceKind === "photo" ? "One photo" : r.sourceKind === "question" ? "One question" : r.sourceKind === "still" ? "One still" : `Shot ${shotNo}`;
}

/**
 * The shots the UI offers "Share reveal" for: a chosen same-take final that points at its own draft, both with
 * video. A remaster is never offered as a same-take proof. The same rules live in the editor (packages/editor,
 * reveal/pair.ts), which the engine applies again when it renders.
 */
export function revealable(p: Project, shot: Shot): Revealable | undefined {
  const asset = (id: string | undefined) => (id ? p.assets.find((a) => a.id === id) : undefined);
  const final = p.takes.find((t) => t.id === shot.chosenFinalId && t.rung === "final");
  if (!final || final.finalKind !== "same_take") return undefined;
  const draft = p.takes.find((t) => t.id === final.parentTakeId && t.rung === "draft" && t.shotId === shot.id);
  const draftAsset = asset(draft?.videoAssetId);
  const finalAsset = asset(final.videoAssetId);
  if (!draft || !draftAsset || !finalAsset) return undefined;
  const photoId = typeof p.brief.photoAssetId === "string" ? p.brief.photoAssetId : undefined;
  const source = [shot.stillAssetId, draft.imageAssetId, photoId].map(asset).find((a) => a?.kind === "image");
  if (!source) return { shot, draft, final, draftAsset, finalAsset };
  const question = typeof p.brief.question === "string" && p.brief.question.trim();
  const sourceKind = source.role === "reference" || source.id === photoId ? "photo" : p.template === "what_if" && question ? "question" : "still";
  return { shot, draft, final, draftAsset, finalAsset, source, sourceKind };
}

/** The reveal jobs of a shot, oldest first. A reveal is an export job that carries the shot. */
export function revealJobs(jobs: Job[], shotId: string): Job[] {
  return jobs.filter((j) => j.step === "export" && j.shotId === shotId);
}

/** The film export jobs of a project: exports that carry no shot. */
export function filmExportJobs(jobs: Job[]): Job[] {
  return jobs.filter((j) => j.step === "export" && !j.shotId);
}
