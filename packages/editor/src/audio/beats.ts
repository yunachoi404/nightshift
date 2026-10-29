import { rhythm, sections, tempoOf } from "@hyperframes/core/audio-analysis";
import { decodePcm, type Pcm } from "../media/ffmpeg.js";
import type { RunOptions } from "../media/process.js";
import { resolveTools, type ToolOverrides } from "../media/tools.js";

/** The rhythm of a song, in seconds from the start of the file. */
export interface BeatMap {
  durationSec: number;
  /** null when the song has no steady beat. */
  bpm: number | null;
  /** 0..1: how sure the tracker is that the beats are the music's. */
  confidence: number;
  beats: number[];
  /** The first beat of each bar. Empty when the meter could not be told. */
  downbeats: number[];
  /** Beats per bar (3 or 4), or null. */
  meter: number | null;
  /** Where the music changes (verse, chorus...). Sections that sound alike share a label. */
  sections: { start: number; end: number; label: string }[];
}

export interface AnalyzeBeatsOptions extends RunOptions {
  tools?: ToolOverrides;
}

/** Beat, bar and section analysis of an audio file. Pure signal processing (HyperFrames' tracker), no model. */
export async function analyzeBeats(path: string, options: AnalyzeBeatsOptions = {}): Promise<BeatMap> {
  const tools = resolveTools(options.tools);
  const pcm = await decodePcm(tools, path, { sampleRate: 22_050, channels: 1, signal: options.signal });
  return analyzeBeatsFromPcm(pcm);
}

export function analyzeBeatsFromPcm(pcm: Pcm): BeatMap {
  const durationSec = (pcm.channels[0]?.length ?? 0) / pcm.sampleRate;
  if (durationSec < 2) return { durationSec, bpm: null, confidence: 0, beats: [], downbeats: [], meter: null, sections: [] };
  const { beats, downbeats } = rhythm(pcm);
  const spans = beats.times.length > 0 ? sections(pcm).spans : [{ start: 0, end: durationSec, label: "A" }];
  return {
    durationSec,
    bpm: beats.times.length > 1 ? round(tempoOf(beats.times).value ?? 0, 2) || null : null,
    confidence: round(beats.confidence ?? 0, 3),
    beats: beats.times.map((t) => round(t, 4)),
    downbeats: downbeats.times.map((t) => round(t, 4)),
    meter: downbeats.meter,
    sections: spans.map((s) => ({ start: round(s.start, 4), end: round(s.end, 4), label: s.label })),
  };
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
