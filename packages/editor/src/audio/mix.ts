import { loudness } from "@hyperframes/core/audio-analysis";
import { decodePcm, type Pcm } from "../media/ffmpeg.js";
import type { ResolvedTools } from "../media/tools.js";
import type { TimelineStyle } from "../style.js";
import { soundSpans, type Span } from "./activity.js";

export type StemRole = "voice" | "music" | "sfx" | "clip";

/** One piece of sound on the timeline. */
export interface Stem {
  path: string;
  role: StemRole;
  /** Timeline second the stem starts at. */
  start: number;
  /** Seconds into the source. */
  in: number;
  /** Where to stop in the source (default: its end). */
  out?: number;
  /** Linear gain applied after the role's loudness target. 1 = the template's level. */
  gain: number;
  /** Source length, to know whether the stem was cut short (and needs a fade). */
  sourceDuration?: number;
}

export interface MixReport {
  /** Integrated loudness per bus after levelling, and of the master. null = silent. */
  lufs: { voice: number | null; music: number | null; clip: number | null; master: number | null };
  /** Where the music ducks for speech, timeline seconds. */
  ducked: Span[];
}

export interface MixResult {
  pcm: Pcm;
  report: MixReport;
}

const RATE = 48_000;

/**
 * Mixes the timeline's sound: each role levelled to its loudness target (voice, music, clips), music and clip
 * sound ducked under speech with a look-ahead envelope, fades where songs are cut, then the master set to the
 * target loudness. The exporter limits peaks and encodes the result.
 */
export async function mixAudio(tools: Pick<ResolvedTools, "ffmpeg">, stems: readonly Stem[], duration: number, style: TimelineStyle["audio"], signal?: AbortSignal): Promise<MixResult> {
  const frames = Math.max(1, Math.round(duration * RATE));
  const active = stems.filter((s) => s.gain > 0 && s.start < duration);
  const decoded = await Promise.all(
    active.map(async (stem) => {
      const room = duration - stem.start;
      const length = Math.min(room, (stem.out ?? Infinity) - stem.in);
      const pcm = await decodePcm(tools, stem.path, { sampleRate: RATE, channels: 2, start: stem.in, ...(Number.isFinite(length) ? { duration: length } : { duration: room }), signal });
      return { stem, pcm, cutShort: isCutShort(stem, duration) };
    }),
  );

  const busOf = (role: StemRole) => (role === "sfx" ? "clip" : role) as "voice" | "music" | "clip";
  const build = (bus: "voice" | "music" | "clip", withGains: boolean): Pcm | null => {
    const members = decoded.filter((d) => busOf(d.stem.role) === bus);
    if (members.length === 0) return null;
    const out = silence(frames);
    for (const { stem, pcm, cutShort } of members) {
      const fadeIn = bus === "music" ? (stem.in > 0.5 ? style.musicFadeIn : 0) : 0.012;
      const fadeOut = bus === "music" ? (cutShort ? style.musicFadeOut : 0) : 0.012;
      place(out, pcm, stem.start, withGains ? stem.gain : 1, fadeIn, fadeOut);
    }
    return out;
  };

  const voiceRaw = build("voice", false);
  const hasVoice = voiceRaw !== null && measure(voiceRaw) !== null;
  const targets = { voice: style.voiceLufs, music: hasVoice ? style.bedLufs : style.musicLufs, clip: style.clipLufs };
  const buses: Record<"voice" | "music" | "clip", Pcm | null> = { voice: null, music: null, clip: null };
  const lufs: MixReport["lufs"] = { voice: null, music: null, clip: null, master: null };
  for (const bus of ["voice", "music", "clip"] as const) {
    const raw = bus === "voice" ? voiceRaw : build(bus, false);
    if (!raw) continue;
    const measured = measure(raw);
    if (measured === null) continue;
    // Level from the unity mix, so a user's gain on one stem is not undone by the levelling.
    const levelDb = clamp(targets[bus] - measured, -30, 12);
    const withGains = build(bus, true) as Pcm;
    scale(withGains, dbToGain(levelDb));
    buses[bus] = withGains;
    lufs[bus] = measure(withGains);
  }

  // Duck music and clip sound wherever the voice speaks, starting a little before each phrase. Where nobody speaks
  // for a while (the tail of an ad, a long pause) the bed rises towards the song's full level.
  let ducked: Span[] = [];
  if (buses.voice) {
    ducked = soundSpans(buses.voice, { minSilence: 0.45, minSound: 0.08 });
    const lift = dbToGain(clamp(style.musicLufs - style.bedLufs, 0, 8));
    const envelope = multiply(duckEnvelope(ducked, duration, dbToGain(style.duckDb), 0.15, 0.45), liftEnvelope(ducked, duration, lift));
    if (buses.music) applyEnvelope(buses.music, envelope);
    if (buses.clip) applyEnvelope(buses.clip, duckEnvelope(ducked, duration, dbToGain(style.duckDb / 2), 0.15, 0.45));
  }

  const master = silence(frames);
  for (const bus of Object.values(buses)) if (bus) mixInto(master, bus);
  const masterLufs = measure(master);
  if (masterLufs !== null) {
    scale(master, dbToGain(clamp(style.targetLufs - masterLufs, -20, 12)));
    lufs.master = measure(master);
  }
  return { pcm: master, report: { lufs, ducked } };
}

