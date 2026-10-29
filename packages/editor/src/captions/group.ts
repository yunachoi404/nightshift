import type { Caption } from "@nightshift/contract";
import { endsClause, endsSentence, markLineEnds, normalizeWord, round3, tokenizeLines, tokenizeText, type Word } from "./words.js";

export interface GroupOptions {
  /** Longest caption, in characters. */
  maxChars?: number;
  /** Longest caption on screen, in seconds. */
  maxDuration?: number;
  /** A pause this long (seconds) always starts a new caption. */
  pauseBreak?: number;
  /** How long a caption stays up after its last word, if nothing follows straight away. */
  hold?: number;
}

/**
 * Groups timed words into on-screen captions. Hard breaks at sentence ends, text line ends and pauses; a piece
 * longer than `maxChars` (or `maxDuration`) is split into even groups, preferring breaks after commas, so a line
 * never ends with one stranded word.
 */
export function groupCaptions(words: readonly Word[], options: GroupOptions = {}): Caption[] {
  const maxChars = options.maxChars ?? 32;
  const maxDuration = options.maxDuration ?? 3.2;
  const pauseBreak = options.pauseBreak ?? 0.6;
  const hold = options.hold ?? 0.35;
  const groups: Word[][] = [];
  for (const piece of hardPieces(words, pauseBreak)) groups.push(...balance(piece, maxChars, maxDuration));

  return groups.map((group, index) => {
    const first = group[0] as Word;
    const last = group.at(-1) as Word;
    const nextStart = groups[index + 1]?.[0]?.start ?? Infinity;
    const end = Math.max(last.end, Math.min(last.end + hold, nextStart - 0.02));
    return {
      start: round3(first.start),
      end: round3(end),
      text: group.map((w) => w.text).join(" "),
      words: group.map((w) => ({ start: round3(w.start), end: round3(w.end), text: w.text })),
    };
  });
}

function hardPieces(words: readonly Word[], pauseBreak: number): Word[][] {
  const pieces: Word[][] = [];
  let current: Word[] = [];
  for (const word of words) {
    const prev = current.at(-1);
    if (prev && (endsSentence(prev.text) || prev.lineEnd || word.start - prev.end >= pauseBreak)) {
      pieces.push(current);
      current = [];
    }
    current.push(word);
  }
  if (current.length) pieces.push(current);
  return pieces;
}

const LEANS_FORWARD = new Set(
  "a an the and or but nor so yet to of in on at by for with from into onto over under about as than that which who whose your my our their his her its i we you they this these those is are was were be".split(" "),
);

const textLength = (words: readonly Word[], from: number, to: number) => {
  let n = 0;
  for (let i = from; i < to; i++) n += (words[i] as Word).text.length + (i > from ? 1 : 0);
  return n;
};

