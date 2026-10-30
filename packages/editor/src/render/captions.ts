/**
 * How each caption look is built and moves. The composition decides where the caption block sits; this file builds
 * one caption's words and their motion, timed to the spoken words:
 *
 * - subtitle: film subtitles. The line breathes in, blur to sharp, its words gathering towards the middle, and
 *   drifts up out of focus when it goes. No word is singled out.
 * - karaoke: words rise into place through a mask, one after another. The spoken word fills with the accent from
 *   left to right as it is said and fades back as the next one starts, so the colour travels along the line. The
 *   words leave upwards through the same mask.
 * - chip: the line sits on a frosted plate that opens from the middle. One accent block slides from word to word
 *   and takes each word's width, measured in the page.
 * - kinetic: lyrics. Each word lands as it is sung, settling from large and soft to sharp, lit in the accent until
 *   the next one lands.
 */
import type { Caption } from "@nightshift/contract";
import type { TimelineStyle } from "../style.js";
import { EASE, measure, type Tracks } from "./tracks.js";

export type CaptionLook = TimelineStyle["captions"]["look"];

interface Metrics {
  /** Font size in units of 1% of the frame's short side, before the shape and the style's size. */
  size: number;
  /** Size per frame shape: text on a phone-shaped frame needs to be bigger than the short side alone suggests. */
  shapes: { landscape: number; portrait: number; square: number };
  /** Line height as a multiple of the font size. */
  lineHeight: number;
  /** Average advance per character as a fraction of the font size. Rough, for layout only. */
  em: number;
  /** Space the block needs around its lines (the chip's plate), as a multiple of the font size: [across, down]. */
  pad: [number, number];
}

export const CAPTION_METRICS: Record<CaptionLook, Metrics> = {
  subtitle: { size: 3.5, shapes: { landscape: 1, portrait: 1.3, square: 1.12 }, lineHeight: 1.28, em: 0.5, pad: [0, 0] },
  karaoke: { size: 4.6, shapes: { landscape: 1.15, portrait: 1.3, square: 1.12 }, lineHeight: 1.08, em: 0.56, pad: [0, 0] },
  chip: { size: 5, shapes: { landscape: 1, portrait: 1.3, square: 1.12 }, lineHeight: 1.22, em: 0.6, pad: [1.1, 0.62] },
  kinetic: { size: 9.6, shapes: { landscape: 1, portrait: 1.3, square: 1.12 }, lineHeight: 0.94, em: 0.46, pad: [0, 0] },
};

interface TimedWord {
  start: number;
  end: number;
  text: string;
}

/**
 * One caption's line: its words and their motion. `id` is the caption element's; the caption element itself is
 * shown for the span the motion needs. Returns the markup that goes inside it.
 */
export function captionLine(look: CaptionLook, caption: Caption, id: string, end: number, tracks: Tracks): string {
  return LOOKS[look](id, timedWords(caption, end), { start: caption.start, end }, tracks);
}

/** The caption's words with times: its own, or spread over the caption by length when it has none. */
export function timedWords(caption: Caption, end: number): TimedWord[] {
  if (caption.words?.length) return caption.words.map((w) => ({ start: w.start, end: w.end, text: w.text }));
  const texts = caption.text.split(/\s+/).filter(Boolean);
  const total = texts.reduce((n, t) => n + t.length + 1, 0);
  const length = Math.max(0.1, end - caption.start);
  let at = caption.start;
  return texts.map((text) => {
    const share = ((text.length + 1) / total) * length;
    const word = { start: at, end: at + share * 0.9, text };
    at += share;
    return word;
  });
}

interface Span {
  start: number;
  end: number;
}

type Build = (id: string, words: TimedWord[], span: Span, tracks: Tracks) => string;

const LOOKS: Record<CaptionLook, Build> = { subtitle, karaoke, chip, kinetic };

