/**
 * The HyperFrames page for a reveal clip. Layout and motion are computed here; the page plays keyframes back.
 *
 * One system for every shape: the picture sits in a card on the app's background with the headline above it and a
 * row of tags below, so the source, the draft, the frozen frames and the final line up to the pixel. The compare
 * is a stack on a tall frame (draft above, its final below, same frame index) and a wipe with a held, labelled split
 * on a wide one. Motion is fast in, settle, hold, and the cuts into and out of the close crop are cuts: nothing
 * blends over the evidence. Sound is not part of the page; the exporter mixes it.
 */
import type { Aspect, FinalKind } from "@nightshift/contract";
import { escapeHtml, fmt } from "../render/composition.js";
import { fontStack, fontSynthesis } from "../render/fonts.js";
import { EASE, Tracks, PAGE_ANIMATOR } from "../render/tracks.js";
import type { RevealPlan } from "./plan.js";

export type RevealTheme = "dark" | "light";

export interface RevealMedia {
  /** Paths relative to the composition folder. */
  source?: string;
  /** The draft's first frames, 0 to freezeFrame - 1. */
  draftHead: string;
  draftFrame: string;
  finalFrame: string;
  /**
   * The final as the clip plays it: from freezeFrame to its end, then from its first frame for the end card, in
   * one file so one video element plays through both without a cut between two elements.
   */
  finalPlay: string;
  srcWidth: number;
  srcHeight: number;
}

export interface RevealCopy {
  /** "One photo." or the shot's label when there is no photo. */
  opening: string;
  draftSize: string;
  finalSize: string;
  kind: FinalKind;
  /** The frame the freeze lands on and the draft's length, for the "Frame 41 of 97" tag. */
  freezeFrame: number;
  frames: number;
}