/** Splits a piece into the fewest groups that fit, with group lengths as even as the word breaks allow. */
function balance(piece: Word[], maxChars: number, maxDuration: number): Word[][] {
  const n = piece.length;
  const total = textLength(piece, 0, n);
  const span = (piece[n - 1] as Word).end - (piece[0] as Word).start;
  if (total <= maxChars && span <= maxDuration) return [piece];
  for (let count = Math.max(2, Math.ceil(total / maxChars), Math.ceil(span / maxDuration)); count <= n; count++) {
    const target = total / count;
    // best[k][i]: least cost putting words[0..i) into k groups. Cost: squared distance from the target length,
    // plus a penalty for overlong groups and for breaking anywhere but after a clause or a pause.
    const best = Array.from({ length: count + 1 }, () => new Array<number>(n + 1).fill(Infinity));
    const from = Array.from({ length: count + 1 }, () => new Array<number>(n + 1).fill(-1));
    best[0]![0] = 0;
    for (let k = 1; k <= count; k++) {
      for (let i = k; i <= n; i++) {
        for (let j = k - 1; j < i; j++) {
          const prev = best[k - 1]![j]!;
          if (!Number.isFinite(prev)) continue;
          const length = textLength(piece, j, i);
          const duration = (piece[i - 1] as Word).end - (piece[j] as Word).start;
          let cost = ((length - target) / maxChars) ** 2;
          if (length > maxChars) cost += 0.5 + ((length - maxChars) / maxChars) * 6;
          if (duration > maxDuration) cost += 4;
          if (i - j === 1 && n > 2) cost += 1.5;
          if (i < n) {
            const last = piece[i - 1] as Word;
            const gap = (piece[i] as Word).start - last.end;
            cost += endsClause(last.text) ? -0.3 : gap > 0.25 ? -0.15 : 0.2;
            // "and", "the", "on" belong with the words after them.
            if (!endsClause(last.text) && LEANS_FORWARD.has(normalizeWord(last.text))) cost += 0.8;
          }
          if (prev + cost < best[k]![i]!) {
            best[k]![i] = prev + cost;
            from[k]![i] = j;
          }
        }
      }
    }
    const groups: Word[][] = [];
    let i = n;
    for (let k = count; k > 0; k--) {
      const j = from[k]![i]!;
      groups.unshift(piece.slice(j, i));
      i = j;
    }
    const fits = groups.every((g) => textLength(g, 0, g.length) <= maxChars * 1.15);
    if (fits || count === n) return groups;
  }
  return [piece];
}

/** Splits timed words into sentences (and lines of the text). Cuts in voice-driven templates land between them. */
export function splitSentences(words: readonly Word[]): Word[][] {
  const out: Word[][] = [];
  let current: Word[] = [];
  for (const word of words) {
    current.push(word);
    if (endsSentence(word.text) || word.lineEnd) {
      out.push(current);
      current = [];
    }
  }
  if (current.length) out.push(current);
  return out;
}

export interface EstimateOptions {
  /** Where speech starts, seconds. */
  start?: number;
  /** Where it ends. When left out, timing comes from `wordsPerSecond`. */
  end?: number;
  wordsPerSecond?: number;
}

/**
 * Word times guessed from text alone, for when there is no audio yet (or no recognizer): words get time by length,
 * with pauses after punctuation. Good enough to lay out a timeline before the voice is generated.
 */
export function estimateWords(text: string, options: EstimateOptions = {}): Word[] {
  const tokens = tokenizeText(text);
  if (tokens.length === 0) return [];
  const weights = tokens.map((t) => Math.max(2, normalizeWord(t).length) + 2);
  const pauses = tokens.map((t): number => (endsSentence(t) ? 5 : endsClause(t) ? 2.5 : 0));
  const totalUnits = weights.reduce((a, b) => a + b, 0) + pauses.slice(0, -1).reduce((a, b) => a + b, 0);
  const start = options.start ?? 0;
  const wps = options.wordsPerSecond ?? 2.6;
  const meanUnits = totalUnits / tokens.length;
  const end = options.end ?? start + totalUnits / (meanUnits * wps);
  const unit = (end - start) / totalUnits;
  const words: Word[] = [];
  let t = start;
  tokens.forEach((token, i) => {
    const d = (weights[i] as number) * unit;
    words.push({ text: token, start: round3(t), end: round3(t + d) });
    t += d + (i < tokens.length - 1 ? (pauses[i] as number) * unit : 0);
  });
  return markLineEnds(words, tokenizeLines(text).map((l) => l.length));
}

/** Moves every word by `offset` seconds (from file time to timeline time). */
export function shiftCaptions(captions: readonly Caption[], offset: number): Caption[] {
  return captions.map((c) => ({
    start: round3(c.start + offset),
    end: round3(c.end + offset),
    text: c.text,
    ...(c.words ? { words: c.words.map((w) => ({ start: round3(w.start + offset), end: round3(w.end + offset), text: w.text })) } : {}),
  }));
}