function subtitle(id: string, words: TimedWord[], { start, end }: Span, tracks: Tracks): string {
  const length = end - start;
  const inDur = clamp(length * 0.4, 0.2, 0.6);
  const outDur = clamp(length * 0.22, 0.12, 0.34);
  const t0 = start - 0.05;
  const leave = Math.max(t0 + inDur, end - outDur);
  show(tracks, id, t0, end);
  tracks.add(id, "opacity", t0, 0, EASE.out).add(id, "opacity", t0 + inDur * 0.7, 1).add(id, "opacity", leave, 1, EASE.in).add(id, "opacity", end, 0);
  tracks.add(`${id}l`, "filter", t0, "blur(0.22em)", EASE.outStrong).add(`${id}l`, "filter", t0 + inDur, "blur(0em)").add(`${id}l`, "filter", leave, "blur(0em)", EASE.in).add(`${id}l`, "filter", end, "blur(0.14em)");
  tracks.add(`${id}l`, "translate", t0, "0 0.2em", EASE.outStrong).add(`${id}l`, "translate", t0 + inDur * 1.2, "0 0em").add(`${id}l`, "translate", leave, "0 0em", EASE.in).add(`${id}l`, "translate", end, "0 -0.12em");
  const mid = (words.length - 1) / 2;
  const spans = words.map((w, j) => {
    const wid = `${id}w${j}`;
    // Outer words travel furthest, so the line seems to settle its spacing.
    const from = mid > 0 ? ((j - mid) / mid) * 0.3 : 0;
    if (from) tracks.add(wid, "translate", t0, `${fmt(from)}em 0`, EASE.outStrong).add(wid, "translate", t0 + inDur * 1.6, "0em 0");
    return `<span class="w" id="${wid}">${escapeHtml(w.text)}</span>`;
  });
  return `<span class="line" id="${id}l">${spans.join(" ")}</span>`;
}

function karaoke(id: string, words: TimedWord[], { start, end }: Span, tracks: Tracks): string {
  const n = words.length;
  const length = end - start;
  const inDur = clamp(length * 0.5, 0.26, 0.62);
  const stagger = Math.min(0.05, (length * 0.3) / n);
  const outDur = clamp(length * 0.2, 0.14, 0.3);
  const outStagger = Math.min(0.025, (length * 0.08) / n);
  // The line before leaves by this caption's start, so two lines never share a frame.
  const t0 = start - 0.01;
  let last = end;
  const spans = words.map((w, j) => {
    const wid = `${id}w${j}`;
    const inAt = t0 + j * stagger;
    const outAt = Math.max(inAt + inDur, end - outDur - (n - 1 - j) * outStagger);
    last = Math.max(last, outAt + outDur);
    tracks.add(`${wid}i`, "translate", inAt, "0 1.2em", EASE.outStrong).add(`${wid}i`, "translate", inAt + inDur, "0 0em").add(`${wid}i`, "translate", outAt, "0 0em", EASE.inStrong).add(`${wid}i`, "translate", outAt + outDur, "0 -1.2em");
    tracks.add(`${wid}i`, "opacity", inAt, 0, EASE.out).add(`${wid}i`, "opacity", inAt + inDur * 0.5, 1).add(`${wid}i`, "opacity", outAt + outDur * 0.3, 1, EASE.in).add(`${wid}i`, "opacity", outAt + outDur, 0);
    // The fill sweeps across the word while it is said, then fades back once the next word has started.
    const said = Math.max(w.start, inAt + 0.04);
    const next = words[j + 1]?.start ?? end;
    const filled = Math.max(said + 0.12, Math.min(w.end, next));
    const off = Math.max(filled, next);
    tracks.add(`${wid}f`, "mask-position", said, "100% 0%", EASE.sine).add(`${wid}f`, "mask-position", filled, "0% 0%");
    if (j < n - 1) tracks.add(`${wid}f`, "opacity", off, 1, EASE.inOut).add(`${wid}f`, "opacity", off + 0.2, 0);
    const text = escapeHtml(w.text);
    return `<span class="w"><span class="wi" id="${wid}i">${text}<span class="wf" id="${wid}f" aria-hidden="true">${text}</span></span></span>`;
  });
  show(tracks, id, t0, last);
  return `<span class="line" id="${id}l">${spans.join(" ")}</span>`;
}

