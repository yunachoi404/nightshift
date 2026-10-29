import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Span } from "../audio/activity.js";
import { decodePcm, writeWav } from "../media/ffmpeg.js";
import { run } from "../media/process.js";
import type { ResolvedTools } from "../media/tools.js";
import { round3, type Word } from "./words.js";

export interface TranscribeOptions {
  /** ISO language code, or "auto". Default "en". */
  language?: string;
  /** Text whisper should expect (names, product words). Biases recognition; it is not forced. */
  prompt?: string;
  /** Songs: suppress non-speech tokens and drop the usual hallucinations on instrumental parts. */
  lyrics?: boolean;
  threads?: number;
  signal?: AbortSignal;
}

interface WhisperToken {
  text: string;
  offsets: { from: number; to: number };
  p: number;
}

interface WhisperJson {
  transcription: { text: string; offsets: { from: number; to: number }; tokens?: WhisperToken[] }[];
}

/** Things whisper writes over music or silence that nobody said. */
const HALLUCINATIONS = [/thank(s| you) for watching/i, /^\s*(thank you\.?|you)\s*$/i, /subtitles? by/i, /amara\.org/i, /^\s*[♪♫\s]*$/];

/**
 * Speech recognition with word times, through whisper.cpp's CLI. Runs on CUDA (DGX Spark), Metal (Apple
 * Silicon) or CPU, whichever whisper.cpp was built with.
 *
 * Speech is transcribed in one pass. Songs go phrase by phrase: Silero VAD finds where someone sings, each
 * phrase is transcribed on its own, and its words are placed back at the phrase's time. Whole-song passes drift
 * by seconds over the instrumental parts.
 */