export interface RevealScene {
  width: number;
  height: number;
  aspect: Aspect;
  theme: RevealTheme;
  plan: RevealPlan;
  media: RevealMedia;
  copy: RevealCopy;
  /** Where the close crop looks, as fractions of the picture: left, top, width (the height follows the panel). */
  crop: { x: number; y: number; w: number };
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RevealLayout {
  /** Scale unit: 1 at 1080 px on the short side. */
  u: number;
  /** How the frozen frames are compared: one below the other, or a wipe and a split inside one card. */
  compare: "stack" | "split";
  /** The card the picture plays in (the draft's panel in a stack). */
  media: Rect;
  /** The final's panel in a stack. */
  second: Rect | null;
  headline: { left: number; bottom: number; width: number; size: number };
  tags: { left: number; top: number; size: number };
  /** The end card's wordmark block, below the picture. */
  mark: { left: number; top: number; size: number };
  radius: number;
  /** The frame's safe margin on each side; type never crosses it. */
  gutter: number;
  /** The close crop's width as a share of the picture, and the crop panel's shape. */
  cropW: number;
  panel: { width: number; height: number };
}

export const REVEAL_COMPOSITION_ID = "nightshift-reveal";

/** The card's place, the compare mode and the type anchors for a frame and a source shape. */
export function revealLayout(scene: Pick<RevealScene, "width" | "height" | "media">): RevealLayout {
  const { width: W, height: H } = scene;
  const u = Math.min(W, H) / 1080;
  const portrait = H > W;
  const aspect = scene.media.srcWidth / scene.media.srcHeight;
  const gutter = 48 * u;
  const gap = 24 * u;
  const radius = 12 * u;
  const tagSize = 34 * u;
  if (portrait) {
    // Headline in the top fifth, the card under it, everything above the social apps' bottom zone.
    const size = 92 * u;
    const headlineBottom = 0.17 * H;
    const box = { left: gutter, top: headlineBottom + 36 * u, right: W - gutter, bottom: 0.79 * H };
    const boxW = box.right - box.left;
    const boxH = box.bottom - box.top;
    const stack = aspect >= 1.2;
    if (stack) {
      const ph = Math.min((boxH - gap) / 2, boxW / aspect);
      const mw = ph * aspect;
      const left = (W - mw) / 2;
      const media = { left, top: box.top, width: mw, height: ph };
      const second = { left, top: box.top + ph + gap, width: mw, height: ph };
      return {
        u,
        compare: "stack",
        media,
        second,
        headline: { left, bottom: headlineBottom, width: mw, size },
        tags: { left, top: media.top + media.height + 28 * u, size: tagSize },
        mark: { left, top: media.top + media.height + 56 * u, size: 64 * u },
        radius,
        gutter,
        cropW: 1 / 3,
        panel: { width: mw, height: ph },
      };
    }
    const mw = Math.min(boxW, boxH * aspect);
    const mh = mw / aspect;
    const left = (W - mw) / 2;
    const media = { left, top: box.top, width: mw, height: mh };
    return {
      u,
      compare: "split",
      media,
      second: null,
      headline: { left, bottom: headlineBottom, width: mw, size },
      tags: { left, top: media.top + media.height + 28 * u, size: tagSize },
      mark: { left, top: media.top + media.height + 56 * u, size: 64 * u },
      radius,
      gutter,
      cropW: 0.2,
      panel: { width: (mw - 3 * u) / 2, height: mh },
    };
  }
  // Wide: the card takes most of the height, the headline above it, the tags and the mark below.
  const size = 76 * u;
  const box = { left: gutter, top: 0.17 * H, right: W - gutter, bottom: 0.84 * H };
  const boxW = box.right - box.left;
  const boxH = box.bottom - box.top;
  const mw = Math.min(boxW, boxH * aspect);
  const mh = mw / aspect;
  const left = (W - mw) / 2;
  const media = { left, top: box.top, width: mw, height: mh };
  return {
    u,
    compare: "split",
    media,
    second: null,
    headline: { left, bottom: media.top - 28 * u, width: mw, size },
    tags: { left, top: media.top + media.height + 24 * u, size: tagSize },
    mark: { left, top: media.top + media.height + 36 * u, size: 56 * u },
    radius,
    gutter,
    cropW: 0.2,
    panel: { width: (mw - 3 * u) / 2, height: mh },
  };
}

/**
 * Where each tag slot sits under the card: left to right with `gap` between, wrapping to the next row (`rowHeight`
 * further down) when a slot would cross `width`. A slot wider than the row still starts a row of its own, flush left.
 */
export function layoutTagSlots(widths: number[], width: number, gap: number, rowHeight: number): { left: number; top: number; row: number }[] {
  const out: { left: number; top: number; row: number }[] = [];
  let left = 0;
  let row = 0;
  for (const w of widths) {
    if (left > 0 && left + w > width) {
      left = 0;
      row += 1;
    }
    out.push({ left, top: row * rowHeight, row });
    left += w + gap;
  }
  return out;
}

/** A headline's font size, shrunk so the line fits its column (one line, always). */
export function fitHeadline(text: string, size: number, width: number): number {
  const em = 0.5; // Inter semibold with tight tracking, average advance per character.
  const needed = text.length * em * size;
  return needed > width ? Math.max(size * 0.6, width / (text.length * em)) : size;
}

/** Rough advance of a tag's text in Inter medium at `size` px: digits are tabular, letters a little narrower. */
export function tagTextWidth(text: string, size: number): number {
  let em = 0;
  for (const ch of text) em += /[0-9]/.test(ch) ? 0.6 : /[A-Z]/.test(ch) ? 0.66 : /[a-z]/.test(ch) ? 0.52 : /[ .,]/.test(ch) ? 0.28 : 0.6;
  return em * size;
}

/** The crop panel's window on the picture: a rectangle of width `w` (a share of the picture) at the panel's shape. */
export function cropWindow(crop: RevealScene["crop"], media: Rect, panel: { width: number; height: number }): { x: number; y: number; w: number; h: number } {
  const h = (crop.w * media.width * (panel.height / panel.width)) / media.height;
  const clamp = (v: number, size: number) => Math.min(Math.max(v, 0), 1 - size);
  return { x: clamp(crop.x, crop.w), y: clamp(crop.y, h), w: crop.w, h };
}

export function buildRevealComposition(scene: RevealScene, fontFaces: string): string {
  const { width: W, height: H, plan, media, copy } = scene;
  const L = revealLayout(scene);
  const tracks = new Tracks();
  const px = (v: number) => `${fmt(v)}px`;
  const u = L.u;
  const sameTake = copy.kind === "same_take";
  const stack = L.compare === "stack" && L.second !== null;
  const compareEnd = (plan.detail ?? plan.hold).end;
  // On a tall frame the single card sits centred under its headline; the group slides up to make room for the
  // second card while the stack is up, and settles back when the final plays on.
  const shift = stack ? Math.round((H - (L.media.top + L.media.height + 2 * L.tags.size)) / 2 - L.media.top + L.headline.size * 0.6) : 0;
  if (shift > 0) {
    tracks
      .add("grp", "transform", 0, `translateY(${px(shift)})`, EASE.linear)
      .add("grp", "transform", plan.wipe.start, `translateY(${px(shift)})`, EASE.outStrong)
      .add("grp", "transform", plan.wipe.start + 0.45, "translateY(0px)", EASE.linear)
      .add("grp", "transform", compareEnd, "translateY(0px)", EASE.inOut)
      .add("grp", "transform", compareEnd + 0.35, `translateY(${px(shift)})`);
  }

  // ------------------------------------------------------------ picture
  const show = (id: string, span: { start: number; end: number }) => {
    tracks.add(id, "opacity", span.start, 0, EASE.step).add(id, "opacity", span.start, 1);
    tracks.add(id, "opacity", span.end, 1, EASE.step).add(id, "opacity", span.end, 0);
  };
  if (plan.source && media.source) {
    show("src", plan.source);
    tracks.add("src-m", "transform", plan.source.start, "scale(1.06)", EASE.outStrong).add("src-m", "transform", plan.source.end, "scale(1.02)");
  }
  show("draft", plan.draft);
  tracks.add("draft", "transform", plan.draft.start, "scale(1.035)", EASE.outStrong).add("draft", "transform", plan.draft.start + 0.3, "scale(1)");
  show("dframe", { start: plan.freeze.start, end: compareEnd });
  show("final", { start: plan.resume.start, end: plan.endCard.end });
  tracks.add("fade", "opacity", plan.endCard.end - plan.fadeOut, 0, EASE.inOut).add("fade", "opacity", plan.endCard.end, 1);

  // Labels on the compared frames, in plain words.
  const labelDraft = "Draft";
  const labelFinal = sameTake ? "Finished, same take" : "Remaster";
  let compareHtml = "";
  let labelA = "";
  if (stack) {
    // The final's frame slides in below the frozen draft, both frame F, labelled. The second card cuts away on the resume.
    const B = L.second!;
    const w = plan.wipe;
    tracks.add("second", "opacity", w.start, 0, EASE.out).add("second", "opacity", w.start + 0.22, 1).add("second", "opacity", compareEnd, 1, EASE.step).add("second", "opacity", compareEnd, 0);
    tracks.add("second", "transform", w.start, `translateY(${px(28 * u)})`, EASE.outStrong).add("second", "transform", w.start + 0.4, "translateY(0px)");
    const labels = { start: w.start + 0.2, end: compareEnd };
    for (const id of ["lab-a", "lab-b"]) {
      tracks.add(id, "opacity", labels.start, 0, EASE.out).add(id, "opacity", labels.start + 0.2, 1).add(id, "opacity", labels.end, 1, EASE.step).add(id, "opacity", labels.end, 0);
    }
    compareHtml = `<div class="card second" id="second" style="left:${px(B.left)};top:${px(B.top)};width:${px(B.width)};height:${px(B.height)}">
<img class="pic on" src="${escapeHtml(media.finalFrame)}" alt="">
${plan.detail ? cropPanel("det-b", media.finalFrame, scene, L, L.panel, plan.detail, tracks, 0) : ""}
<div class="ring"></div>
</div>
<span class="lab lab-final" id="lab-b" style="left:${px(B.left + 18 * u)};top:${px(B.top + B.height - 18 * u)}">${labelFinal}</span>`;
    labelA = `<span class="lab" id="lab-a" style="left:${px(L.media.left + 18 * u)};top:${px(L.media.top + L.media.height - 18 * u)}">${labelDraft}</span>`;
  } else {
    // The final's frame wipes over the draft's from the left, pauses as a labelled split, then finishes the wipe.
    const w = plan.wipe;
    const len = w.end - w.start;
    const toMid = Math.min(0.3, len * 0.3);
    const fromMid = Math.min(0.25, len * 0.25);
    show("fframe", { start: w.start, end: compareEnd });
    tracks
      .add("fframe", "clip-path", w.start, "inset(0 100% 0 0)", EASE.inOut)
      .add("fframe", "clip-path", w.start + toMid, "inset(0 58% 0 0)", EASE.linear)
      .add("fframe", "clip-path", w.end - fromMid, "inset(0 58% 0 0)", EASE.inOut)
      .add("fframe", "clip-path", w.end, "inset(0 0% 0 0)");
    const m = L.media;
    tracks.add("edge", "opacity", w.start, 0, EASE.step).add("edge", "opacity", w.start, 1, EASE.linear).add("edge", "opacity", w.end - 0.08, 1, EASE.out).add("edge", "opacity", w.end, 0);
    tracks
      .add("edge", "transform", w.start, `translateX(${px(m.left)})`, EASE.inOut)
      .add("edge", "transform", w.start + toMid, `translateX(${px(m.left + m.width * 0.42)})`, EASE.linear)
      .add("edge", "transform", w.end - fromMid, `translateX(${px(m.left + m.width * 0.42)})`, EASE.inOut)
      .add("edge", "transform", w.end, `translateX(${px(m.left + m.width)})`);
    // Labels on the two halves while the split holds, and again on the close crop.
    const halves = { start: w.start + toMid, end: w.end - fromMid };
    for (const id of ["lab-a", "lab-b"]) {
      tracks.add(id, "opacity", halves.start, 0, EASE.out).add(id, "opacity", halves.start + 0.16, 1).add(id, "opacity", halves.end - 0.1, 1, EASE.in).add(id, "opacity", halves.end, 0);
      if (plan.detail) tracks.add(id, "opacity", plan.detail.start, 1, EASE.step).add(id, "opacity", plan.detail.end, 1, EASE.step).add(id, "opacity", plan.detail.end, 0);
    }
    labelA = `<span class="lab" id="lab-a" style="left:${px(m.left + 18 * u)};top:${px(m.top + m.height - 18 * u)}">${labelDraft}</span>`;
    compareHtml = `<span class="lab lab-final" id="lab-b" style="right:${px(W - m.left - m.width + 18 * u)};top:${px(m.top + m.height - 18 * u)}">${labelFinal}</span>`;
  }

  // ------------------------------------------------------------ close crop (same frame, up close), cut in and out
  let detailHtml = "";
  if (plan.detail) {
    if (stack) {
      detailHtml = cropPanel("det-a", media.draftFrame, scene, L, L.panel, plan.detail, tracks, 0);
    } else {
      const gap = 3 * u;
      const panel = L.panel;
      const d = plan.detail;
      tracks.add("det", "opacity", d.start, 0, EASE.step).add("det", "opacity", d.start, 1).add("det", "opacity", d.end, 1, EASE.step).add("det", "opacity", d.end, 0);
      tracks.add("det", "transform", d.start, "scale(1.02)", EASE.outStrong).add("det", "transform", d.start + 0.3, "scale(1)");
      detailHtml = `<div class="det" id="det">
${cropPanel("det-l", media.draftFrame, scene, L, panel, null, tracks, 0)}
${cropPanel("det-r", media.finalFrame, scene, L, panel, null, tracks, panel.width + gap)}
<div class="det-line" style="left:${px(panel.width)};width:${px(gap)}"></div>
</div>`;
    }
  }

  // ------------------------------------------------------------ type
  const typeIn = 0.26;
  const typeOut = 0.14;
  const headlines: { id: string; text: string; start: number; end: number }[] = [];
  if (plan.source) headlines.push({ id: "h-src", text: copy.opening, start: plan.source.start, end: plan.source.end });
  headlines.push({ id: "h-draft", text: "Draft.", start: plan.draft.start, end: plan.wipe.start + 0.08 });
  headlines.push({ id: "h-final", text: sameTake ? "Same take. Finished." : "Remaster.", start: plan.wipe.start + 0.08, end: plan.resume.end });
  const headlineHtml = headlines
    .map((h, i) => {
      const size = fitHeadline(h.text, L.headline.size, L.headline.width);
      // One headline at a time in the slot: the next fades in as soon as this one is gone. The first is up from frame 0.
      const inStart = i === 0 ? 0 : h.start;
      if (i === 0) tracks.add(h.id, "opacity", 0, 1, EASE.in);
      else tracks.add(h.id, "opacity", inStart, 0, EASE.out).add(h.id, "opacity", inStart + typeIn * 0.6, 1, EASE.linear);
      tracks.add(h.id, "opacity", h.end - typeOut, 1, EASE.in).add(h.id, "opacity", h.end, 0);
      if (i === 0) tracks.add(h.id, "transform", 0, `translateY(${px(0.12 * size)})`, EASE.outStrong).add(h.id, "transform", typeIn, "translateY(0px)");
      else tracks.add(h.id, "transform", inStart, `translateY(${px(0.3 * size)})`, EASE.outStrong).add(h.id, "transform", inStart + typeIn, "translateY(0px)");
      return `<div class="hl" id="${h.id}" style="font-size:${px(size)}">${escapeHtml(h.text)}</div>`;
    })
    .join("\n");

  // Tags under the card: what plays, in plain words. In a stack they give way to the second card while it is up.
  interface TagSpec {
    id: string;
    text: string;
    start: number;
    end: number;
    slot: 0 | 1 | 2;
    tone?: "final";
  }
  const tags: TagSpec[] = [];
  const hideTags = stack ? { from: plan.wipe.start, to: compareEnd } : null;
  tags.push({ id: "t-draft", text: `Draft, ${copy.draftSize}`, start: plan.draft.start, end: hideTags ? hideTags.from : plan.wipe.start + 0.08, slot: 0 });
  tags.push({ id: "t-final", text: `${sameTake ? "Same take" : "Remaster"}, ${copy.finalSize}`, start: hideTags ? hideTags.to : plan.wipe.start + 0.08, end: plan.resume.end, slot: 0, tone: "final" });
  if (sameTake && !stack) tags.push({ id: "t-frame", text: `Frame ${copy.freezeFrame} of ${copy.frames}`, start: plan.freeze.start, end: compareEnd, slot: 1 });
  if (plan.detail && !stack) tags.push({ id: "t-close", text: "Same moment, up close", start: plan.detail.start, end: plan.detail.end, slot: 2 });
  if (!sameTake) tags.push({ id: "t-drift", text: "Rendered again from the draft. Can drift.", start: plan.wipe.start + 0.08, end: plan.resume.end, slot: 1 });
  const tagWidth = (t: TagSpec) => tagTextWidth(t.text, L.tags.size) + 2 * 0.62 * L.tags.size + (t.tone ? 0.9 * L.tags.size : 0);
  const slotWidth = [0, 1, 2].map((slot) => Math.max(0, ...tags.filter((t) => t.slot === slot).map(tagWidth)));
  // The row may run past the card to the frame's safe edge; what does not fit there wraps to a second row.
  const slots = layoutTagSlots(slotWidth, W - L.gutter - L.tags.left, 12 * u, L.tags.size * 1.7 + 10 * u);
  const tagHtml = tags
    .map((t) => {
      tracks
        .add(t.id, "opacity", t.start, 0, EASE.out)
        .add(t.id, "opacity", t.start + 0.2, 1)
        .add(t.id, "opacity", t.end - typeOut, 1, EASE.in)
        .add(t.id, "opacity", t.end, 0);
      tracks.add(t.id, "transform", t.start, `translateY(${px(8 * u)})`, EASE.outStrong).add(t.id, "transform", t.start + 0.26, "translateY(0px)");
      const at = slots[t.slot]!;
      return `<span class="tag${t.tone ? ` tag-${t.tone}` : ""}" id="${t.id}" style="left:${px(at.left)};top:${px(at.top)}">${t.tone ? '<span class="dot"></span>' : ""}${escapeHtml(t.text)}</span>`;
    })
    .join("\n");
  // In a stack, the frame tag sits inside the second card, top right.
  let stackNotes = "";
  if (stack && sameTake) {
    const B = L.second!;
    const notes = [{ id: "n-frame", text: `Frame ${copy.freezeFrame} of ${copy.frames}`, start: plan.wipe.start + 0.2, end: compareEnd }];
    stackNotes = notes
      .map((n, i) => {
        tracks.add(n.id, "opacity", n.start, 0, EASE.out).add(n.id, "opacity", n.start + 0.2, 1).add(n.id, "opacity", n.end, 1, EASE.step).add(n.id, "opacity", n.end, 0);
        const offset = i === 0 ? 0 : tagTextWidth(notes[0]!.text, 26 * u) + 2 * 14 * u + 10 * u;
        return `<span class="lab lab-note lab-top" id="${n.id}" style="right:${px(W - B.left - B.width + 18 * u + offset)};top:${px(B.top + 18 * u)}">${escapeHtml(n.text)}</span>`;
      })
      .join("\n");
  }

  // The end card: the headline leaves, the final keeps playing in the card, the wordmark takes the row below.
  const mark = plan.endCard;
  tracks.add("mark", "opacity", mark.start + 0.08, 0, EASE.out).add("mark", "opacity", mark.start + 0.42, 1);
  tracks.add("mark", "transform", mark.start + 0.08, `translateY(${px(10 * u)})`, EASE.outStrong).add("mark", "transform", mark.start + 0.5, "translateY(0px)");
  tracks.add("t-final", "opacity", mark.start - 0.001, 1, EASE.step).add("t-final", "opacity", mark.start, 0);

  const css = revealCss(scene, L);
  const data = JSON.stringify({ durationMs: Math.round(plan.duration * 1000), tracks: tracks.toJSON(), loops: [] }).replace(/</g, "\\u003c");
  // Start times to the microsecond, and each clip sought half a frame in: a seek that lands on a frame boundary
  // shows the frame before or after it depending on rounding, one in the middle always shows the frame meant.
  const exact = (v: number) => v.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  const halfFrame = exact(0.5 / plan.fps);
  const video = (id: string, src: string, span: { start: number; end: number }, track: number) =>
    `<video id="${id}" class="pic" src="${escapeHtml(src)}" data-start="${exact(span.start)}" data-duration="${exact(span.end - span.start)}" data-media-start="${halfFrame}" data-track-index="${track}" muted playsinline preload="auto"></video>`;
  const srcHtml = plan.source && media.source ? `<div class="pic-wrap" id="src"><img class="pic on" id="src-m" src="${escapeHtml(media.source)}" alt=""></div>` : "";
  const m = L.media;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Nightshift reveal</title>
<style>
${fontFaces}
${css}
</style>
</head>
<body>
<div id="root" data-composition-id="${REVEAL_COMPOSITION_ID}" data-width="${W}" data-height="${H}" data-duration="${exact(plan.duration)}" data-no-timeline class="theme-${scene.theme} compare-${L.compare}">
<div class="bg"></div>
<div class="grain"></div>
<div class="grp" id="grp">
<div class="card" id="still" style="left:${px(m.left)};top:${px(m.top)};width:${px(m.width)};height:${px(m.height)}">
${srcHtml}
${video("draft", media.draftHead, plan.draft, 0)}
<img class="pic" id="dframe" src="${escapeHtml(media.draftFrame)}" alt="">
${stack ? "" : `<img class="pic" id="fframe" src="${escapeHtml(media.finalFrame)}" alt="">`}
${video("final", media.finalPlay, { start: plan.resume.start, end: plan.endCard.end }, 1)}
${detailHtml}
<div class="ring"></div>
</div>
${labelA}
${stack ? "" : '<div class="edge" id="edge"></div>'}
<div class="type">
<div class="hls">
${headlineHtml}
</div>
<div class="tags">
${tagHtml}
</div>
<div class="mark" id="mark"><div class="mark-name"><span class="mark-dot"></span>Nightshift</div><div class="mark-line">Drafted by day. Finished overnight.</div></div>
</div>
</div>
${compareHtml}
${stackNotes}
<div class="fade" id="fade"></div>
</div>
<script>window.__NIGHTSHIFT__ = ${data};</script>
<script>${PAGE_ANIMATOR}</script>
</body>
</html>
`;
}

/**
 * A close crop of one frozen frame, filling a panel: the image is sized so the crop window covers the panel and
 * offset to the window. With `span` it cuts in and out on its own; without, its parent does.
 */
function cropPanel(id: string, src: string, scene: RevealScene, L: RevealLayout, panel: { width: number; height: number }, span: { start: number; end: number } | null, tracks: Tracks, left: number): string {
  const px = (v: number) => `${fmt(v)}px`;
  const win = cropWindow(scene.crop, L.media, panel);
  const imgW = panel.width / win.w;
  const imgH = panel.height / win.h;
  if (span) {
    tracks.add(id, "opacity", span.start, 0, EASE.step).add(id, "opacity", span.start, 1).add(id, "opacity", span.end, 1, EASE.step).add(id, "opacity", span.end, 0);
    tracks.add(id, "transform", span.start, "scale(1.02)", EASE.outStrong).add(id, "transform", span.start + 0.3, "scale(1)");
  }
  return `<div class="det-p" id="${id}" style="left:${px(left)};width:${px(panel.width)};height:${px(panel.height)}${span ? ";opacity:0" : ""}"><img src="${escapeHtml(src)}" alt="" style="position:absolute;width:${px(imgW)};height:${px(imgH)};left:${px(-win.x * imgW)};top:${px(-win.y * imgH)}"></div>`;
}

function revealCss(scene: RevealScene, L: RevealLayout): string {
  const { width: W, height: H, theme } = scene;
  const u = L.u;
  const px = (v: number) => `${fmt(v)}px`;
  const dark = theme === "dark";
  const bg = dark ? "#0e0f11" : "#f3f3f5";
  const sheen = dark
    ? "linear-gradient(180deg, #1a1b20 0%, #111216 45%, #0b0c0e 100%), radial-gradient(120% 70% at 50% -10%, #23242a 0%, #0e0f11 60%)"
    : "linear-gradient(180deg, #ffffff 0%, #f3f3f5 50%, #e9e9ec 100%)";
  const text = dark ? "#ededef" : "#1d1d1f";
  const muted = dark ? "rgba(237,237,239,0.72)" : "rgba(29,29,31,0.7)";
  const line = dark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.14)";
  const tagBg = dark ? "rgba(255,255,255,0.075)" : "rgba(255,255,255,0.9)";
  const amber = dark ? "#ffb454" : "#c97d0f";
  const glow = dark ? "rgba(255,180,84,0.6)" : "rgba(201,125,15,0.35)";
  const font = fontStack("inter");
  const hair = Math.max(1, u);
  return `
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:${bg}}
#root{position:relative;width:${W}px;height:${H}px;overflow:hidden;background:${bg};color:${text};font-family:${font};font-synthesis:${fontSynthesis("inter")};-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision;font-feature-settings:"tnum" 1,"cv11" 1}
.bg{position:absolute;inset:0;background:${sheen}}
.grain{position:absolute;inset:0;background:url("grain.png") repeat;background-size:${px(192 * u)} ${px(192 * u)};opacity:${dark ? 0.07 : 0.05};mix-blend-mode:${dark ? "screen" : "multiply"};pointer-events:none}
.grp{position:absolute;inset:0;z-index:2}
.card{position:absolute;overflow:hidden;border-radius:${px(L.radius)};background:#050506;transform-origin:50% 50%;isolation:isolate}
.card.second{opacity:0;z-index:3}
.ring{position:absolute;inset:0;border-radius:${px(L.radius)};box-shadow:inset 0 0 0 ${px(hair)} ${line};pointer-events:none;z-index:9}
.pic{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:50% 50%;display:block;opacity:0;transform-origin:50% 50%}
.pic.on{opacity:1}
.pic-wrap{position:absolute;inset:0;opacity:0;overflow:hidden}
#fframe{z-index:3}
#dframe{z-index:2}
#final{z-index:4}
.det{position:absolute;inset:0;z-index:5;opacity:0;transform-origin:50% 50%;background:#050506}
.det-p{position:absolute;top:0;overflow:hidden;background:#050506;z-index:5;transform-origin:50% 50%}
.det-line{position:absolute;top:0;height:100%;background:${bg};z-index:6}
.lab{position:absolute;z-index:12;transform:translateY(-100%);display:inline-flex;align-items:center;gap:${px(8 * u)};font-size:${px(28 * u)};font-weight:500;letter-spacing:-0.01em;color:#fff;background:rgba(8,8,10,0.66);backdrop-filter:blur(${px(12 * u)});padding:${px(8 * u)} ${px(14 * u)};border-radius:999px;line-height:1.2;white-space:nowrap;opacity:0;box-shadow:inset 0 0 0 ${px(hair)} rgba(255,255,255,0.18)}
.lab b{font-weight:500;color:rgba(255,255,255,0.66)}
.lab-final{box-shadow:inset 0 0 0 ${px(hair)} rgba(255,180,84,0.55)}
.lab-final::before{content:"";width:${px(9 * u)};height:${px(9 * u)};border-radius:50%;background:#ffb454;box-shadow:0 0 ${px(8 * u)} rgba(255,180,84,0.6)}
.lab-top{transform:none}
.lab-note{font-size:${px(26 * u)};color:rgba(255,255,255,0.86)}
.edge{position:absolute;top:${px(L.media.top)};height:${px(L.media.height)};left:0;width:${px(3 * u)};margin-left:${px(-1.5 * u)};background:#fff;opacity:0;box-shadow:0 0 ${px(18 * u)} rgba(255,255,255,0.75),0 0 ${px(40 * u)} rgba(255,255,255,0.35);z-index:8}
.type{position:absolute;inset:0;pointer-events:none;z-index:10}
.hls{position:absolute;left:${px(L.headline.left)};width:${px(L.headline.width)};top:0;height:${px(L.headline.bottom)}}
.hl{position:absolute;left:0;bottom:0;white-space:nowrap;font-weight:600;letter-spacing:-0.035em;line-height:1;color:${text};opacity:0}
.tags{position:absolute;left:${px(L.tags.left)};top:${px(L.tags.top)};width:${px(W - L.gutter - L.tags.left)};height:${px(L.tags.size * 1.7 * 2 + 10 * u)}}
.tag{position:absolute;display:inline-flex;align-items:center;gap:${px(10 * u)};height:${px(L.tags.size * 1.7)};padding:0 ${px(L.tags.size * 0.62)};border-radius:999px;font-size:${px(L.tags.size)};font-weight:500;letter-spacing:-0.01em;line-height:1;white-space:nowrap;color:${text};background:${tagBg};box-shadow:inset 0 0 0 ${px(hair)} ${line};opacity:0}
.tag .dot{width:${px(10 * u)};height:${px(10 * u)};border-radius:50%;background:${amber};box-shadow:0 0 ${px(8 * u)} ${glow}}
.tag-final{box-shadow:inset 0 0 0 ${px(hair)} ${dark ? "rgba(255,180,84,0.5)" : "rgba(201,125,15,0.45)"}}
.mark{position:absolute;left:${px(L.mark.left)};top:${px(L.mark.top)};opacity:0}
.mark-name{display:inline-flex;align-items:center;gap:${px(16 * u)};font-size:${px(L.mark.size)};font-weight:600;letter-spacing:-0.03em;line-height:1;color:${text}}
.mark-dot{width:${px(0.28 * L.mark.size)};height:${px(0.28 * L.mark.size)};border-radius:50%;background:${amber};box-shadow:0 0 ${px(14 * u)} ${glow}}
.mark-line{margin-top:${px(14 * u)};font-size:${px(0.5 * L.mark.size)};font-weight:500;letter-spacing:-0.01em;line-height:1.2;color:${muted}}
.fade{position:absolute;inset:0;background:${bg};opacity:0;z-index:20}
`;
}
