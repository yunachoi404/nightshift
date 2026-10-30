/**
 * Turns a project's shots, song and voice into a Timeline, one planner per template. Pure: every fact about the
 * media (lengths, beats, word times) comes in through `PlanInput`, so this is cheap to test and to re-run when the
 * user swaps a take.
 */
import { timelineDuration, type Caption, type Marker, type Overlay, type Project, type TemplateId, type Timeline } from "@nightshift/contract";
import type { BeatMap } from "../audio/beats.js";
import { estimateWords, groupCaptions, splitSentences } from "../captions/group.js";
import { round3, tokenizeText, type Word } from "../captions/words.js";
import type { MediaInfo } from "../media/ffmpeg.js";
import { resolveStyle, type TimelineStyle } from "../style.js";
import { readBrief, type EditorBrief } from "./brief.js";
import { shotSources, usableLength } from "./sources.js";

export type TimelineClip = Timeline["clips"][number];
export type TimelineAudio = Timeline["audio"][number];

export interface VoiceTrack {
  assetId: string;
  /** Word times in the voice file's own time. */
  words: Word[];
}

export interface SongTrack {
  assetId: string;
  beats: BeatMap | null;
  /** Sung words in the song file's own time (empty when there are none). */
  lyrics: Word[];
}

export interface PlanInput {
  project: Project;
  template?: TemplateId;
  /** Probed media, keyed by asset id. Missing entries fall back to the asset's own `durationSec`. */
  media: Record<string, MediaInfo>;
  voice?: VoiceTrack | null;
  song?: SongTrack | null;
  /** Style overrides to keep (usually the current timeline's). */
  style?: Record<string, unknown>;
}

export interface PlanResult {
  timeline: Timeline;
  durationSec: number;
  warnings: string[];
}

interface Source {
  shotId: string;
  assetId: string;
  kind: "video" | "image";
  /** Usable seconds. Infinity for stills. */
  avail: number;
  /** How long the storyboard wants the shot. */
  desired: number;
  uses: number;
}

interface Ctx {
  project: Project;
  template: TemplateId;
  style: TimelineStyle;
  brief: EditorBrief;
  media: Record<string, MediaInfo>;
  sources: Source[];
  warnings: string[];
}

interface Planned {
  clips: TimelineClip[];
  audio: TimelineAudio[];
  words: Word[];
  overlays: Overlay[];
  markers: Marker[];
  duration: number;
}

export function planTimeline(input: PlanInput): PlanResult {
  const template = input.template ?? input.project.template;
  const { style, warnings } = resolveStyle(template, { look: template, ...input.style });
  const ctx: Ctx = {
    project: input.project,
    template,
    style,
    brief: readBrief(input.project),
    media: input.media,
    sources: collectSources(input.project, input.media),
    warnings: [...warnings],
  };
  if (ctx.sources.length === 0) ctx.warnings.push("No shot has a still or a video yet: the timeline has no picture.");

  const planned =
    template === "music_video"
      ? planMusicVideo(ctx, input.song ?? null)
      : template === "product_ad"
        ? planProductAd(ctx, input.voice ?? null, input.song ?? null)
        : template === "talking_intro"
          ? planTalkingIntro(ctx, input.voice ?? null, input.song ?? null)
          : planCinematic(ctx, input.voice ?? null, input.song ?? null);

  const captions: Caption[] = groupCaptions(
    planned.words.filter((w) => w.start < planned.duration),
    { maxChars: style.captions.maxChars, maxDuration: style.captions.look === "kinetic" ? 2.6 : 3.2 },
  ).map((c) => ({ ...c, end: Math.min(c.end, round3(planned.duration)) }));

  const timeline: Timeline = {
    clips: planned.clips.map(roundClip).sort((a, b) => a.start - b.start),
    audio: planned.audio.map((a) => ({ ...a, start: round3(a.start), ...(a.in === undefined ? {} : { in: round3(a.in) }), ...(a.out === undefined ? {} : { out: round3(a.out) }) })),
    captions,
    overlays: planned.overlays.map((o) => ({ ...o, start: round3(o.start), end: round3(o.end) })),
    markers: planned.markers,
    style: { ...(input.style ?? {}), look: input.style?.look ?? template },
  };
  return { timeline, durationSec: round3(planned.duration), warnings: ctx.warnings };
}

