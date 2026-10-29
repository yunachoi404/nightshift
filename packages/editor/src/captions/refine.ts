import { gapsBetween, type Span } from "../audio/activity.js";
import { endsClause, endsSentence, tidyWords, type Word } from "./words.js";

/**
 * Pulls word edges out of silences: a word cannot start or end while nothing is heard. Recognizer timestamps drift
 * by up to a few hundred ms; the silences of a clean voice track are exact.
 */
export function snapWordsToSound(words: readonly Word[], sound: readonly Span[], maxShift = 0.35): Word[] {
  if (sound.length === 0) return [...words];
  const out = words.map((w) => ({ ...w }));
  for (const w of out) {
    const startSpan = spanContainingOrAfter(sound, w.start);
    // Start inside a silence: move it to where the sound resumes.
    if (startSpan && startSpan.start > w.start && startSpan.start - w.start <= maxShift && startSpan.start < w.end) w.start = startSpan.start;
    const endSpan = spanContainingOrBefore(sound, w.end);
    // End inside a silence: move it back to where the sound stopped.
    if (endSpan && endSpan.end < w.end && w.end - endSpan.end <= maxShift && endSpan.end > w.start) w.end = endSpan.end;
  }
  // A word that opens a burst of sound starts with it (whisper often starts words late after a pause).
  for (let i = 0; i < out.length; i++) {
    const w = out[i] as Word;
    const span = sound.find((s) => s.start <= w.start + 1e-6 && w.start < s.end);
    if (!span) continue;
    const prev = out[i - 1];
    const prevInSpan = prev !== undefined && prev.end > span.start;
    if (!prevInSpan && w.start - span.start <= maxShift) w.start = span.start;
  }
  // The first word of a sentence often comes back from whisper glued to the end of the sentence before it, ahead
  // of the pause. If a silence separates it from the word after it, it was said after that silence.
  const silences = gapsBetween(sound, Infinity).filter((g) => g.end - g.start >= 0.08 && Number.isFinite(g.end));
  for (let i = 0; i < out.length - 1; i++) {
    const w = out[i] as Word;
    const prev = out[i - 1];
    const next = out[i + 1] as Word;
    if (!prev || (!endsSentence(prev.text) && !endsClause(prev.text)) || w.start - prev.end > 0.05) continue;
    const gap = silences.find((g) => g.start >= w.start - 0.02 && g.end <= next.start + 0.05 && g.end > w.start);
    if (!gap) continue;
    const length = Math.max(0.08, Math.min(w.end - w.start, next.start - gap.end));
    w.start = gap.end;
    w.end = gap.end + length;
    if (next.start < w.end) next.start = w.end;
  }
  // The words come in the order they were said. Moving one can leave it starting after the next (a sentence start
  // pushed past its pause), and sorting by time would then swap them in the captions.
  return tidyWords(out, undefined, "given");
}

function spanContainingOrAfter(spans: readonly Span[], t: number): Span | undefined {
  return spans.find((s) => s.end > t);
}

function spanContainingOrBefore(spans: readonly Span[], t: number): Span | undefined {
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i] as Span;
    if (s.start < t) return s;
  }
  return undefined;
}