function chip(id: string, words: TimedWord[], { start, end }: Span, tracks: Tracks): string {
  const n = words.length;
  const length = end - start;
  const t0 = start - 0.08;
  const open = clamp(length * 0.4, 0.22, 0.42);
  const outDur = clamp(length * 0.2, 0.12, 0.24);
  const leave = Math.max(t0 + open, end - outDur);
  show(tracks, id, t0, end);
  const plate = `${id}l`;
  tracks.add(plate, "clip-path", t0, "inset(0% 50% 0% 50% round 0.36em)", EASE.outStrong).add(plate, "clip-path", t0 + open, "inset(0% 0% 0% 0% round 0.36em)");
  tracks.add(plate, "opacity", t0, 0, EASE.out).add(plate, "opacity", t0 + open * 0.4, 1).add(plate, "opacity", leave, 1, EASE.in).add(plate, "opacity", end, 0);
  tracks.add(plate, "translate", leave, "0 0em", EASE.in).add(plate, "translate", end, "0 0.18em");
  const stagger = Math.min(0.035, (length * 0.25) / n);
  const hl = `${id}h`;
  // When the block travels to each word: it arrives as the word is said, never before the last move ends.
  const moves: { from: number; to: number }[] = [];
  for (const w of words) {
    const at = Math.max(w.start, t0 + 0.1);
    const from = Math.max(moves.at(-1)?.to ?? -Infinity, at - 0.07);
    moves.push({ from, to: Math.max(from + 0.06, at + 0.11) });
  }
  let prevBox: Record<string, string> = {};
  const spans = words.map((w, j) => {
    const wid = `${id}w${j}`;
    const inAt = t0 + 0.06 + j * stagger;
    tracks.add(`${wid}i`, "opacity", inAt, 0, EASE.out).add(`${wid}i`, "opacity", inAt + 0.22, 1);
    tracks.add(`${wid}i`, "translate", inAt, "0 0.4em", EASE.outStrong).add(`${wid}i`, "translate", inAt + 0.36, "0 0em");
    // The block takes each word's place and width on the way; the word under it takes the text-on-accent colour.
    const { from, to } = moves[j] as { from: number; to: number };
    const box = { left: `calc(${measure(wid, "x")}px - 0.13em)`, top: `calc(${measure(wid, "y")}px - 0.02em)`, width: `calc(${measure(wid, "w")}px + 0.26em)`, height: `calc(${measure(wid, "h")}px + 0.04em)` };
    for (const [prop, value] of Object.entries(box)) {
      if (j === 0) tracks.add(hl, prop, from, value);
      else tracks.add(hl, prop, from, prevBox[prop] as string, EASE.inOut).add(hl, prop, to, value);
    }
    prevBox = box;
    if (j === 0) {
      tracks.add(hl, "opacity", from, 0, EASE.out).add(hl, "opacity", to, 1);
      tracks.add(hl, "scale", from, "0.6 0.8", EASE.outStrong).add(hl, "scale", to + 0.1, "1 1");
    }
    tracks.add(`${wid}i`, "color", from, "var(--cap-text)", EASE.inOut).add(`${wid}i`, "color", to, "var(--accent-text)");
    const next = moves[j + 1];
    if (next) tracks.add(`${wid}i`, "color", next.from, "var(--accent-text)", EASE.inOut).add(`${wid}i`, "color", next.to, "var(--cap-text)");
    return `<span class="w" id="${wid}"><span class="wi" id="${wid}i">${escapeHtml(w.text)}</span></span>`;
  });
  return `<span class="line" id="${plate}"><span class="hl" id="${hl}" aria-hidden="true"></span>${spans.join(" ")}</span>`;
}