/** Where a timeline ends: the last clip or overlay. Shared with the UI through the contract, so both say one length. */
export { timelineDuration };

// ---------------------------------------------------------------- templates

function planCinematic(ctx: Ctx, voice: VoiceTrack | null, song: SongTrack | null): Planned {
  const overlapWanted = ctx.sources.length > 1 ? ctx.style.transition.duration : 0;
  const clips: TimelineClip[] = [];
  let t = 0;
  let prevLength = 0;
  ctx.sources.forEach((src, k) => {
    const length = src.desired;
    // Dissolves overlap the shots, so the film gets shorter by the overlaps rather than cutting shots short.
    const overlap = k === 0 ? 0 : Math.min(overlapWanted, length / 3, prevLength / 3);
    const start = k === 0 ? 0 : t - overlap;
    clips.push(clipFor(src, start, length, 1));
    t = start + length;
    prevLength = length;
  });
  const voiceStart = 0.6;
  const words = voice ? shiftWords(voice.words, voiceStart) : [];
  const duration = Math.max(t, words.at(-1)?.end ?? 0, ctx.sources.length ? 0 : 4);
  const titleStart = Math.min(0.6, duration * 0.1);
  // Quick shots, What if? films and blank projects open on their picture, without a title card.
  const overlays: Overlay[] = ctx.template === "camera_move" || ctx.template === "vfx_effect" || ctx.template === "what_if" || ctx.template === "blank" ? [] : [
    {
      id: "title",
      kind: "title",
      start: titleStart,
      end: titleStart + cinematicTitleLength(duration),
      text: ctx.brief.title ?? ctx.project.name,
      ...(ctx.brief.subtitle ? { subtext: ctx.brief.subtitle } : {}),
    },
  ];
  const audio: TimelineAudio[] = [];
  if (song) audio.push(songAudio(song, ctx, 0, duration));
  if (voice) audio.push({ assetId: voice.assetId, role: "voice", start: voiceStart, gain: 1 });
  return { clips, audio, words, overlays, markers: [], duration };
}

/**
 * How long a cinematic film's title stays up: about 30% of the film, at most 3.6 s (a 12 s sequence's), and at least
 * the 1.5 s a short title takes to read, or half a film shorter than 3 s. A 5 s film from 2 s drafts gets 1.5 s of
 * title, not the 3.2 s that covered most of it.
 */
export function cinematicTitleLength(duration: number): number {
  return Math.min(3.6, Math.max(Math.min(1.5, duration * 0.5), duration * 0.3));
}

