import { describe, expect, it } from "vitest";
import { alignText, similarity } from "../src/captions/align.js";
import { estimateWords, groupCaptions, splitSentences } from "../src/captions/group.js";
import { snapWordsToSound } from "../src/captions/refine.js";
import { parseVadSegments, phraseWindows, wordsFromWhisper } from "../src/captions/whisper.js";
import { markLineEnds, tokenizeText, type Word } from "../src/captions/words.js";

const heard = (pairs: [string, number, number][]): Word[] => pairs.map(([text, start, end]) => ({ text, start, end }));

describe("alignText", () => {
  it("copies times from matching recognized words and keeps the script's spelling", () => {
    const known = tokenizeText("Meet Lumen, the desk lamp.");
    const recognized = heard([["Meet", 0, 0.25], ["Lumin,", 0.3, 0.6], ["the", 0.86, 0.9], ["desk", 0.9, 1.13], ["lamp.", 1.25, 1.5]]);
    const { words, coverage } = alignText(known, recognized);
    expect(words.map((w) => w.text)).toEqual(["Meet", "Lumen,", "the", "desk", "lamp."]);
    expect(words[1]).toMatchObject({ start: 0.3, end: 0.6 });
    expect(coverage).toBe(1);
  });

  it("spreads words the recognizer missed over the gap they sit in", () => {
    const known = tokenizeText("one two three four");
    const recognized = heard([["one", 0, 0.3], ["four", 1.5, 1.8]]);
    const { words } = alignText(known, recognized);
    expect(words[1]!.start).toBeCloseTo(0.3, 2);
    expect(words[2]!.end).toBeCloseTo(1.5, 2);
    expect(words[1]!.end).toBeLessThanOrEqual(words[2]!.start + 1e-6);
  });

  it("splits a fused recognition across the words it covers", () => {
    const known = tokenizeText("the desk lamp glows");
    const recognized = heard([["the", 0, 0.2], ["desklamp", 0.2, 1.0], ["glows", 1.0, 1.4]]);
    const { words } = alignText(known, recognized);
    expect(words[1]!.start).toBeCloseTo(0.2, 2);
    expect(words[2]!.end).toBeLessThanOrEqual(1.0 + 1e-6);
    expect(words[2]!.start).toBeGreaterThan(words[1]!.start);
  });

  it("ignores words that were heard but are not in the script", () => {
    const known = tokenizeText("order yours today");
    const recognized = heard([["um", 0, 0.2], ["order", 0.3, 0.6], ["yours", 0.6, 0.9], ["today", 0.9, 1.3], ["thanks", 1.5, 1.8]]);
    const { words, recognizedCoverage } = alignText(known, recognized);
    expect(words.map((w) => [w.start, w.end])).toEqual([[0.3, 0.6], [0.6, 0.9], [0.9, 1.3]]);
    expect(recognizedCoverage).toBeCloseTo(0.6, 2);
  });

  it("scores word similarity", () => {
    expect(similarity("lumen", "lumen")).toBe(1);
    expect(similarity("lumen", "lumin")).toBeCloseTo(0.8, 5);
    expect(similarity("cat", "dog")).toBe(0);
  });
});

describe("tokenizeText", () => {
  it("drops section labels and glues stray punctuation", () => {
    expect(tokenizeText("[Chorus] Hold the night — until it breaks (x2)")).toEqual(["Hold", "the", "night", "until", "it", "breaks"]);
    expect(tokenizeText("Wait ... what ?")).toEqual(["Wait...", "what?"]);
  });
});

describe("groupCaptions", () => {
  it("breaks at sentences, long pauses and the character limit, and avoids lonely last words", () => {
    const words = estimateWords("Meet Lumen, the desk lamp that follows the sun. It warms up at dusk.", { start: 0, end: 5 });
    const captions = groupCaptions(words, { maxChars: 20 });
    expect(captions.every((c) => c.text.length <= 25)).toBe(true);
    expect(captions.some((c) => c.text.endsWith("sun."))).toBe(true);
    expect(captions.every((c, i) => i === 0 || c.start >= captions[i - 1]!.end)).toBe(true);
    expect(captions.every((c) => c.words!.length > 1 || c.text.split(" ").length === 1)).toBe(true);
    const all = captions.flatMap((c) => c.words!.map((w) => w.text));
    expect(all).toEqual(words.map((w) => w.text));
  });

  it("holds a caption briefly after its last word, without running into the next", () => {
    const words = heard([["Hello.", 0, 0.5], ["Again.", 0.6, 1]]);
    const [first, second] = groupCaptions(words, { hold: 0.35 });
    expect(first!.end).toBeCloseTo(0.58, 3);
    expect(second!.end).toBeCloseTo(1.35, 3);
  });

  it("splits sentences", () => {
    const words = estimateWords("One two. Three! Four five?");
    expect(splitSentences(words).map((s) => s.length)).toEqual([2, 1, 2]);
  });
});

describe("estimateWords", () => {
  it("fills the span it is given, in order, with pauses at punctuation", () => {
    const words = estimateWords("Short. And then a longer sentence.", { start: 1, end: 4 });
    expect(words[0]!.start).toBe(1);
    expect(words.at(-1)!.end).toBeCloseTo(4, 2);
    expect(words[1]!.start - words[0]!.end).toBeGreaterThan(0.1);
  });
});

