import type { Asset, AudioRole, Project, Shot, Take, TemplateId } from "@nightshift/contract";
import type { MediaInfo } from "../media/ffmpeg.js";

/** The picture the editor uses for a shot: the best take there is, or the storyboard still. */
export interface ShotSource {
  shot: Shot;
  asset: Asset;
  /** final > draft > still. */
  rung: "final" | "draft" | "still";
}

/**
 * Picks the picture of each shot on the timeline: its still when the still is its pick (`useStill`), else its chosen
 * final, then its chosen draft, then its newest take with video, then its still. Shots kept on a board out of the cut
 * (`onTimeline: false`) and shots with nothing to show are left out. Ordered by shot index.
 */
export function shotSources(project: Project): ShotSource[] {
  const assets = new Map(project.assets.map((a) => [a.id, a]));
  const takes = new Map(project.takes.map((t) => [t.id, t]));
  const out: ShotSource[] = [];
  for (const shot of [...project.shots].sort((a, b) => a.index - b.index)) {
    if (shot.onTimeline === false) continue;
    const video = (take: Take | undefined) => (take?.videoAssetId ? assets.get(take.videoAssetId) : undefined);
    const chosenFinal = video(shot.chosenFinalId ? takes.get(shot.chosenFinalId) : undefined);
    const chosenDraft = video(shot.chosenDraftId ? takes.get(shot.chosenDraftId) : undefined);
    const newest = project.takes
      .filter((t) => t.shotId === shot.id && t.videoAssetId && assets.has(t.videoAssetId))
      .map((t) => ({ take: t, asset: assets.get(t.videoAssetId as string) as Asset }))
      .sort((a, b) => rungRank(b.take) - rungRank(a.take) || b.asset.createdAt.localeCompare(a.asset.createdAt))[0];
    const still = shot.stillAssetId ? assets.get(shot.stillAssetId) : undefined;
    if (shot.useStill && still) out.push({ shot, asset: still, rung: "still" });
    else if (chosenFinal) out.push({ shot, asset: chosenFinal, rung: "final" });
    else if (chosenDraft) out.push({ shot, asset: chosenDraft, rung: "draft" });
    else if (newest) out.push({ shot, asset: newest.asset, rung: newest.take.rung });
    else if (still) out.push({ shot, asset: still, rung: "still" });
  }
  return out;
}

function rungRank(take: Take): number {
  return take.rung === "final" ? 1 : 0;
}

/**
 * The audio asset the cut plays for a role. The project's soundtrack picks it: null leaves the role out, an id picks
 * that asset while it exists. Otherwise the newest of the role. Assets without a role are considered only when no
 * asset has the role: a song for a music video (the longest), a voice for the voice-driven templates (one that has
 * text).
 */
export function audioAsset(project: Project, role: AudioRole, template: TemplateId, media?: Record<string, MediaInfo>): Asset | undefined {
  const audio = project.assets.filter((a) => a.kind === "audio");
  const pick = role === "music" || role === "voice" ? project.soundtrack?.[role] : undefined;
  if (pick === null) return undefined;
  const picked = pick ? audio.find((a) => a.id === pick) : undefined;
  if (picked) return picked;
  const tagged = audio.filter((a) => a.role === role).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (tagged[0]) return tagged[0];
  const untagged = audio.filter((a) => a.role === undefined);
  if (role === "music" && template === "music_video") {
    const length = (a: Asset) => media?.[a.id]?.durationSec ?? a.durationSec ?? 0;
    return untagged.sort((a, b) => length(b) - length(a))[0];
  }
  if (role === "voice" && (template === "product_ad" || template === "talking_intro")) {
    return untagged.filter((a) => a.text).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }
  return undefined;
}

/** Usable length of a source in seconds (stills: unlimited). Keeps a frame of margin before the end of a video. */
export function usableLength(info: MediaInfo | undefined, asset: Asset): number {
  if (asset.kind === "image" || info?.kind === "image") return Infinity;
  const duration = info?.durationSec ?? asset.durationSec ?? 0;
  return Math.max(0, duration - 0.05);
}