function planMusicVideo(ctx: Ctx, song: SongTrack | null): Planned {
  if (!song) {
    ctx.warnings.push("No song yet: shots are laid end to end without beat sync.");
    const clips: TimelineClip[] = [];
    let t = 0;
    for (const src of ctx.sources) {
      clips.push(clipFor(src, t, src.desired, 0));
      t += src.desired;
    }
    return { clips, audio: [], words: [], overlays: titleOverlay(ctx, t), markers: [], duration: Math.max(t, 1) };
  }
  const info = ctx.media[song.assetId];
  const songLength = info?.durationSec ?? ctx.project.assets.find((a) => a.id === song.assetId)?.durationSec ?? 0;
  const songStart = Math.min(ctx.brief.songStartSec ?? 0, Math.max(0, songLength - 1));
  const available = songLength - songStart;
  const beatMap = song.beats;
  const beats = (beatMap?.beats ?? []).map((b) => b - songStart).filter((b) => b > 0.05 && b < available);
  const downbeats = (beatMap?.downbeats ?? []).map((b) => b - songStart).filter((b) => b > 0.05 && b < available);
  const sectionStarts = (beatMap?.sections ?? []).map((s) => s.start - songStart).filter((s) => s > 0.5 && s < available);
  if (!beatMap || beats.length < 4) ctx.warnings.push("The song has no steady beat: cuts follow the shot lengths instead.");
  const period = medianGap(beats) ?? 0.5;

  // Cut the song short on a downbeat near the asked length, so the music ends on a bar line.
  let end = available;
  const asked = ctx.brief.durationSec;
  if (asked !== undefined && asked < available - 0.5) {
    const near = nearest(downbeats.length ? downbeats : beats, asked, period * 4);
    end = near !== undefined && near >= asked * 0.8 ? near : asked;
  }

  const isDownbeat = closeTo(downbeats, 0.03);
  // In 4/4 the third beat of a bar is the next strongest place to cut.
  const isHalfBar = beatMap?.meter === 4 ? closeTo(downbeats.map((d) => d + 2 * period), 0.03) : () => false;
  const isSection = closeTo(sectionStarts, period * 0.6);
  const minLength = Math.max(0.8, period);
  const clips: TimelineClip[] = [];
  let t = 0;
  let k = 0;
  for (let guard = 0; end - t > 0.05 && guard < 5000 && ctx.sources.length; guard++, k++) {
    const src = ctx.sources[k % ctx.sources.length] as Source;
    const desired = Math.max(minLength, Math.min(src.desired, src.avail));
    const maxLength = Math.min(src.avail, end - t);
    const remaining = end - t;
    let cut: number;
    if (remaining <= maxLength + 1e-6 && remaining <= desired * 1.5 + period) {
      cut = end;
    } else {
      const candidates = beats.filter((b) => b >= t + minLength - 1e-6 && b <= t + maxLength + 1e-6 && b <= end - minLength);
      if (candidates.length === 0) {
        cut = t + Math.min(maxLength, Math.max(minLength, Math.min(desired, remaining - minLength)));
      } else {
        let best = candidates[0] as number;
        let bestScore = Infinity;
        for (const b of candidates) {
          // Bar lines and half bars pull cuts towards them, a new section most; the shot's own length still counts,
          // so cuts do not fall on every bar like a metronome.
          const score = Math.abs(b - t - desired) / Math.max(period, 0.25) - (isDownbeat(b) ? 1.5 : isHalfBar(b) ? 0.75 : 0) - (isSection(b) ? 3 : 0);
          if (score < bestScore) {
            bestScore = score;
            best = b;
          }
        }
        cut = best;
      }
    }
    clips.push(clipFor(src, t, cut - t, 0));
    t = cut;
  }

  const markers: Marker[] = [
    ...beats.filter((b) => b < end && !isDownbeat(b)).map((b) => ({ t: round3(b), kind: "beat" as const })),
    ...downbeats.filter((b) => b < end).map((b) => ({ t: round3(b), kind: "downbeat" as const })),
    ...sectionStarts.filter((s) => s < end).map((s) => ({ t: round3(s), kind: "section" as const })),
  ].sort((a, b) => a.t - b.t);
  const words = shiftWords(song.lyrics, -songStart).filter((w) => w.start >= 0 && w.end <= end + 0.5);
  return {
    clips,
    audio: [songAudio(song, ctx, 0, end, songStart)],
    words,
    overlays: titleOverlay(ctx, end),
    markers,
    duration: end,
  };
}

/**
 * A product ad runs the length its template promises (15 s, the contract's `templates`), unless the brief's
 * `durationSec` asks for another. A voiceover that ends early is paced to it: a pause of up to `AD_MAX_PAUSE` between
 * its sentences, then an end card that holds up to `AD_MAX_END_CARD`. A voiceover longer than that makes a longer ad.
 */
export const AD_LENGTH_SEC = 15;
const AD_MAX_PAUSE = 0.8;
const AD_MAX_END_CARD = 6;

