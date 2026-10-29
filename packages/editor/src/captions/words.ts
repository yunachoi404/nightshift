/** A spoken (or sung) word with its time in seconds. `text` keeps punctuation for display. */
export interface Word {
  text: string;
  start: number;
  end: number;
  /** Recognition confidence 0..1, when the word came from speech recognition. */
  p?: number;
  /** The last word of a line of the known text (a lyric line, a script line). Captions and cuts break here. */
  lineEnd?: boolean;
}

/** Lowercase letters and digits only: the form words are compared in. */
export function normalizeWord(text: string): string {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Splits text into display words. Section labels like "[Chorus]" and stray punctuation are dropped or glued to
 * the word before them, so every returned word has something to say out loud.
 */
export function tokenizeText(text: string): string[] {
  const cleaned = text.replace(/\[[^\]]*\]|\{[^}]*\}/g, " ").replace(/\((?:x\s*\d+|\d+\s*x|repeat)\)/gi, " ");
  const out: string[] = [];
  for (const raw of cleaned.split(/\s+/)) {
    const word = raw.trim();
    if (!word) continue;
    if (normalizeWord(word) === "") {
      if (out.length > 0 && /^[.,!?;:…'")\]]+$/.test(word)) out[out.length - 1] += word;
      continue;
    }
    out.push(word);
  }
  return out;
}

/** Display words per line of text. Empty lines are dropped. */
export function tokenizeLines(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map(tokenizeText)
    .filter((line) => line.length > 0);
}

/** Marks the words that end a line, given the token count of each line. Counts that do not add up change nothing. */
export function markLineEnds(words: Word[], lineLengths: readonly number[]): Word[] {
  if (lineLengths.length < 2 || lineLengths.reduce((a, b) => a + b, 0) !== words.length) return words;
  let k = 0;
  const ends = new Set<number>();
  for (const length of lineLengths) {
    k += length;
    ends.add(k - 1);
  }
  return words.map((w, i) => (ends.has(i) ? { ...w, lineEnd: true } : w));
}

export function endsSentence(text: string): boolean {
  return /[.!?…]["')\]]*$/.test(text);
}

export function endsClause(text: string): boolean {
  return /[,;:\-–]["')\]]*$/.test(text);
}

/**
 * Keeps words ordered, non-overlapping and at least `minSec` long, without moving them more than needed. `order` is
 * "time" to sort by start (recognized words from several passes), or "given" when the list is already the order
 * the words were said in (a script aligned to the audio).
 */
export function tidyWords(words: Word[], minSec = 0.04, order: "time" | "given" = "time"): Word[] {
  const copies = words.map((w) => ({ ...w }));
  const out = order === "time" ? copies.sort((a, b) => a.start - b.start) : copies;
  for (let i = 0; i < out.length; i++) {
    const w = out[i] as Word;
    const prev = out[i - 1];
    if (prev && w.start < prev.end) {
      // Overlap: meet in the middle, but never let the earlier word end before it starts.
      const mid = Math.max(prev.start + minSec, (prev.end + w.start) / 2);
      prev.end = mid;
      w.start = Math.max(w.start, mid);
    }
    if (w.end < w.start + minSec) w.end = w.start + minSec;
  }
  return out.map((w) => ({ ...w, start: round3(w.start), end: round3(w.end) }));
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
