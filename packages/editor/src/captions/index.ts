import type { Caption } from "@nightshift/contract";
import { soundSpans } from "../audio/activity.js";
import { decodePcm, probeMedia } from "../media/ffmpeg.js";
import { resolveTools, type ResolvedTools, type ToolOverrides } from "../media/tools.js";
import { alignText } from "./align.js";
import { estimateWords, groupCaptions, shiftCaptions, type GroupOptions } from "./group.js";
import { snapWordsToSound } from "./refine.js";
import { transcribeWords } from "./whisper.js";
import { markLineEnds, tokenizeLines, tokenizeText, type Word } from "./words.js";

export interface AlignCaptionsOptions {
  /** The voice or song. Without it, timing is estimated from the text. */
  audioPath?: string;
  /** The words, when known (TTS input, lyrics). Without it, the audio is transcribed. */
  text?: string;
  /** speech: voiceover, clean. lyrics: sung over music. */
  kind?: "speech" | "lyrics";
  language?: string;
  /** Seconds added to every time, e.g. where the audio sits on the timeline. */
  offset?: number;
  group?: GroupOptions;
  tools?: ToolOverrides;
  signal?: AbortSignal;
}

export interface AlignedCaptions {
  /** aligned: known text timed by recognition. transcribed: recognized words. estimated: timed from text length. */
  method: "aligned" | "transcribed" | "estimated" | "none";
  words: Word[];
  captions: Caption[];
  warnings: string[];
}

/**
 * Word-timed captions for a voice or a song. Known text is force-aligned to the audio (whisper.cpp for the times,
 * the text for the words, then edges snapped to the silences for speech). Unknown text is transcribed.
 * Without audio, or without whisper, word times are estimated so the timeline still lays out.
 */
export async function alignCaptions(options: AlignCaptionsOptions): Promise<AlignedCaptions> {
  const tools = resolveTools(options.tools);
  const kind = options.kind ?? "speech";
  const warnings: string[] = [];
  const known = options.text ? tokenizeText(options.text) : [];
  const finish = (method: AlignedCaptions["method"], words: Word[]): AlignedCaptions => {
    const captions = shiftCaptions(groupCaptions(words, options.group), options.offset ?? 0);
    const shifted = words.map((w) => ({ ...w, start: w.start + (options.offset ?? 0), end: w.end + (options.offset ?? 0) }));
    return { method, words: shifted, captions, warnings };
  };

  if (!options.audioPath) {
    if (known.length === 0) return { method: "none", words: [], captions: [], warnings };
    return finish("estimated", estimateWords(options.text ?? ""));
  }

  const canRecognize = Boolean(tools.whisper && tools.whisperModel);
  if (!canRecognize) {
    warnings.push(tools.whisper ? "No whisper model found: caption timing is estimated." : "whisper.cpp not found: caption timing is estimated.");
    if (known.length === 0) return { method: "none", words: [], captions: [], warnings };
    return finish("estimated", await estimateFromAudio(tools, options.audioPath, options.text ?? "", options.signal));
  }

  const recognized = await transcribeWords(tools, options.audioPath, {
    language: options.language,
    lyrics: kind === "lyrics",
    prompt: options.text,
    signal: options.signal,
  });

  if (known.length === 0) {
    if (recognized.length === 0) return { method: "none", words: [], captions: [], warnings };
    const words = kind === "speech" ? await snapToVoice(tools, options.audioPath, recognized, options.signal) : recognized;
    return finish("transcribed", words);
  }

  if (recognized.length === 0) {
    warnings.push("Nothing was recognized in the audio: caption timing is estimated.");
    return finish("estimated", await estimateFromAudio(tools, options.audioPath, options.text ?? "", options.signal));
  }

  const alignment = alignText(known, recognized);
  // Songs repeat lines the lyrics sheet writes once. If most of what was sung finds no lyric, show what was sung.
  if (kind === "lyrics" && alignment.recognizedCoverage < 0.6 && recognized.length > known.length * 1.2) {
    warnings.push(`Lyrics matched ${Math.round(alignment.recognizedCoverage * 100)}% of the sung words: showing the transcription.`);
    return finish("transcribed", recognized);
  }
  if (alignment.coverage < 0.5) {
    warnings.push(`Only ${Math.round(alignment.coverage * 100)}% of the text was heard in the audio. Check that the audio matches the text.`);
  }
  const timed = markLineEnds(alignment.words, tokenizeLines(options.text ?? "").map((l) => l.length));
  const words = kind === "speech" ? await snapToVoice(tools, options.audioPath, timed, options.signal) : timed;
  return finish("aligned", words);
}

async function snapToVoice(tools: ResolvedTools, audioPath: string, words: Word[], signal?: AbortSignal): Promise<Word[]> {
  const pcm = await decodePcm(tools, audioPath, { sampleRate: 16_000, channels: 1, signal });
  return snapWordsToSound(words, soundSpans(pcm));
}

/** Estimated timing, fitted to where the audio actually has sound. */
async function estimateFromAudio(tools: ResolvedTools, audioPath: string, text: string, signal?: AbortSignal): Promise<Word[]> {
  const pcm = await decodePcm(tools, audioPath, { sampleRate: 16_000, channels: 1, signal });
  const spans = soundSpans(pcm);
  const info = await probeMedia(tools, audioPath, { signal });
  const start = spans[0]?.start ?? 0;
  const end = spans.at(-1)?.end ?? info.durationSec;
  return estimateWords(text, { start, end: Math.max(end, start + 0.5) });
}