describe("wordsFromWhisper", () => {
  it("merges sub-word tokens and punctuation into words, and skips special tokens", () => {
    const json = {
      transcription: [
        {
          text: " Meet Lumen,",
          offsets: { from: 0, to: 700 },
          tokens: [
            { text: "[_BEG_]", offsets: { from: 0, to: 0 }, p: 1 },
            { text: " Meet", offsets: { from: 10, to: 260 }, p: 0.9 },
            { text: " L", offsets: { from: 260, to: 320 }, p: 0.7 },
            { text: "umen", offsets: { from: 320, to: 580 }, p: 0.9 },
            { text: ",", offsets: { from: 580, to: 610 }, p: 0.8 },
            { text: "[_TT_30]", offsets: { from: 700, to: 700 }, p: 0.5 },
          ],
        },
      ],
    };
    expect(wordsFromWhisper(json, false)).toEqual([
      { text: "Meet", start: 0.01, end: 0.26, p: 0.9 },
      { text: "Lumen,", start: 0.26, end: 0.61, p: 0.8 },
    ]);
  });

  it("drops the usual hallucinations over music", () => {
    const json = { transcription: [{ text: " Thanks for watching!", offsets: { from: 0, to: 1000 }, tokens: [{ text: " Thanks", offsets: { from: 0, to: 500 }, p: 0.9 }] }] };
    expect(wordsFromWhisper(json, true)).toEqual([]);
  });
});

describe("snapWordsToSound", () => {
  it("moves word edges out of silences", () => {
    const words = heard([["sun.", 2.3, 2.95], ["It", 2.98, 3.2]]);
    const sound = [{ start: 0, end: 2.82 }, { start: 3.05, end: 4 }];
    const [sun, it_] = snapWordsToSound(words, sound);
    expect(sun!.end).toBeCloseTo(2.82, 3);
    expect(it_!.start).toBeCloseTo(3.05, 3);
  });

  it("starts the first word of a phrase with its sound", () => {
    const words = heard([["the", 0.95, 1.1]]);
    const [the] = snapWordsToSound(words, [{ start: 0.86, end: 1.5 }]);
    expect(the!.start).toBeCloseTo(0.86, 3);
  });
});

describe("song phrases", () => {
  it("reads whisper.cpp's VAD output", () => {
    const out = "Detected 2 speech segments:\nSpeech segment 0: start = 807.00, end = 985.00\nSpeech segment 1: start = 1207.00, end = 1357.00\n";
    expect(parseVadSegments(out)).toEqual([{ start: 8.07, end: 9.85 }, { start: 12.07, end: 13.57 }]);
  });

  it("joins close segments, pads them and caps their length", () => {
    const phrases = phraseWindows([{ start: 8, end: 9.8 }, { start: 10, end: 11 }, { start: 20, end: 80 }]);
    expect(phrases[0]).toEqual({ start: 7.75, end: 11.25, voiceStart: 8, voiceEnd: 11 });
    expect(phrases.slice(1).every((p) => p.end - p.start <= 28.5)).toBe(true);
    expect(phrases.at(-1)!.voiceEnd).toBe(80);
  });
});

describe("line breaks", () => {
  it("breaks captions and sentences at the ends of the text's lines", () => {
    const words = estimateWords("Neon rain on the empty street\nI can hear the city breathe", { start: 0, end: 4 });
    expect(words[5]!.lineEnd).toBe(true);
    const captions = groupCaptions(words, { maxChars: 60 });
    expect(captions.map((c) => c.text)).toEqual(["Neon rain on the empty street", "I can hear the city breathe"]);
    expect(splitSentences(words)).toHaveLength(2);
  });

  it("leaves words alone when the line counts do not match", () => {
    const words = estimateWords("one two three");
    expect(markLineEnds(words, [1, 1]).some((w) => w.lineEnd)).toBe(false);
  });
});

describe("snapWordsToSound, sentence starts", () => {
  it("moves a sentence's first word past the pause it was glued in front of", () => {
    const words = heard([["sun.", 2.27, 2.72], ["It", 2.72, 2.8], ["warms", 3.04, 3.42]]);
    const sound = [{ start: 0.85, end: 2.82 }, { start: 3.04, end: 4.25 }];
    const [, it_, warms] = snapWordsToSound(words, sound);
    expect(it_!.start).toBeCloseTo(3.04, 3);
    expect(warms!.start).toBeGreaterThanOrEqual(it_!.end - 1e-6);
  });

  it("keeps the words in the order they were said when that move overtakes the next word", () => {
    // A Breeze voiceover on an 8 GB card: whisper glued "One" to "sleeps." and gave "more" no length. The captions read
    // "One ride more before morning." until the order was kept.
    const words = heard([["sleeps.", 1.39, 1.96], ["One", 1.96, 2.09], ["more", 2.4, 2.44], ["ride", 2.44, 2.65], ["before", 2.65, 2.99], ["morning.", 3.05, 3.7]]);
    const sound = [{ start: 0, end: 1.02 }, { start: 1.17, end: 2.11 }, { start: 2.42, end: 3.73 }];
    const out = snapWordsToSound(words, sound);
    expect(out.map((w) => w.text)).toEqual(["sleeps.", "One", "more", "ride", "before", "morning."]);
    expect(out[1]!.start).toBeCloseTo(2.42, 3);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.start).toBeGreaterThanOrEqual(out[i - 1]!.end - 1e-6);
      expect(out[i]!.end).toBeGreaterThan(out[i]!.start);
    }
  });
});