function planProductAd(ctx: Ctx, voice: VoiceTrack | null, song: SongTrack | null): Planned {
  const voiceStart = 0.3;
  const speechToCard = 0.35;
  const baseEndCard = 2.6;
  const target = ctx.brief.durationSec ?? AD_LENGTH_SEC;
  const script = ctx.project.assets.find((a) => a.id === voice?.assetId)?.text ?? ctx.brief.script;
  // In the voice file's own time.
  const spoken = voice ? voice.words : script ? estimateWords(script, { start: 0 }) : [];
  if (!voice && script) ctx.warnings.push("No voiceover yet: caption timing is estimated from the script.");
  const sentences = splitSentences(spoken);
  const slack = spoken.length ? Math.max(0, target - (voiceStart + (spoken.at(-1)?.end ?? 0) + speechToCard + baseEndCard)) : 0;
  const pause = sentences.length > 1 ? Math.min(AD_MAX_PAUSE, slack / (sentences.length - 1)) : 0;
  const endCardLength = Math.min(AD_MAX_END_CARD, baseEndCard + Math.max(0, slack - pause * (sentences.length - 1)));
  // Sentence k is heard k pauses later than in the file.
  let words = sentences.flatMap((s, k) => shiftWords(s, voiceStart + k * pause));
  const speechEnd = words.at(-1)?.end ?? 0;
  const fallbackLength = Math.min(target, Math.max(6, ctx.sources.reduce((sum, s) => sum + Math.min(s.desired, 3), 0)));
  const endCardStart = words.length ? speechEnd + speechToCard : fallbackLength - endCardLength;
  const duration = endCardStart + endCardLength;
  words = words.filter((w) => w.start < endCardStart);

  const sentenceStarts = splitSentences(words)
    .slice(1)
    .map((s) => (s[0] as Word).start - 0.08);
  const bounds = [0, ...sentenceStarts, duration];
  const segments: Segment[] = bounds.slice(0, -1).map((start, k) => ({
    start,
    end: bounds[k + 1] as number,
    first: k,
    // The last sentence runs under the end card; keep it on one shot when the shot is long enough.
    ...(k === bounds.length - 2 ? { maxShot: Math.max(3.2, (bounds[k + 1] as number) - start) } : {}),
  }));
  const clips = fillSegments(ctx, segments, wordGaps(words), { maxShot: 3.2, minShot: 0.7, gain: 0 });

  const productImage = ctx.brief.productImageAssetId && ctx.project.assets.some((a) => a.id === ctx.brief.productImageAssetId) ? ctx.brief.productImageAssetId : undefined;
  const name = ctx.brief.productName ?? ctx.project.name;
  const firstSentenceEnd = splitSentences(words)[0]?.at(-1)?.end ?? 2.6;
  const overlays: Overlay[] = [
    {
      id: "product",
      kind: "title",
      start: 0.25,
      end: Math.max(1.8, Math.min(2.8, firstSentenceEnd + 0.2)),
      text: name,
      ...(ctx.brief.tagline ? { subtext: ctx.brief.tagline } : {}),
    },
    {
      id: "end-card",
      kind: "end_card",
      start: endCardStart,
      end: duration,
      text: name,
      cta: ctx.brief.cta ?? "Shop now",
      ...(ctx.brief.tagline ? { subtext: ctx.brief.tagline } : {}),
      ...(productImage ? { assetId: productImage } : {}),
    },
  ];
  const audio: TimelineAudio[] = [];
  if (song) audio.push(songAudio(song, ctx, 0, duration));
  if (voice && pause > 0) {
    // One trim of the voice file per sentence, each from the middle of the silence before it to the middle of the
    // silence after it, so no word is clipped and the pauses fall where the speaker breathed.
    const cuts = sentences.slice(1).map((s, k) => ((sentences[k]!.at(-1) as Word).end + (s[0] as Word).start) / 2);
    sentences.forEach((_, k) => {
      const from = k === 0 ? 0 : (cuts[k - 1] as number);
      const to = cuts[k];
      audio.push({ assetId: voice.assetId, role: "voice", start: voiceStart + from + k * pause, gain: 1, ...(k > 0 ? { in: from } : {}), ...(to === undefined ? {} : { out: to }) });
    });
  } else if (voice) {
    audio.push({ assetId: voice.assetId, role: "voice", start: voiceStart, gain: 1 });
  }
  return { clips: addDissolves(ctx, clips), audio, words, overlays, markers: [], duration };
}