function kinetic(id: string, words: TimedWord[], { start, end }: Span, tracks: Tracks): string {
  const n = words.length;
  const lands = words.map((w) => Math.max(start, w.start) - 0.02);
  // The line is gone by its end, so the next one lands on a clear frame; a late last word shortens the exit.
  const lastLand = lands.at(-1) ?? start;
  const outDur = clamp(Math.min((end - start) * 0.18, end - lastLand - 0.14), 0.07, 0.22);
  const leave = Math.max(lastLand + 0.07, end - outDur);
  show(tracks, `${id}`, (lands[0] ?? start) - 0.01, leave + outDur);
  const spans = words.map((w, j) => {
    const wid = `${id}w${j}i`;
    const at = lands[j] as number;
    const next = j + 1 < n ? (lands[j + 1] as number) : leave;
    tracks.add(wid, "opacity", at, 0, EASE.out).add(wid, "opacity", at + 0.06, 1).add(wid, "opacity", leave, 1, EASE.in).add(wid, "opacity", leave + outDur, 0);
    tracks.add(wid, "scale", at, "1.22", EASE.outStrong).add(wid, "scale", at + 0.42, "1");
    tracks.add(wid, "filter", at, "blur(0.07em)", EASE.out).add(wid, "filter", at + 0.2, "blur(0em)").add(wid, "filter", leave, "blur(0em)", EASE.in).add(wid, "filter", leave + outDur, "blur(0.06em)");
    tracks.add(wid, "translate", leave, "0 0em", EASE.in).add(wid, "translate", leave + outDur, "0 -0.14em");
    // Lit as it lands, easing back to the text colour once the next word is in.
    const cool = Math.max(at + 0.12, Math.min(next, leave));
    tracks.add(wid, "color", at, "var(--accent)").add(wid, "color", cool, "var(--accent)", EASE.inOut).add(wid, "color", cool + 0.18, "var(--cap-text)");
    return `<span class="w"><span class="wi" id="${wid}">${escapeHtml(w.text)}</span></span>`;
  });
  return `<span class="line" id="${id}l">${spans.join(" ")}</span>`;
}

/** Shows the caption element over a span and hides it either side, so stacked captions never show together. */
function show(tracks: Tracks, id: string, from: number, to: number): void {
  tracks.add(id, "visibility", 0, "hidden", EASE.step).add(id, "visibility", from, "visible", EASE.step).add(id, "visibility", to, "hidden");
}

/** CSS for the caption looks. `px` formats pixel lengths; sizes come in through --cap-size on the block. */
export function captionCss(): string {
  return `
.caps .line{display:inline-block;max-width:100%;text-wrap:balance}
.caps .w{display:inline-block}
.caps .wi{display:inline-block;position:relative}
.caps-subtitle .cap{font-weight:500;line-height:1.28;letter-spacing:0.004em}
.caps-subtitle .line{text-shadow:0 0 0.5em rgba(0,0,0,0.45),0 0.04em 0.12em rgba(0,0,0,0.5)}
.caps-subtitle.anchor-bar .line{text-shadow:none}
.caps-karaoke .cap{font-weight:700;line-height:1.08;letter-spacing:-0.022em}
.caps-karaoke .line{filter:drop-shadow(0 0.02em 0.04em rgba(0,0,0,0.4)) drop-shadow(0 0.04em 0.45em rgba(0,0,0,0.34))}
.caps-karaoke .w{overflow:hidden;padding:0.1em 0.06em 0.2em;margin:-0.1em -0.06em -0.2em;vertical-align:top}
.caps-karaoke .wf{position:absolute;left:-0.04em;top:-0.2em;padding:0.2em 0.04em;color:var(--accent);white-space:nowrap;mask-image:linear-gradient(90deg,#000 0%,#000 42%,transparent 58%,transparent 100%);mask-size:300% 100%;mask-repeat:no-repeat;mask-position:100% 0%}
.caps-chip .cap{font-weight:640;line-height:1.22;letter-spacing:-0.012em;word-spacing:0.1em;font-variation-settings:"wdth" 108}
.caps-chip .line{position:relative;isolation:isolate;padding:0.31em 0.55em 0.33em;border-radius:0.36em;background:linear-gradient(180deg,rgba(255,255,255,0.07),rgba(255,255,255,0) 60%),var(--scrim);backdrop-filter:blur(0.6em) saturate(1.4);box-shadow:inset 0 0 0 0.03em rgba(255,255,255,0.1),0 0.15em 0.8em rgba(0,0,0,0.2)}
.caps-chip .hl{position:absolute;left:0;top:0;width:0;height:0;border-radius:0.22em;background:var(--accent);z-index:-1;opacity:0}
.caps-kinetic .cap{font-weight:800;line-height:0.94;letter-spacing:-0.012em;font-variation-settings:"wdth" 75}
.caps-kinetic .line{filter:drop-shadow(0 0.02em 0.04em rgba(0,0,0,0.3)) drop-shadow(0 0.03em 0.3em rgba(0,0,0,0.3))}
.caps-kinetic .wi{transform-origin:50% 60%}
`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function fmt(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
