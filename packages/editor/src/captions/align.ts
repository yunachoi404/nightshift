import { normalizeWord, round3, tidyWords, type Word } from "./words.js";

export interface TextAlignment {
  /** The known words, each with a time. */
  words: Word[];
  /** Share of known words that matched a recognized word exactly or closely. */
  coverage: number;
  /** Share of recognized words that found a known word. Low for songs whose lyrics repeat more than the text does. */
  recognizedCoverage: number;
}

const MATCH_SIMILARITY = 0.6;

/**
 * Gives every word of a known text a time, using recognized words as anchors (Needleman-Wunsch on normalized
 * words, with fuzzy substitutions). Known words with no recognized counterpart are spread over the gap between
 * their anchors by length. This is forced alignment for clean speech such as TTS: whisper supplies the timing,
 * the script supplies the words.
 */
export function alignText(known: readonly string[], recognized: readonly Word[]): TextAlignment {
  const n = known.length;
  const m = recognized.length;
  if (n === 0) return { words: [], coverage: 1, recognizedCoverage: m === 0 ? 1 : 0 };
  if (m === 0) return { words: [], coverage: 0, recognizedCoverage: 0 };

  const a = known.map(normalizeWord);
  const b = recognized.map((w) => normalizeWord(w.text));
  const GAP = 1;
  // cost[i][j]: best cost aligning a[0..i) with b[0..j). Flat array for speed on long lyrics.
  const width = m + 1;
  const cost = new Float64Array((n + 1) * width);
  const move = new Uint8Array((n + 1) * width); // 1 diagonal, 2 up (known word unmatched), 3 left (recognized word unmatched)
  for (let i = 1; i <= n; i++) {
    cost[i * width] = i * GAP;
    move[i * width] = 2;
  }
  for (let j = 1; j <= m; j++) {
    cost[j] = j * GAP;
    move[j] = 3;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = 1.2 * (1 - similarity(a[i - 1] as string, b[j - 1] as string));
      const diag = (cost[(i - 1) * width + j - 1] as number) + sub;
      const up = (cost[(i - 1) * width + j] as number) + GAP;
      const left = (cost[i * width + j - 1] as number) + GAP;
      let best = diag;
      let dir = 1;
      if (up < best) {
        best = up;
        dir = 2;
      }
      if (left < best) {
        best = left;
        dir = 3;
      }
      cost[i * width + j] = best;
      move[i * width + j] = dir;
    }
  }

  // Walk back to pair each known word with a recognized one (or none).
  const pair = new Array<number>(n).fill(-1);
  const pairSim = new Array<number>(n).fill(0);
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const dir = move[i * width + j];
    if (dir === 1) {
      const sim = similarity(a[i - 1] as string, b[j - 1] as string);
      // A diagonal step with nothing in common is two unrelated words; treat both as unmatched.
      if (sim > 0.2) {
        pair[i - 1] = j - 1;
        pairSim[i - 1] = sim;
      }
      i--;
      j--;
    } else if (dir === 2) i--;
    else j--;
  }

  const timed: (Word | null)[] = known.map((text, k) => {
    const r = pair[k] as number;
    if (r < 0) return null;
    const w = recognized[r] as Word;
    return { text, start: w.start, end: w.end, ...(w.p === undefined ? {} : { p: w.p }) };
  });
  fillGaps(known, timed, pairSim);

  const matched = pairSim.filter((s) => s >= MATCH_SIMILARITY).length;
  const usedRecognized = new Set(pair.filter((r, k) => r >= 0 && (pairSim[k] as number) >= MATCH_SIMILARITY)).size;
  return {
    words: tidyWords(timed as Word[]),
    coverage: round3(matched / n),
    recognizedCoverage: round3(usedRecognized / m),
  };
}

/** Times unmatched known words by sharing out the time between their neighbours, by character count. */
function fillGaps(known: readonly string[], timed: (Word | null)[], pairSim: number[]): void {
  const n = known.length;
  let k = 0;
  while (k < n) {
    if (timed[k]) {
      k++;
      continue;
    }
    let runEnd = k;
    while (runEnd < n && !timed[runEnd]) runEnd++;
    let first = k;
    const prev = k > 0 ? timed[k - 1] : null;
    const next = runEnd < n ? timed[runEnd] : null;
    let from = prev ? prev.end : next ? Math.max(0, next.start - 0.3 * (runEnd - k)) : 0;
    const to = next ? next.start : prev ? prev.end + 0.3 * (runEnd - k) : 0.3 * (runEnd - k);
    // No room left between the anchors: a fuzzy previous anchor (two words heard as one) shares its own span.
    if (to - from < 0.06 * (runEnd - k) && prev && (pairSim[k - 1] as number) < 0.95) {
      first = k - 1;
      from = prev.start;
    }
    const span = Math.max(to - from, 0.06 * (runEnd - first));
    const weights = known.slice(first, runEnd).map((t) => normalizeWord(t).length + 1);
    const total = weights.reduce((x, y) => x + y, 0);
    let t = from;
    for (let q = first; q < runEnd; q++) {
      const d = (span * (weights[q - first] as number)) / total;
      timed[q] = { text: known[q] as string, start: t, end: t + d };
      t += d;
    }
    k = runEnd;
  }
}

/** 1 - normalized Levenshtein distance. */
export function similarity(x: string, y: string): number {
  if (x === y) return 1;
  if (!x.length || !y.length) return 0;
  const prev = new Array<number>(y.length + 1);
  for (let j = 0; j <= y.length; j++) prev[j] = j;
  for (let i = 1; i <= x.length; i++) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const tmp = prev[j] as number;
      prev[j] = Math.min((prev[j] as number) + 1, (prev[j - 1] as number) + 1, diag + (x[i - 1] === y[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return 1 - (prev[y.length] as number) / Math.max(x.length, y.length);
}