function planTalkingIntro(ctx: Ctx, voice: VoiceTrack | null, song: SongTrack | null): Planned {
  const voiceStart = 0.4;
  const script = ctx.project.assets.find((a) => a.id === voice?.assetId)?.text ?? ctx.brief.script;
  const words = voice ? shiftWords(voice.words, voiceStart) : script ? estimateWords(script, { start: voiceStart }) : [];
  if (!voice && script) ctx.warnings.push("No voice yet: caption timing is estimated from the script.");
  const speechEnd = words.at(-1)?.end ?? Math.max(4, ctx.sources.reduce((sum, s) => sum + Math.min(s.desired, 4), 0));
  const duration = speechEnd + 1.2;

  // One visual per script line. Lines are mapped onto the timed words by word count; when the counts disagree
  // (the voice was transcribed, not aligned) sentences stand in for lines.
  const lineStarts = scriptLineStarts(script, words);
  const bounds = [0, ...lineStarts.slice(1).map((t) => t - 0.1), duration];
  const segments: Segment[] = bounds.slice(0, -1).map((start, k) => ({ start, end: bounds[k + 1] as number, first: k }));
  const clips = fillSegments(ctx, segments, wordGaps(words), { maxShot: 6, minShot: 1, gain: 0 });

  const overlays: Overlay[] = [];
  let lowerThirdStart = 0.6;
  if (ctx.brief.title) {
    overlays.push({ id: "title", kind: "title", start: 0.2, end: Math.min(2.8, duration * 0.4), text: ctx.brief.title, ...(ctx.brief.subtitle ? { subtext: ctx.brief.subtitle } : {}) });
    lowerThirdStart = 3;
  }
  if (ctx.brief.speakerName) {
    overlays.push({
      id: "speaker",
      kind: "lower_third",
      start: lowerThirdStart,
      end: Math.min(lowerThirdStart + 4, duration - 0.4),
      text: ctx.brief.speakerName,
      ...(ctx.brief.speakerTitle ? { subtext: ctx.brief.speakerTitle } : {}),
    });
  }
  const audio: TimelineAudio[] = [];
  if (song) audio.push(songAudio(song, ctx, 0, duration));
  if (voice) audio.push({ assetId: voice.assetId, role: "voice", start: voiceStart, gain: 1 });
  return { clips: addDissolves(ctx, clips), audio, words, overlays, markers: [], duration };
}

// ---------------------------------------------------------------- shared pieces

function collectSources(project: Project, media: Record<string, MediaInfo>): Source[] {
  return shotSources(project).map(({ shot, asset }) => {
    const info = media[asset.id];
    const kind = asset.kind === "image" || info?.kind === "image" ? "image" : "video";
    const avail = usableLength(info, asset);
    const wanted = shot.durationSec > 0 ? shot.durationSec : kind === "image" ? 4 : avail;
    return { shotId: shot.id, assetId: asset.id, kind, avail, desired: Math.max(0.5, Math.min(wanted, avail)), uses: 0 };
  });
}

/** A clip of `length` seconds from a source. Reused shots start further in, so repeats show something new. */
function clipFor(src: Source, start: number, length: number, gain: number): TimelineClip {
  const len = Math.min(length, src.avail);
  let inPoint = 0;
  if (src.kind === "video" && src.uses > 0) {
    const slack = src.avail - len;
    if (slack > 0.1) inPoint = ((src.uses * 0.618034) % 1) * slack;
  }
  src.uses++;
  return { shotId: src.shotId, assetId: src.assetId, start, in: inPoint, out: inPoint + len, gain };
}

interface Segment {
  start: number;
  end: number;
  /** Which source opens the segment (taken modulo the number of sources). */
  first: number;
  maxShot?: number;
}

/**
 * Fills each segment with shots, starting from its own source. A segment longer than its shot (or than
 * `maxShot`) is split at the word gap nearest an even split, and continues with the next shots.
 */
function fillSegments(ctx: Ctx, segments: Segment[], cutPoints: number[], opts: { maxShot: number; minShot: number; gain: number }): TimelineClip[] {
  const n = ctx.sources.length;
  const clips: TimelineClip[] = [];
  if (n === 0) return clips;
  // Shots a segment's overflow borrowed are not shown again straight away by the next segment.
  let cursor = 0;
  for (const seg of segments) {
    let t = seg.start;
    let index = Math.max(seg.first, cursor);
    for (let guard = 0; seg.end - t > 0.02 && guard < 500; guard++, index++) {
      const src = ctx.sources[index % n] as Source;
      const limit = Math.min(src.avail, seg.maxShot ?? opts.maxShot);
      const remaining = seg.end - t;
      let length: number;
      if (remaining <= limit + 1e-6) {
        length = remaining;
      } else {
        const pieces = Math.ceil(remaining / limit);
        const target = t + remaining / pieces;
        const lo = t + opts.minShot;
        const hi = Math.min(t + limit, seg.end - opts.minShot);
        const candidates = cutPoints.filter((c) => c >= lo && c <= hi);
        const best = candidates.sort((a, b) => Math.abs(a - target) - Math.abs(b - target))[0];
        length = best !== undefined ? best - t : Math.min(limit, Math.max(opts.minShot, remaining - opts.minShot));
      }
      clips.push(clipFor(src, t, length, opts.gain));
      t += length;
      cursor = index + 1;
    }
  }
  return clips;
}