function isCutShort(stem: Stem, duration: number): boolean {
  const naturalEnd = stem.sourceDuration ?? Infinity;
  const out = Math.min(stem.out ?? naturalEnd, stem.in + (duration - stem.start));
  return out < naturalEnd - 0.5;
}

/** Gain over time at 100 Hz: 1 in the clear, `duck` under speech, with an early attack and a slow release. */
export function duckEnvelope(speech: readonly Span[], duration: number, duck: number, attack: number, release: number): Float32Array {
  const rate = 100;
  const n = Math.max(1, Math.ceil(duration * rate) + 1);
  const env = new Float32Array(n).fill(1);
  for (const s of speech) {
    const from = s.start - attack;
    const to = s.end + release;
    for (let i = Math.max(0, Math.floor(from * rate)); i < Math.min(n, Math.ceil(to * rate)); i++) {
      const t = i / rate;
      let g = duck;
      if (t < s.start) g = 1 + (duck - 1) * smooth((t - from) / attack);
      else if (t > s.end) g = duck + (1 - duck) * smooth((t - s.end) / release);
      env[i] = Math.min(env[i] as number, g);
    }
  }
  return env;
}

/**
 * Gain over time at 100 Hz: `lift` through stretches of at least `minGap` seconds without speech (and after the
 * last phrase), 1 elsewhere. Rises 0.4 s after speech stops, falls back before it starts again.
 */
export function liftEnvelope(speech: readonly Span[], duration: number, lift: number, minGap = 2): Float32Array {
  const rate = 100;
  const n = Math.max(1, Math.ceil(duration * rate) + 1);
  const env = new Float32Array(n).fill(1);
  if (lift <= 1 || speech.length === 0) return env;
  const gaps: Span[] = [];
  for (let i = 0; i < speech.length; i++) {
    const end = (speech[i] as Span).end;
    const next = speech[i + 1]?.start ?? Infinity;
    if (next - end >= minGap) gaps.push({ start: end + 0.4, end: Math.min(next - 0.5, duration + 1) });
  }
  const ramp = 0.8;
  for (const g of gaps) {
    for (let i = Math.max(0, Math.floor(g.start * rate)); i < Math.min(n, Math.ceil(g.end * rate)); i++) {
      const t = i / rate;
      const up = smooth((t - g.start) / ramp);
      const down = Number.isFinite(g.end) && g.end < duration ? smooth((g.end - t) / ramp) : 1;
      env[i] = 1 + (lift - 1) * Math.min(up, down);
    }
  }
  return env;
}

function multiply(a: Float32Array, b: Float32Array): Float32Array {
  return a.map((v, i) => v * (b[i] ?? 1));
}

function smooth(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}

function applyEnvelope(pcm: Pcm, env: Float32Array): void {
  const rate = 100;
  const length = pcm.channels[0]?.length ?? 0;
  for (let i = 0; i < length; i++) {
    const pos = (i / pcm.sampleRate) * rate;
    const k = Math.floor(pos);
    const a = env[Math.min(k, env.length - 1)] as number;
    const b = env[Math.min(k + 1, env.length - 1)] as number;
    const g = a + (b - a) * (pos - k);
    for (const ch of pcm.channels) ch[i] = (ch[i] as number) * g;
  }
}

function place(target: Pcm, source: Pcm, startSec: number, gain: number, fadeIn: number, fadeOut: number): void {
  const offset = Math.round(startSec * RATE);
  const length = source.channels[0]?.length ?? 0;
  const fin = Math.round(fadeIn * RATE);
  const fout = Math.round(fadeOut * RATE);
  for (let c = 0; c < target.channels.length; c++) {
    const out = target.channels[c] as Float32Array;
    const src = (source.channels[c] ?? source.channels[0]) as Float32Array;
    for (let i = 0; i < length; i++) {
      const j = offset + i;
      if (j < 0) continue;
      if (j >= out.length) break;
      let g = gain;
      if (fin > 0 && i < fin) g *= i / fin;
      if (fout > 0 && i > length - fout) g *= (length - i) / fout;
      out[j] = (out[j] as number) + (src[i] as number) * g;
    }
  }
}

function mixInto(target: Pcm, source: Pcm): void {
  for (let c = 0; c < target.channels.length; c++) {
    const out = target.channels[c] as Float32Array;
    const src = source.channels[c] as Float32Array;
    for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) + (src[i] as number);
  }
}

function scale(pcm: Pcm, gain: number): void {
  for (const ch of pcm.channels) for (let i = 0; i < ch.length; i++) ch[i] = (ch[i] as number) * gain;
}

function silence(frames: number): Pcm {
  return { sampleRate: RATE, channels: [new Float32Array(frames), new Float32Array(frames)] };
}

/** Integrated loudness (ITU-R BS.1770, gated), or null for silence. */
export function measure(pcm: Pcm): number | null {
  return loudness(pcm).lufsIntegrated;
}

function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}