export async function transcribeWords(tools: ResolvedTools, audioPath: string, options: TranscribeOptions = {}): Promise<Word[]> {
  if (!tools.whisper) throw new Error("whisper.cpp (whisper-cli) was not found. Install it (brew install whisper-cpp) or set NIGHTSHIFT_WHISPER.");
  if (!tools.whisperModel) throw new Error("No whisper model was found. Download one with downloadWhisperModels() or set NIGHTSHIFT_WHISPER_MODEL.");
  const dir = await mkdtemp(join(tmpdir(), "nightshift-whisper-"));
  try {
    const wav = join(dir, "audio.wav");
    await run(tools.ffmpeg, ["-v", "error", "-nostdin", "-y", "-i", audioPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], { signal: options.signal });
    if (options.lyrics && tools.whisperVad && tools.vadModel) return await transcribePhrases(tools, wav, dir, options);
    const args = [...baseArgs(tools.whisperModel, options), "-f", wav, "-of", join(dir, "out")];
    if (options.prompt) args.push("--prompt", truncateWords(options.prompt, 120));
    await run(tools.whisper, args, { signal: options.signal });
    const json = JSON.parse(await readFile(join(dir, "out.json"), "utf8")) as WhisperJson;
    return wordsFromWhisper(json, options.lyrics ?? false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function baseArgs(model: string, options: TranscribeOptions): string[] {
  const args = [
    "-m", model,
    "-l", options.language ?? "en",
    "-ojf",
    "-np",
    // Flash attention moves token timestamps by up to a few hundred ms; without it they land on the speech.
    "-nfa",
    "-t", String(options.threads ?? 4),
  ];
  if (options.lyrics) args.push("-sns");
  return args;
}

async function transcribePhrases(tools: ResolvedTools, wav: string, dir: string, options: TranscribeOptions): Promise<Word[]> {
  const { stdout } = await run(tools.whisperVad as string, ["-vm", tools.vadModel as string, "-f", wav, "-np"], { signal: options.signal });
  const phrases = phraseWindows(parseVadSegments(stdout.toString("utf8")));
  if (phrases.length === 0) return [];
  const pcm = await decodePcm(tools, wav, { sampleRate: 16_000, channels: 1, signal: options.signal });
  const samples = pcm.channels[0] as Float32Array;
  const files: string[] = [];
  for (const [i, phrase] of phrases.entries()) {
    const file = join(dir, `phrase-${i}.wav`);
    const from = Math.floor(phrase.start * 16_000);
    const to = Math.min(samples.length, Math.ceil(phrase.end * 16_000));
    await writeWav(file, { sampleRate: 16_000, channels: [samples.slice(from, to)] }, 16);
    files.push(file);
  }
  // One run for every phrase, so the model loads once. whisper.cpp writes <file>.json beside each input.
  await run(tools.whisper as string, [...baseArgs(tools.whisperModel as string, options), ...files], { signal: options.signal });
  const words: Word[] = [];
  for (const [i, file] of files.entries()) {
    const json = JSON.parse(await readFile(`${file}.json`, "utf8")) as WhisperJson;
    const phrase = phrases[i] as Phrase;
    for (const w of wordsFromWhisper(json, true)) {
      // whisper starts a clip's first word at the clip's start; the voice itself starts where VAD heard it.
      const start = Math.max(w.start + phrase.start, phrase.voiceStart - 0.03);
      const end = Math.min(Math.max(w.end + phrase.start, start + 0.05), phrase.voiceEnd + 0.15);
      words.push({ ...w, start: round3(start), end: round3(Math.max(end, start + 0.05)) });
    }
  }
  return words;
}

/** Speech segments from `whisper-vad-speech-segments` (it prints centiseconds). Exported for tests. */
export function parseVadSegments(output: string): Span[] {
  const spans: Span[] = [];
  for (const m of output.matchAll(/start\s*=\s*([\d.]+),\s*end\s*=\s*([\d.]+)/g)) spans.push({ start: Number(m[1]) / 100, end: Number(m[2]) / 100 });
  return spans;
}

/** A clip to transcribe: padded, with where the voice inside it starts and ends. */
export interface Phrase extends Span {
  voiceStart: number;
  voiceEnd: number;
}

/** Joins close segments into phrases, pads them, and keeps each within whisper's 30 s window. */
export function phraseWindows(segments: readonly Span[], gap = 0.6, pad = 0.25, max = 28): Phrase[] {
  const merged: Span[] = [];
  for (const s of segments) {
    const last = merged.at(-1);
    if (last && s.start - last.end < gap && s.end - last.start <= max) last.end = s.end;
    else merged.push({ ...s });
  }
  const out: Phrase[] = [];
  for (const s of merged) {
    for (let t = s.start; t < s.end; t += max) {
      const end = Math.min(s.end, t + max);
      out.push({ start: Math.max(0, t - pad), end: end + pad, voiceStart: t, voiceEnd: end });
    }
  }
  return out;
}

/** Merges whisper's sub-word tokens into words. Exported for tests. */
export function wordsFromWhisper(json: WhisperJson, lyrics: boolean): Word[] {
  const words: Word[] = [];
  for (const segment of json.transcription) {
    if (lyrics && HALLUCINATIONS.some((re) => re.test(segment.text))) continue;
    let current: (Word & { probs: number[] }) | null = null;
    const flush = () => {
      if (current && /[\p{L}\p{N}]/u.test(current.text)) {
        const p = current.probs.reduce((a, b) => a + b, 0) / current.probs.length;
        words.push({ text: current.text.trim(), start: current.start, end: current.end, p: Math.round(p * 1000) / 1000 });
      }
      current = null;
    };
    for (const token of segment.tokens ?? []) {
      if (/^\[_.*\]$/.test(token.text) || /^<\|.*\|>$/.test(token.text)) continue;
      const start = token.offsets.from / 1000;
      const end = token.offsets.to / 1000;
      const startsWord = /^\s/.test(token.text);
      const isPunctuation = !/[\p{L}\p{N}]/u.test(token.text);
      if (!current || (startsWord && !isPunctuation)) {
        flush();
        current = { text: token.text.trimStart(), start, end, probs: [token.p] };
      } else {
        current.text += token.text.trimStart() === token.text ? token.text : token.text.trim();
        current.end = Math.max(current.end, end);
        if (!isPunctuation) current.probs.push(token.p);
      }
    }
    flush();
  }
  return words;
}

function truncateWords(text: string, max: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  return words.slice(0, max).join(" ");
}
