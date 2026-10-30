import { ProjectSchema, type Asset, type Project, type Shot, type Timeline } from "@nightshift/contract";
import { publicUrl } from "@/lib/publicUrl";
import fixture from "./samples.json";
import { soundPick } from "./soundtrack";

/**
 * Real renders the mock replays where it has them, made by `scripts/build_demo_samples.py` (see public/demo/README.md):
 * the First shot sample's still and draft, and the Nocturne ad, a finished project with its takes, finals, music, title
 * cards and export. A sample asset's path is `sample:<file under public/demo>`. Every other render stays a procedural
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

/** The Nocturne ad, as the engine saved it on the DGX Spark that made it. */
export function sampleAd(): Project {
  return ProjectSchema.parse(structuredClone(fixture.ad));
}

const ad = sampleAd();

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
  ...ad.shots.map((shot: Shot): SampleShot => {
    const asset = (id: string | undefined) => ad.assets.find((a) => a.id === id);
    const takes = ad.takes.filter((t) => t.shotId === shot.id);
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

/** The export the Nocturne ad made, for its cut as it was recorded. */
export const sampleAdExport = ad.assets.find((a) => a.role === "export")!;

/**
 * The cut The Croissant ad was recorded with (trims, voice lines, overlays), while the project still has what it was
 * cut from: the same shots on the timeline with the same picks, and the recorded song and voice as the cut picks them
 * (the soundtrack's pick, else the newest of the role). Then the mock lays out this cut instead of its own, and while
 * it is not edited by hand its export is the real one. It depends only on those inputs, so a card waiting on a board
 * changes nothing, and picking the recorded version again brings the recorded cut back. Undefined otherwise.
 */
/**
 * Whether a recorded project's cut is the one it exported: the same picks, clips and sound as recorded. Then the mock
 * exports the recorded film. A hand-edited cut (the Nocturne ad's is one) holds its clips when a pick changes, so the
 * picks are checked as well as the clips.
 */
export function playsRecordedCut(p: Project, recorded: readonly string[]): boolean {
  const original = ad.timeline;
  if (!recorded.includes(p.id) || p.id !== ad.id || !original || !p.timeline) return false;
  const picks = (q: Project) =>
    q.shots
      .filter((s) => s.onTimeline !== false)
      .sort((a, b) => a.index - b.index)
      .map((s) => `${s.id}:${s.chosenDraftId}:${s.chosenFinalId}:${s.useStill ? "still" : ""}`)
      .join(",");
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  // Which song and voice play, not their levels: a track put back after another comes back at the default level.
  const tracks = (audio: Timeline["audio"]) => audio.map((a) => `${a.role}:${a.assetId}`).sort();
  return picks(p) === picks(ad) && same(p.timeline.clips, original.clips) && same(tracks(p.timeline.audio), tracks(original.audio));
}

export function recordedCut(p: Project, recorded: readonly string[]): Timeline | undefined {
  const original = ad.timeline;
  if (!recorded.includes(p.id) || p.id !== ad.id || !original) return undefined;
  const picks = (q: Project) =>
    q.shots
      .filter((s) => s.onTimeline !== false)
      .sort((a, b) => a.index - b.index)
      .map((s) => `${s.id}:${s.chosenDraftId}:${s.chosenFinalId}:${s.useStill ? "still" : ""}`)
      .join(",");
  const sound = (["music", "voice"] as const).every((role) => (soundPick(p, role) ?? undefined) === original.audio.find((a) => a.role === role)?.assetId);
  if (!sound || picks(p) !== picks(ad)) return undefined;
  // In the caption style the user chose: a style change is not an edit.
  return { ...structuredClone(original), style: p.timeline?.style ?? original.style };
}
