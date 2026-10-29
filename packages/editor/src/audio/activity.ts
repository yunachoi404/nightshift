import type { Pcm } from "../media/ffmpeg.js";

export interface Span {
  start: number;
  end: number;
}

export interface ActivityOptions {
  /** Analysis hop, seconds. */
  hop?: number;
  /** Frames quieter than the loud end (95th percentile) by this many dB count as silence. */
  relativeDb?: number;
  /** Absolute floor in dBFS: anything quieter is silence regardless. */
  floorDb?: number;
  /** Shorter silences are bridged (they are gaps between syllables, not pauses). */
  minSilence?: number;
  /** Shorter bursts are dropped (clicks, breaths). */
  minSound?: number;
}

/** Where a recording has sound: spans in seconds. Built for voice tracks (TTS is clean, so this is precise). */
export function soundSpans(pcm: Pcm, options: ActivityOptions = {}): Span[] {
  const hop = options.hop ?? 0.01;
  const db = envelopeDb(pcm, hop);
  if (db.length === 0) return [];
  const sorted = Float32Array.from(db).sort();
  const loud = sorted[Math.floor(sorted.length * 0.95)] as number;
  const threshold = Math.max(options.floorDb ?? -55, loud + (options.relativeDb ?? -30));
  const raw: Span[] = [];
  let open: number | null = null;
  for (let i = 0; i < db.length; i++) {
    const on = (db[i] as number) >= threshold;
    if (on && open === null) open = i;
    if (!on && open !== null) {
      raw.push({ start: open * hop, end: i * hop });
      open = null;
    }
  }
  if (open !== null) raw.push({ start: open * hop, end: db.length * hop });
  const minSilence = options.minSilence ?? 0.08;
  const minSound = options.minSound ?? 0.05;
  const bridged: Span[] = [];
  for (const span of raw) {
    const last = bridged.at(-1);
    if (last && span.start - last.end < minSilence) last.end = span.end;
    else bridged.push({ ...span });
  }
  return bridged.filter((s) => s.end - s.start >= minSound);
}

/** The silences between `spans`, inside [0, duration]. */
export function gapsBetween(spans: readonly Span[], duration: number): Span[] {
  const gaps: Span[] = [];
  let t = 0;
  for (const s of spans) {
    if (s.start > t) gaps.push({ start: t, end: s.start });
    t = Math.max(t, s.end);
  }
  if (t < duration) gaps.push({ start: t, end: duration });
  return gaps;
}

/** RMS level per hop in dBFS, all channels mixed. */
export function envelopeDb(pcm: Pcm, hop: number): Float32Array {
  const length = pcm.channels[0]?.length ?? 0;
  const step = Math.max(1, Math.round(hop * pcm.sampleRate));
  const window = step * 2;
  const frames = Math.ceil(length / step);
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const from = Math.max(0, f * step - step / 2);
    const to = Math.min(length, from + window);
    let sum = 0;
    for (const channel of pcm.channels) {
      for (let i = from; i < to; i++) {
        const s = channel[i] as number;
        sum += s * s;
      }
    }
    const meanSquare = sum / Math.max(1, (to - from) * pcm.channels.length);
    out[f] = meanSquare > 0 ? 10 * Math.log10(meanSquare) : -120;
  }
  return out;
}
