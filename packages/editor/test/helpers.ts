import type { Asset, Project, Shot, Take, TemplateId, Timeline } from "@nightshift/contract";
import type { MediaInfo } from "../src/media/ffmpeg.js";

const NOW = "2026-10-19T00:00:00.000Z";

export interface FakeShot {
  kind: "video" | "image";
  /** Media length (videos). */
  length?: number;
  durationSec: number;
}

/** A project with one asset per shot, and the matching probe results. */
export function fakeProject(template: TemplateId, shots: FakeShot[], audio: Asset[] = [], brief: Record<string, unknown> = {}): { project: Project; media: Record<string, MediaInfo> } {
  const media: Record<string, MediaInfo> = {};
  const assets: Asset[] = [];
  const takes: Take[] = [];
  const list: Shot[] = shots.map((s, index) => {
    const assetId = `a${index}`;
    assets.push({ id: assetId, kind: s.kind, path: `${assetId}.${s.kind === "image" ? "png" : "mp4"}`, createdAt: NOW });
    media[assetId] = {
      path: assetId,
      kind: s.kind,
      durationSec: s.kind === "image" ? Infinity : (s.length ?? 4),
      width: 1920,
      height: 1088,
      fps: s.kind === "image" ? null : 24,
      hasAudio: false,
    };
    const shot: Shot = { id: `s${index}`, index, prompt: "", durationSec: s.durationSec, locked: false };
    if (s.kind === "image") shot.stillAssetId = assetId;
    else {
      takes.push({ id: `t${index}`, shotId: shot.id, rung: "final", seed: 1, videoAssetId: assetId, jobId: "j" });
      shot.chosenFinalId = `t${index}`;
    }
    return shot;
  });
  for (const a of audio) {
    assets.push(a);
    media[a.id] = { path: a.id, kind: "audio", durationSec: a.durationSec ?? 30, width: null, height: null, fps: null, hasAudio: true };
  }
  return {
    project: { id: "p", name: "Test project", template, aspect: "16:9", brief, shots: list, takes, assets, timeline: null, createdAt: NOW, updatedAt: NOW },
    media,
  };
}

export function audioAssetOf(id: string, role: "music" | "voice", durationSec: number, text?: string): Asset {
  return { id, kind: "audio", path: `${id}.wav`, role, durationSec, createdAt: NOW, ...(text ? { text } : {}) };
}

/** Every instant of [0, end) is covered by some clip, clips stay inside their media, and they are ordered. */
export function expectWellFormed(timeline: Timeline, media: Record<string, MediaInfo>, end: number): string[] {
  const problems: string[] = [];
  const clips = timeline.clips;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]!;
    const info = media[c.assetId]!;
    if (c.in < -1e-6) problems.push(`clip ${i} starts before its media (in ${c.in})`);
    if (info.kind !== "image" && c.out > info.durationSec + 1e-6) problems.push(`clip ${i} runs past its media (${c.out} > ${info.durationSec})`);
    if (c.out - c.in <= 0) problems.push(`clip ${i} is empty`);
    if (i > 0 && c.start < clips[i - 1]!.start) problems.push(`clip ${i} is out of order`);
  }
  // Coverage, sampled every 10 ms.
  for (let t = 0; t < end - 0.02; t += 0.01) {
    if (!clips.some((c) => c.start - 1e-6 <= t && t < c.start + (c.out - c.in) + 1e-6)) {
      problems.push(`nothing on screen at ${t.toFixed(2)}s`);
      break;
    }
  }
  return problems;
}