/**
 * Turns hard cuts into dissolves where the style asks for them, using the media on either side of the cut.
 * Centered on the cut when both shots have room, else wholly on the side that does. Timeline length is unchanged.
 */
function addDissolves(ctx: Ctx, clips: TimelineClip[]): TimelineClip[] {
  const d = ctx.style.transition.duration;
  if (d <= 0) return clips;
  const avail = new Map(ctx.sources.map((s) => [s.assetId, s]));
  const out = clips.map((c) => ({ ...c }));
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1] as TimelineClip;
    const b = out[i] as TimelineClip;
    const aSrc = avail.get(a.assetId);
    const bSrc = avail.get(b.assetId);
    if (!aSrc || !bSrc) continue;
    const aRoom = Math.max(0, aSrc.avail - a.out);
    const bRoom = bSrc.kind === "image" ? Infinity : Math.max(0, b.in);
    // As long as asked, or as long as the spare media on both sides allows; too short to read is a cut.
    const dd = Math.min(d, (a.out - a.in) / 2, (b.out - b.in) / 2, aRoom + bRoom);
    if (dd < 0.15) continue;
    const aExtend = Math.min(aRoom, Math.max(dd / 2, dd - bRoom));
    a.out += aExtend;
    extendHead(b, bSrc, dd - aExtend);
  }
  return out;
}

function extendHead(clip: TimelineClip, src: Source, seconds: number): void {
  clip.start -= seconds;
  if (src.kind === "image") clip.out += seconds;
  else clip.in -= seconds;
}

function songAudio(song: SongTrack, ctx: Ctx, start: number, duration: number, songStart = 0): TimelineAudio {
  const length = ctx.media[song.assetId]?.durationSec ?? Infinity;
  return { assetId: song.assetId, role: "music", start, gain: 1, in: songStart, out: Math.min(length, songStart + duration) };
}

function titleOverlay(ctx: Ctx, duration: number): Overlay[] {
  return [
    {
      id: "title",
      kind: "title",
      start: Math.min(0.4, duration * 0.1),
      end: Math.min(4, Math.max(1.5, duration * 0.25)),
      text: ctx.brief.title ?? ctx.project.name,
      ...(ctx.brief.artist ? { subtext: ctx.brief.artist } : {}),
    },
  ];
}

function scriptLineStarts(script: string | undefined, words: Word[]): number[] {
  if (words.length === 0) return [0];
  // Words timed from the script carry its line breaks; transcribed ones fall back to sentences.
  if (words.some((w) => w.lineEnd)) {
    const starts = [(words[0] as Word).start];
    words.forEach((w, i) => {
      if (w.lineEnd && words[i + 1]) starts.push((words[i + 1] as Word).start);
    });
    return starts;
  }
  const lines = (script ?? "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const counts = lines.map((l) => tokenizeText(l).length);
  if (lines.length > 1 && counts.reduce((a, b) => a + b, 0) === words.length) {
    const starts: number[] = [];
    let k = 0;
    for (const count of counts) {
      starts.push((words[k] as Word).start);
      k += count;
    }
    return starts;
  }
  return splitSentences(words).map((s) => (s[0] as Word).start);
}

/** Midpoints of the pauses between words: where a cut inside a sentence is least noticeable. */
function wordGaps(words: Word[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1] as Word;
    const next = words[i] as Word;
    gaps.push((prev.end + next.start) / 2);
  }
  return gaps;
}

function shiftWords(words: readonly Word[], offset: number): Word[] {
  return words.map((w) => ({ ...w, start: round3(w.start + offset), end: round3(w.end + offset) }));
}

function roundClip(c: TimelineClip): TimelineClip {
  return { ...c, start: round3(c.start), in: round3(Math.max(0, c.in)), out: round3(c.out) };
}

function medianGap(times: number[]): number | null {
  if (times.length < 2) return null;
  const gaps = times.slice(1).map((t, i) => t - (times[i] as number)).sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] as number;
}

function nearest(times: number[], target: number, within: number): number | undefined {
  let best: number | undefined;
  for (const t of times) if (Math.abs(t - target) <= within && (best === undefined || Math.abs(t - target) < Math.abs(best - target))) best = t;
  return best;
}

function closeTo(times: number[], tolerance: number): (t: number) => boolean {
  return (t) => times.some((x) => Math.abs(x - t) <= tolerance);
}

