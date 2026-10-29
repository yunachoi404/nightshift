import { ProjectSchema, type Asset, type Project, type Shot } from "@nightshift/contract";
import { publicUrl } from "@/lib/publicUrl";
import fixture from "./samples.json";

/**
 * Real renders the mock replays where it has them, made by `scripts/build_demo_samples.py` (see public/demo/README.md):
 * the First shot sample's still and draft, and The Croissant ad, a finished project with its takes, finals, voice,
 * music and export. A sample asset's path is `sample:<file under public/demo>`. Every other render stays a procedural
 * `mock:` picture, so a prompt the samples never saw never gets a real but unrelated picture.
 */

const SCHEME = "sample:";

export function isSamplePath(path: string | undefined): path is string {
  return !!path?.startsWith(SCHEME);
}

/** Where the browser loads a sample asset. */
export function sampleUrl(path: string): string {
  return publicUrl(`demo/${path.slice(SCHEME.length)}`);
}

/** The lighthouse the First shot sample made on an RTX 2080 Super. */
export const firstShot = fixture.firstShot;

/** The Croissant ad, as the engine saved it on the DGX Spark that made it. */
export function croissantProject(): Project {
  return ProjectSchema.parse(structuredClone(fixture.croissant));
}

const croissant = croissantProject();

/** A recorded shot: its prompt, then the still, drafts and same-take final made from that prompt. */
interface SampleShot {
  prompt: string;
  still: Pick<Asset, "path" | "width" | "height">;
  drafts: Array<Pick<Asset, "path" | "width" | "height" | "durationSec">>;
  final?: Pick<Asset, "path" | "width" | "height" | "durationSec">;
}

const pick = (a: Asset | undefined) => (a ? { path: a.path, width: a.width, height: a.height, durationSec: a.durationSec } : undefined);

const shots: SampleShot[] = [
  { prompt: firstShot.prompt, still: firstShot.still, drafts: [firstShot.draft] },
  ...croissant.shots.map((shot: Shot): SampleShot => {
    const asset = (id: string | undefined) => croissant.assets.find((a) => a.id === id);
    const takes = croissant.takes.filter((t) => t.shotId === shot.id);
    return {
      prompt: shot.prompt,
      still: pick(asset(shot.stillAssetId))!,
      drafts: takes.filter((t) => t.rung === "draft").flatMap((t) => pick(asset(t.videoAssetId)) ?? []),
      final: pick(asset(takes.find((t) => t.id === shot.chosenFinalId)?.videoAssetId)),
    };
  }),
];

/** The recorded shot for exactly this prompt. An edited prompt has none. */
export function sampleForPrompt(prompt: string): SampleShot | undefined {
  return shots.find((s) => s.prompt === prompt);
}

/** The recorded shot a still came from, so its drafts and finals are that shot's real takes. */
export function sampleForStill(path: string | undefined): SampleShot | undefined {
  return isSamplePath(path) ? shots.find((s) => s.still.path === path) : undefined;
}

/** The recorded shot a draft came from. */
export function sampleForDraft(path: string | undefined): SampleShot | undefined {
  return isSamplePath(path) ? shots.find((s) => s.drafts.some((d) => d.path === path)) : undefined;
}

/** The export The Croissant ad made, for its cut as it was recorded. */
export const croissantExport = croissant.assets.find((a) => a.role === "export")!;

/**
 * Whether a project still has the cut it was recorded with: the same shots in the same clips. Then the mock keeps that
 * timeline (trims, voice lines, overlays) instead of laying out its own, and its export is the real one.
 */
export function keepsRecordedCut(p: Project, recorded: readonly string[]): boolean {
  if (!recorded.includes(p.id) || !p.timeline) return false;
  const original = croissant.timeline;
  if (p.id !== croissant.id || !original) return false;
  const picks = (q: Project) => q.shots.map((s) => `${s.id}:${s.chosenDraftId}:${s.chosenFinalId}`).join(",");
  return picks(p) === picks(croissant) && JSON.stringify(p.timeline.clips) === JSON.stringify(original.clips);
}
