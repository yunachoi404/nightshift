/**
 * The engine's rules for who owns a project's timeline. The editor cuts it (see editor.ts) until someone changes
 * the cut by hand; from then on it is kept as it is (`Timeline.edited`), and new audio only replaces its track.
 *
 * Every stored change bumps the timeline's `revision`, and the store remembers the last few timelines it stored.
 * A PATCH is judged against the one it was read from, so a cut the engine made while the UI held an older one is
 * never mistaken for a hand edit.
 */
import type { Asset, Project, Shot, Timeline } from "@nightshift/contract";

type Track = Timeline["audio"][number];

/**
 * The timeline a PATCH stores. It counts as a hand edit when its clips, audio, captions, overlays or markers differ
 * from those of the timeline it was read from; style changes do not count. Clips laid out as the plain default cut do
 * not count either, so a UI that mirrors that cut does not take the timeline away from the editor. `edited: false`
 * hands it back.
 *
 * The timeline it was read from is the one at its `revision` among `known` (the store's recent timelines, newest
 * first). Without a revision, or with one no longer remembered, it is the newest known one it changed nothing of. A
 * PATCH read from an older timeline that changed nothing by hand keeps the newer stored cut and takes only its style;
 * its `edited` flag is then an echo of what it read, not a request.
 */
export function patchedTimeline(p: Project, incoming: Timeline, known: Timeline[] = []): Timeline {
  const { edited, revision, ...rest } = incoming;
  if (edited === false) return rest;
  const stored = p.timeline;
  const current = revision === undefined || revision === stored?.revision;
  if (current && (edited === true || stored?.edited)) return { ...rest, edited: true };
  const atRevision = revision === undefined ? undefined : known.find((t) => t.revision === revision);
  const candidates: (Timeline | null)[] = atRevision ? [atRevision] : [stored, ...known.filter((t) => t !== stored)];
  const read = candidates.find((t) => !changedByHand(p, rest, t));
  if (read === undefined) return { ...rest, edited: true };
  if (stored && read !== stored && contentKey(read) !== contentKey(stored)) {
    const { revision: _, ...newer } = stored;
    return { ...newer, style: rest.style };
  }
  return stored?.edited ? { ...rest, edited: true } : rest;
}

/** Whether `t` changes the cut of `base` by hand: its clips (unless laid out as the plain cut), audio, captions, overlays or markers. */
function changedByHand(p: Project, t: Timeline, base: Timeline | null): boolean {
  const extras = (x: Timeline | null) => stableJson([x?.audio ?? [], x?.captions ?? [], x?.overlays ?? [], x?.markers ?? []]);
  if (extras(t) !== extras(base)) return true;
  return stableJson(t.clips) !== stableJson(base?.clips ?? []) && !isDefaultCut(p, t.clips);
}

/** A timeline's content, its revision left out, for telling whether a change changed anything. */
export function contentKey(t: Timeline | null | undefined): string {
  if (!t) return "null";
  const { revision: _, ...rest } = t;
  return stableJson(rest);
}

/**
 * The timeline to store in place of `before`: `after` with its revision, one more than the last one (`before`'s, or
 * `last` when that is higher) when anything but the revision changed. The engine owns revisions, so whatever `after`
 * carried is replaced.
 */
export function withRevision(before: Timeline | null, after: Timeline | null, last = 0): Timeline | null {
  if (!after) return null;
  const prev = Math.max(before?.revision ?? 0, last);
  return { ...after, revision: contentKey(before) === contentKey(after) ? prev : prev + 1 };
}

/**
 * The plain cut: shots in storyboard order, back to back, each clip one of the shot's own pictures from its start
 * for the shot's storyboard length. A shot with no picture leaves its slot empty.
 */
export function isDefaultCut(p: Project, clips: Timeline["clips"]): boolean {
  let t = 0;
  let k = 0;
  for (const shot of [...p.shots].sort((a, b) => a.index - b.index)) {
    const clip = clips[k];
    if (clip?.shotId === shot.id) {
      const plain = near(clip.start, t) && clip.in === 0 && near(clip.out, shot.durationSec) && clip.gain === undefined && clip.focus === undefined;
      if (!plain || !isPictureOf(p, shot, clip.assetId)) return false;
      k++;
    }
    t += shot.durationSec;
  }
  return k === clips.length;
}

/** Put a new song or voice on a hand-edited timeline in place of the old track of its role, where that one started. */
export function replaceTrack(tl: Timeline, asset: Asset, role: "music" | "voice"): Track {
  const old = tl.audio.find((a) => a.role === role);
  const track: Track = { assetId: asset.id, role, start: old?.start ?? 0, gain: old?.gain ?? 1 };
  tl.audio = [...tl.audio.filter((a) => a.role !== role), track];
  return track;
}

function isPictureOf(p: Project, shot: Shot, assetId: string): boolean {
  if (assetId === shot.stillAssetId) return true;
  return p.takes.some((t) => t.shotId === shot.id && t.videoAssetId === assetId);
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;

/** JSON with sorted keys and no undefined fields, so equal values compare equal however they were built. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
  });
}
