/**
 * The HyperFrames composition for a timeline: one HTML page that draws the picture, the cards and the captions.
 * Layout and motion are computed here from the timeline and its style; the page only plays the keyframes back.
 * Sound is not part of the page: the exporter mixes it with ffmpeg.
 *
 * Every card and caption lives inside the frame's safe area: on 9:16 the top strip, the bottom fifth and the right
 * edge belong to the social apps' own controls, so nothing of ours goes there. The subject of each shot (measured
 * by the focus finder as a box, head to feet) is a keep-out: captions, lyrics, titles and name tags take the band
 * above or below it, or the side beside it, and never cross it while a clear place exists. See
 * docs/design/export-templates.md.
 */
import type { Aspect, Caption, Marker, Overlay } from "@nightshift/contract";
import type { FontId, TimelineStyle } from "../style.js";
import { fontStack, fontSynthesis } from "./fonts.js";
import { CAPTION_METRICS, captionCss, captionLine } from "./captions.js";
import { EASE, PAGE_ANIMATOR, Tracks } from "./tracks.js";

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A rectangle in frame pixels. */
export type Rect = Box;

export interface SceneClip {
  kind: "video" | "image";
  /** Path relative to the composition folder. Video clips are pre-trimmed, so they play from 0. */
  src: string;
  start: number;
  end: number;
  /** Where a crop into another shape centres, 0..1 each way in the source. */
  focus: { x: number; y: number };
  /** Where the subject is in the source, 0..1 each way, so cards keep away from it. Defaults to the focus. */
  subject?: { x: number; y: number };
  /** How far the subject extends in the source over the clip, 0..1 each way. Without one, a modest box around the subject point. */
  box?: Box;
  /** The same per sampled frame, evenly spaced over the clip, for a subject that moves or grows. */
  boxes?: Box[];
  /** Mean brightness of horizontal strips of the source, top to bottom, 0..1. Decides how dark a scrim behind text gets. */
  rows?: number[];
  srcWidth: number;
  srcHeight: number;
}

export interface Scene {
  width: number;
  height: number;
  fps: number;
  duration: number;
  aspect: Aspect;
  style: TimelineStyle;
  clips: SceneClip[];
  overlays: (Overlay & { imageSrc?: string })[];
  captions: Caption[];
  markers: Marker[];
}

export interface Composition {
  html: string;
  fonts: FontId[];
  grain: boolean;
}

export const COMPOSITION_ID = "nightshift";

type Shape = "landscape" | "portrait" | "square";

/** Margins the social apps' own UI covers, as fractions of the frame. Text stays inside them. */
export const SAFE_AREA: Record<Shape, { top: number; bottom: number; left: number; right: number }> = {
  landscape: { top: 0.06, bottom: 0.07, left: 0.05, right: 0.05 },
  portrait: { top: 0.13, bottom: 0.22, left: 0.06, right: 0.12 },
  square: { top: 0.06, bottom: 0.07, left: 0.06, right: 0.06 },
};

/** Where a caption block's bottom edge sits by default, from the frame's bottom, as a fraction of the height. */
const CAPTION_BOTTOM: Record<TimelineStyle["captions"]["position"], Record<Shape, number>> = {
  bottom: { landscape: 0.08, portrait: 0.24, square: 0.09 },
  lower: { landscape: 0.12, portrait: 0.32, square: 0.13 },
  // Lyrics: the block grows upwards from a fixed line just under the middle, so lines never jump around.
  middle: { landscape: 0.38, portrait: 0.4, square: 0.38 },
};

/**
 * The lowest a caption block's top edge goes when the captions take the upper band (under the titles' band, so the
 * two never meet). Above a subject, the block sits as low as the subject's head allows, up to this line.
 */
const CAPTION_TOP: Record<Shape, number> = { landscape: 0.36, portrait: 0.37, square: 0.36 };

/** Where a centred title's middle sits by default in each band, as a fraction of the picture (film) or the frame. */
const TITLE_CENTRE = {
  cinematic: { upper: { landscape: 0.25, portrait: 0.27, square: 0.25 }, lower: { landscape: 0.76, portrait: 0.56, square: 0.76 } },
  intro: { upper: { landscape: 0.25, portrait: 0.27, square: 0.25 }, lower: { landscape: 0.64, portrait: 0.56, square: 0.62 } },
};

/** Where a name tag's bottom edge sits by default, from the frame's bottom. */
const TAG_BOTTOM: Record<Shape, number> = { landscape: 0.24, portrait: 0.23, square: 0.24 };

export interface Layout {
  shape: Shape;
  W: number;
  H: number;
  /** 1% of the short side: the unit everything is sized in. */
  u: number;
  /** Type unit: text on a phone-shaped frame needs to be bigger than the short side alone suggests. */
  t: number;
  /** Pixels from each edge that the social apps' own controls may cover. */
  safe: { top: number; bottom: number; left: number; right: number };
  letterbox: number;
  picture: { top: number; height: number };
}

export function layoutFor(scene: Pick<Scene, "width" | "height" | "style">): Layout {
  const { width: W, height: H, style } = scene;
  const u = Math.min(W, H) / 100;
  const portrait = H > W * 1.05;
  const square = !portrait && W < H * 1.05;
  const shape: Shape = portrait ? "portrait" : square ? "square" : "landscape";
  const t = u * pick(shape, { landscape: 1, square: 1.12, portrait: 1.28 });
  const letterbox = shape === "landscape" && style.picture.letterbox && W / H < style.picture.letterbox ? (H - W / style.picture.letterbox) / 2 : 0;
  const s = SAFE_AREA[shape];
  return {
    shape,
    W,
    H,
    u,
    t,
    safe: { top: s.top * H, bottom: s.bottom * H, left: s.left * W, right: s.right * W },
    letterbox,
    picture: { top: letterbox, height: H - 2 * letterbox },
  };
}

export function buildComposition(scene: Scene, fontFaces: string): Composition {
  const { width: W, height: H, style } = scene;
  const L = layoutFor(scene);
  const tracks = new Tracks();
  const fonts = new Set<FontId>([style.fonts.body, style.fonts.display]);
  if (style.captions.enabled && scene.captions.length) fonts.add(style.fonts.captions);

  const clipHtml = scene.clips.map((clip, i) => clipMarkup(scene, clip, i, tracks, L.picture)).join("\n");
  // Captions are placed first, once for the whole film; cards then keep clear of them as well as of the subject.
  const captions = style.captions.enabled && scene.captions.length ? captionsMarkup(scene, tracks, L) : { html: "", keepouts: () => [] };
  const overlayHtml = scene.overlays.map((o, i) => overlayMarkup(scene, o, i, tracks, L, captions.keepouts(o.start, o.end))).join("\n");
  const grain = style.picture.grain > 0;
  if (grain) {
    const values = Array.from({ length: 8 }, (_, i) => {
      const x = ((i * 37) % 97) - 48;
      const y = ((i * 61) % 89) - 44;
      return `translate(${x}px, ${y}px)`;
    });
    tracks.loops.push({ id: "grain", prop: "transform", values, periodSec: 8 / scene.fps });
  }
  fadeAndFlash(scene, tracks);

  const css = baseCss(scene, L);
  const data = JSON.stringify({ durationMs: Math.round(scene.duration * 1000), tracks: tracks.toJSON(), loops: tracks.loops }).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Nightshift</title>
<style>
${fontFaces}
${css}
</style>
</head>
<body>
<div id="root" data-composition-id="${COMPOSITION_ID}" data-width="${W}" data-height="${H}" data-duration="${fmt(scene.duration)}" data-no-timeline class="look-${style.look} ${L.shape}">
<div class="stage">
${clipHtml}
</div>
${style.picture.vignette > 0 ? '<div class="vignette"></div>' : ""}
${grain ? '<div class="grain-wrap"><div class="grain" id="grain"></div></div>' : ""}
${L.letterbox > 0 ? '<div class="bar bar-top"></div><div class="bar bar-bottom"></div>' : ""}
<div class="overlays">
${overlayHtml}
</div>
${captions.html}
<div class="flash" id="flash"></div>
<div class="fade" id="fade"></div>
</div>
<script>window.__NIGHTSHIFT__ = ${data};</script>
<script>${PAGE_ANIMATOR}</script>
</body>
</html>
`;
  return { html, fonts: [...fonts], grain };
}

// ---------------------------------------------------------------- picture

function clipMarkup(scene: Scene, clip: SceneClip, i: number, tracks: Tracks, picture: { top: number; height: number }): string {
  const { style } = scene;
  const prev = scene.clips[i - 1];
  const next = scene.clips[i + 1];
  const id = `k${i}`;
  const overlapIn = prev ? Math.max(0, prev.end - clip.start) : 0;
  const overlapOut = next ? Math.max(0, clip.end - next.start) : 0;

  // Visibility, and the transitions on either side.
  if (overlapIn > 0.02) {
    const from = style.transition.kind === "dip" ? clip.start + overlapIn / 2 : clip.start;
    tracks.add(id, "opacity", clip.start, 0, EASE.linear).add(id, "opacity", from, 0, EASE.inOut).add(id, "opacity", clip.start + overlapIn, 1);
  } else {
    tracks.add(id, "opacity", clip.start, 0, EASE.step).add(id, "opacity", clip.start, 1);
  }
  if (overlapOut > 0.02 && style.transition.kind === "dip") {
    tracks.add(id, "opacity", next!.start, 1, EASE.inOut).add(id, "opacity", next!.start + overlapOut / 2, 0);
  } else {
    tracks.add(id, "opacity", clip.end, 1, EASE.step).add(id, "opacity", clip.end, 0);
  }

  // A hit on a hard cut.
  const hardCut = prev !== undefined && overlapIn <= 0.02;
  if (hardCut && style.transition.accent === "punch") {
    tracks.add(id, "transform", clip.start, "scale(1.075)", EASE.outStrong).add(id, "transform", clip.start + 0.32, "scale(1)");
  }
  if (hardCut && style.transition.accent === "whip") {
    tracks.add(id, "transform", clip.start, "translateX(7%)", EASE.outStrong).add(id, "transform", clip.start + 0.22, "translateX(0%)");
    tracks.add(id, "filter", clip.start, "blur(18px)", EASE.out).add(id, "filter", clip.start + 0.22, "blur(0px)");
  }
  if (next && clip.end - next.start <= 0.02 && style.transition.accent === "whip") {
    tracks.add(id, "transform", clip.end - 0.12, "translateX(0%)", EASE.in).add(id, "transform", clip.end, "translateX(-7%)");
    tracks.add(id, "filter", clip.end - 0.12, "blur(0px)", EASE.in).add(id, "filter", clip.end, "blur(18px)");
  }

  // Slow motion on the picture: Ken Burns on stills, an optional push on video.
  const motion = clip.kind === "image" ? style.picture.stillMotion : style.picture.videoMotion;
  if (motion > 0) {
    const drift = clip.kind === "image" ? (i % 2 === 0 ? 1 : -1) * motion * 30 : 0;
    tracks
      .add(`m${i}`, "transform", clip.start, `scale(1) translate(${fmt(-drift / 2)}%, 0%)`, EASE.linear)
      .add(`m${i}`, "transform", clip.end, `scale(${fmt(1 + motion)}) translate(${fmt(drift / 2)}%, 0%)`);
  }

  // Bump on every downbeat inside the clip.
  if (style.beatPulse > 0) {
    const beats = scene.markers.filter((m) => m.kind === "downbeat" && m.t > clip.start + 0.05 && m.t < clip.end - 0.1);
    if (beats.length) {
      tracks.add(`p${i}`, "transform", clip.start, "scale(1)");
      for (const b of beats) {
        tracks
          .add(`p${i}`, "transform", b.t - 0.001, "scale(1)", EASE.out)
          .add(`p${i}`, "transform", b.t + 0.05, `scale(${fmt(1 + style.beatPulse)})`, EASE.out)
          .add(`p${i}`, "transform", b.t + 0.32, "scale(1)");
      }
    }
  }

  const frameW = scene.width;
  const frameH = picture.height;
  // Compare with the export shape, not its decorative cinematic letterbox. Model padding
  // (for example 1280x768 for a 16:9 shot) should never introduce thin blurred side bars.
  const fitBlur = style.picture.reframe === "fit_blur" && Math.abs(Math.log(clip.srcWidth / clip.srcHeight / (scene.width / scene.height))) > Math.log(1.1);
  const position = objectPosition(clip, frameW, frameH);
  const media = (extraClass: string, suffix: string, fit: string, pos: string) => {
    const look = `style="object-fit:${fit};object-position:${pos}"`;
    if (clip.kind === "image") return `<img id="i${i}${suffix}" class="${extraClass}" ${look} src="${escapeAttr(clip.src)}" alt="">`;
    const track = (i % 2) * 2 + (suffix ? 1 : 0);
    return `<video id="v${i}${suffix}" class="clip ${extraClass}" ${look} src="${escapeAttr(clip.src)}" data-start="${fmt(clip.start)}" data-duration="${fmt(clip.end - clip.start)}" data-media-start="0" data-track-index="${track}" muted playsinline preload="auto"></video>`;
  };
  const inner = fitBlur ? `${media("media blur", "b", "cover", "50% 50%")}${media("media", "", "contain", "50% 50%")}` : media("media", "", "cover", position);
  return `<div class="k" id="${id}" style="z-index:${i + 1}"><div class="m" id="m${i}"><div class="p" id="p${i}">${inner}</div></div></div>`;
}

/** The part of the source a frame shows after the crop, in source pixels. */
function cropWindow(clip: Pick<SceneClip, "focus" | "srcWidth" | "srcHeight">, frameW: number, frameH: number): { left: number; top: number; visibleW: number; visibleH: number } {
  const scale = Math.max(frameW / clip.srcWidth, frameH / clip.srcHeight);
  const visibleW = frameW / scale;
  const visibleH = frameH / scale;
  const left = clamp(clip.focus.x * clip.srcWidth - visibleW / 2, 0, Math.max(0, clip.srcWidth - visibleW));
  const top = clamp(clip.focus.y * clip.srcHeight - visibleH / 2, 0, Math.max(0, clip.srcHeight - visibleH));
  return { left, top, visibleW, visibleH };
}

/** object-position that keeps the clip's focus point in view when the frame crops the source. */
export function objectPosition(clip: Pick<SceneClip, "focus" | "srcWidth" | "srcHeight">, frameW: number, frameH: number): string {
  const win = cropWindow(clip, frameW, frameH);
  const axis = (offset: number, size: number, visible: number) => {
    const slack = size - visible;
    return slack < 1 ? 50 : (offset / slack) * 100;
  };
  return `${fmt(axis(win.left, clip.srcWidth, win.visibleW))}% ${fmt(axis(win.top, clip.srcHeight, win.visibleH))}%`;
}

/** The subject's position inside the rendered picture, 0..1 each way, after the crop the frame applies. */
export function subjectInFrame(clip: Pick<SceneClip, "focus" | "subject" | "srcWidth" | "srcHeight">, frameW: number, frameH: number): { x: number; y: number } {
  const win = cropWindow(clip, frameW, frameH);
  const subject = clip.subject ?? clip.focus;
  return { x: clamp((subject.x * clip.srcWidth - win.left) / win.visibleW, 0, 1), y: clamp((subject.y * clip.srcHeight - win.top) / win.visibleH, 0, 1) };
}

/** What the subject helpers need of a clip: its point, and its boxes with the times they were sampled at. */
type SubjectClip = Pick<SceneClip, "focus" | "subject" | "box"> & Partial<Pick<SceneClip, "boxes" | "start" | "end">>;

/**
 * How far the subject extends in the source: over the moment `from`..`to` when the clip was sampled over time (the
 * samples that fall in it, or the nearest), else over the whole clip, else a modest box around the subject point.
 */
export function subjectBox(clip: SubjectClip, from?: number, to?: number): Box {
  const samples = clip.boxes;
  if (samples?.length && from !== undefined && clip.start !== undefined && clip.end !== undefined) {
    const start = clip.start;
    const length = Math.max(1e-6, clip.end - start);
    const at = (i: number) => start + ((i + 0.5) / samples.length) * length;
    const until = Math.max(from, to ?? from);
    let picked = samples.filter((_, i) => at(i) >= from && at(i) <= until);
    if (picked.length === 0) {
      const mid = (from + until) / 2;
      const nearest = samples.reduce((best, _, i) => (Math.abs(at(i) - mid) < Math.abs(at(best) - mid) ? i : best), 0);
      picked = [samples[nearest] as Box];
    }
    return picked.reduce((u, b) => ({ left: Math.min(u.left, b.left), top: Math.min(u.top, b.top), right: Math.max(u.right, b.right), bottom: Math.max(u.bottom, b.bottom) }));
  }
  if (clip.box) return clip.box;
  const s = clip.subject ?? clip.focus;
  return { left: clamp(s.x - 0.08, 0, 1), top: clamp(s.y - 0.15, 0, 1), right: clamp(s.x + 0.08, 0, 1), bottom: clamp(s.y + 0.15, 0, 1) };
}

/** The subject's box inside the rendered picture, 0..1 each way, after the crop the frame applies. */
export function subjectBoxInFrame(clip: SubjectClip & Pick<SceneClip, "srcWidth" | "srcHeight">, frameW: number, frameH: number, from?: number, to?: number): Box {
  const win = cropWindow(clip, frameW, frameH);
  const box = subjectBox(clip, from, to);
  const fx = (v: number) => clamp((v * clip.srcWidth - win.left) / win.visibleW, 0, 1);
  const fy = (v: number) => clamp((v * clip.srcHeight - win.top) / win.visibleH, 0, 1);
  return { left: fx(box.left), top: fy(box.top), right: fx(box.right), bottom: fy(box.bottom) };
}

/**
 * The subject's rectangle in frame pixels for the clip showing at `time`, over the moment until `until` when the
 * subject moves; nothing when no clip shows then.
 */
export function subjectRect(scene: Pick<Scene, "clips">, L: Layout, time: number, until = time): Rect | undefined {
  const clip = clipAt(scene, time);
  if (!clip) return undefined;
  const b = subjectBoxInFrame(clip, L.W, L.picture.height, time, until);
  return { left: b.left * L.W, right: b.right * L.W, top: L.picture.top + b.top * L.picture.height, bottom: L.picture.top + b.bottom * L.picture.height };
}

/** Whether two rectangles touch, keeping `gap` pixels between them. */
export function intersects(a: Rect, b: Rect, gap = 0): boolean {
  return a.left < b.right + gap && a.right > b.left - gap && a.top < b.bottom + gap && a.bottom > b.top - gap;
}

/** Mean brightness (0..1) of the picture behind a horizontal band of the frame, from the clip's row profile. */
export function bandBrightness(clip: SceneClip, L: Layout, top: number, bottom: number): number | undefined {
  const rows = clip.rows;
  if (!rows?.length) return undefined;
  const win = cropWindow(clip, L.W, L.picture.height);
  const sourceY = (y: number) => (win.top + clamp((y - L.picture.top) / L.picture.height, 0, 1) * win.visibleH) / clip.srcHeight;
  const from = sourceY(top);
  const to = sourceY(bottom);
  let sum = 0;
  let n = 0;
  rows.forEach((v, i) => {
    const overlap = Math.min((i + 1) / rows.length, to) - Math.max(i / rows.length, from);
    if (overlap > 0) {
      sum += v * overlap;
      n += overlap;
    }
  });
  return n > 0 ? sum / n : undefined;
}

/** How dark a band behind text gets: nothing over a dark road, near half black over a bright sky; never under `floor`. */
export function scrimFor(brightness: number | undefined, floor = 0): number {
  if (brightness === undefined) return floor;
  return Math.max(floor, Math.min(SCRIM_MAX, Math.max(0, (brightness - 0.35) / 0.35) * SCRIM_MAX));
}

const SCRIM_MAX = 0.45;

function clipAt(scene: Pick<Scene, "clips">, time: number): SceneClip | undefined {
  return [...scene.clips].reverse().find((c) => c.start <= time + 0.01 && c.end > time);
}

/**
 * Which side of the frame a corner card should take at a moment: the side away from the subject of the clip showing
 * then. Left unless the subject sits in the left part of the picture.
 */
export function cardSide(scene: Pick<Scene, "clips" | "width" | "height" | "style">, time: number): "left" | "right" {
  const clip = clipAt(scene, time);
  if (!clip) return "left";
  const L = layoutFor(scene);
  return subjectInFrame(clip, L.W, L.picture.height).x < 0.45 ? "right" : "left";
}

/**
 * The width a corner card may take on its side without crossing the subject, from the safe edge to the subject's
 * near edge; the whole safe width when nothing shows or the subject sits off that side's path.
 */
export function sideWidth(scene: Pick<Scene, "clips">, L: Layout, time: number, side: "left" | "right"): number {
  const full = L.W - L.safe.left - L.safe.right;
  const subject = subjectRect(scene, L, time);
  if (!subject) return full;
  const g = gapOf(L);
  return clamp(side === "left" ? subject.left - g - L.safe.left : L.W - L.safe.right - (subject.right + g), 0, full);
}

/**
 * Which band the captions took in the old rule, used only when no band can be clear of the subjects: the lower one,
 * unless the subjects sit low in the frame for most of the time captions are up (then they read better above).
 */
export function captionBand(scene: Pick<Scene, "clips" | "captions" | "width" | "height" | "style">): "upper" | "lower" {
  const L = layoutFor(scene);
  let low = 0;
  let high = 0;
  for (const c of scene.captions) {
    const clip = clipAt(scene, (c.start + c.end) / 2);
    if (!clip) continue;
    const length = Math.max(0, c.end - c.start);
    if (subjectInFrame(clip, L.W, L.picture.height).y > 0.58) low += length;
    else high += length;
  }
  return low > high ? "upper" : "lower";
}

/** The keep-out margin between text and the subject, or between two blocks. */
function gapOf(L: Layout): number {
  return 2 * L.u;
}

/** The vertical range text may use: inside the safe area and inside the picture (the letterbox bars are for subtitles only). */
function textRange(L: Layout): { top: number; bottom: number } {
  return { top: Math.max(L.picture.top, L.safe.top), bottom: Math.min(L.picture.top + L.picture.height, L.H - L.safe.bottom) };
}

function fadeAndFlash(scene: Scene, tracks: Tracks): void {
  const { head, tail } = scene.style.transition;
  const D = scene.duration;
  tracks.add("fade", "opacity", 0, head > 0 ? 1 : 0, EASE.inOut);
  if (head > 0) tracks.add("fade", "opacity", Math.min(head, D / 3), 0);
  if (tail > 0) tracks.add("fade", "opacity", Math.max(D - tail, D * 0.6), 0, EASE.inOut).add("fade", "opacity", D, 1);

  const sections = scene.markers.filter((m) => m.kind === "section").map((m) => m.t);
  const cuts = scene.clips.slice(1).filter((c, i) => c.start >= (scene.clips[i] as SceneClip).end - 0.02).map((c) => c.start);
  const flashes = new Set<number>();
  if (scene.style.transition.accent === "flash") for (const t of cuts) flashes.add(t);
  if (scene.style.transition.sectionFlash) for (const t of cuts) if (sections.some((s) => Math.abs(s - t) < 0.35)) flashes.add(t);
  tracks.add("flash", "opacity", 0, 0);
  let lastEnd = -1;
  for (const t of [...flashes].sort((a, b) => a - b)) {
    if (t - 0.04 < lastEnd) continue;
    tracks.add("flash", "opacity", t - 0.04, 0, EASE.in).add("flash", "opacity", t, 0.85, EASE.out).add("flash", "opacity", t + 0.3, 0);
    lastEnd = t + 0.3;
  }
}

// ---------------------------------------------------------------- text measure

/** Average advance per character as a fraction of the font size, per face and treatment. Rough, for layout only. */
const EM = {
  cineTitle: 0.9,
  cineCredit: 0.98,
  introTitle: 0.5,
  introSub: 0.5,
  mvTitle: 0.66,
  mvArtist: 0.86,
  adName: 0.72,
  adTagline: 0.78,
  tagName: 0.54,
  tagRole: 0.7,
};

function textWidth(text: string, fontPx: number, em: number): number {
  return text.length * em * fontPx;
}

function longestWord(text: string): string {
  return text.split(/\s+/).reduce((a, b) => (b.length > a.length ? b : a), "");
}

/** How many lines a text wraps to in a box, by the average advance of its face. Exported for tests. */
export function estimateLines(text: string, fontPx: number, maxWidth: number, em: number): number {
  let lines = 1;
  let width = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const w = textWidth(word, fontPx, em);
    const space = width > 0 ? 0.28 * fontPx : 0;
    if (width > 0 && width + space + w > maxWidth) {
      lines++;
      width = w;
    } else width += space + w;
  }
  return lines;
}

/** Shrinks display type for long titles so they stay on two balanced lines. */
function fitTitle(base: number, text: string, comfortableChars: number): number {
  return base * Math.min(1, Math.sqrt(comfortableChars / Math.max(comfortableChars, text.length)));
}

/** Shrinks type so a whole line fits a width, down to a floor. */
function fitLine(base: number, text: string, maxWidth: number, em: number, floor: number): number {
  const width = textWidth(text, base, em);
  return width <= maxWidth ? base : Math.max(base * floor, (base * maxWidth) / width);
}

/** Shrinks type so its longest word fits a width, down to a floor. */
function fitWord(base: number, text: string, maxWidth: number, em: number, floor = 0.6): number {
  const word = longestWord(text);
  if (!word) return base;
  return Math.max(base * floor, Math.min(base, maxWidth / (word.length * em)));
}

// ---------------------------------------------------------------- placement

export interface CaptionMetrics {
  /** The block's width, px. */
  width: number;
  /** One line's height, px. */
  lineHeight: number;
  /** Extra height around the lines (a pill's padding), px. */
  pad: number;
  linesOf: (caption: Caption) => number;
}

export interface CaptionPlacement {
  anchor: "bar" | "bottom";
  band: "bar" | "lower" | "upper";
  /** The block's bottom edge, px from the frame's bottom (bottom anchor). */
  offset: number;
  /** The tallest caption block, px. */
  need: number;
  /** Darkness of the band behind the block, 0 for none. */
  scrim: number;
  /** The block at its tallest on the film's line, in frame pixels. */
  rect: Rect;
  /** True when every caption that could be clear of its shot's subject is. */
  clear: boolean;
  /** The line each caption uses, in the captions' order: the film's line, or another for a shot with a figure in the way. */
  lines: CaptionLine[];
}

export interface CaptionLine {
  band: "bar" | "lower" | "upper";
  /** The line, px from the frame's bottom. */
  offset: number;
  /** The caption's block on it, in frame pixels. */
  rect: Rect;
}

/** A box much taller than wide, and tall enough to be a person: the one subject captions never cross for a whole shot. */
export function figureLike(subject: Rect, L: Layout): boolean {
  const width = subject.right - subject.left;
  const height = subject.bottom - subject.top;
  return height >= 1.6 * width && height >= 0.3 * L.picture.height;
}

/**
 * Where the captions go: one line for the whole film, so they do not jump. The block always grows up from its
 * bottom line, so one line and two lines share a baseline. Three lines are tried in order: the look's usual line,
 * the lowest line above the apps' controls, and a line just above the subjects' heads (the lowest head decides).
 * The first that keeps every caption off its shot's subject wins; else the one that keeps the most caption time
 * clear. Captions over a subject that fills the frame cannot be clear anywhere and do not vote. If no caption can
 * be clear, the old rule applies: the lower band, unless the subjects sit low. One exception: a shot whose captions
 * would cross a standing figure on the film's line takes the next line that clears it, for all its captions, so
 * the only switch is at that cut. Film subtitles in a letterbox bar stay in the bar. A scrim darkens behind the
 * block when the picture there is bright or a subject is under it.
 */
export function placeCaptions(scene: Pick<Scene, "clips" | "captions" | "width" | "height" | "style">, L: Layout, m: CaptionMetrics): CaptionPlacement {
  const { style } = scene;
  const { shape, letterbox } = L;
  const g = gapOf(L);
  const range = textRange(L);
  const left = (L.W - m.width) / 2;
  const right = left + m.width;
  const needOf = (c: Caption) => m.linesOf(c) * m.lineHeight + m.pad;
  const need = Math.max(m.lineHeight + m.pad, ...scene.captions.map(needOf));
  const at = (top: number, bottom: number): Rect => ({ left, right, top, bottom });
  if (style.captions.look === "subtitle" && letterbox > need + L.u) {
    const rect = at(L.H - letterbox, L.H);
    return { anchor: "bar", band: "bar", offset: 0, need, scrim: 0, rect, clear: true, lines: scene.captions.map(() => ({ band: "bar", offset: 0, rect })) };
  }

  const captions = scene.captions.map((c) => {
    const mid = (c.start + c.end) / 2;
    return { clip: clipAt(scene, mid), subject: subjectRect(scene, L, mid, c.end), need: needOf(c), length: Math.max(0, c.end - c.start) };
  });
  const time = (xs: { length: number }[]) => xs.reduce((s, x) => s + x.length, 0);
  const defaultBottom = L.H - (CAPTION_BOTTOM[style.captions.position][shape] * L.H + letterbox);
  const lowBottom = range.bottom;
  // The upper line: just above the lowest head that leaves room for its caption, no lower than the usual upper line
  // (a one line block's top on it), so captions never drift into the middle of the picture.
  const topLine = CAPTION_TOP[shape] * L.H + letterbox;
  const feasible = captions.filter((x) => x.subject && x.subject.top - g - x.need >= range.top).map((x) => (x.subject as Rect).top - g);
  const upperBottom = feasible.length ? Math.min(topLine + m.lineHeight + m.pad, ...feasible) : topLine + m.lineHeight + m.pad;

  type Candidate = { band: "lower" | "upper"; edge: number; rect: (n: number) => Rect };
  const candidates: Candidate[] = [
    { band: "lower", edge: defaultBottom, rect: (n) => at(defaultBottom - n, defaultBottom) },
    { band: "lower", edge: lowBottom, rect: (n) => at(lowBottom - n, lowBottom) },
    { band: "upper", edge: upperBottom, rect: (n) => at(upperBottom - n, upperBottom) },
  ];
  const inside = (r: Rect) => r.top >= range.top - 0.5 && r.bottom <= range.bottom + 0.5;
  const clearOn = (cand: Candidate, x: (typeof captions)[number]) => inside(cand.rect(x.need)) && (!x.subject || !intersects(cand.rect(x.need), x.subject, g));
  const scored = candidates.map((cand) => ({ cand, clear: captions.filter((x) => clearOn(cand, x)) }));
  const hopeless = captions.filter((x) => !scored.some((s) => s.clear.includes(x)));
  const votable = time(captions) - time(hopeless);
  let chosen: { cand: Candidate; clear: typeof captions };
  if (votable <= 1e-6) {
    chosen = captionBand(scene) === "upper" ? (scored[2] as typeof chosen) : (scored[0] as typeof chosen);
  } else {
    chosen = scored.find((s) => time(s.clear) >= votable - 1e-6) ?? [...scored].sort((a, b) => time(b.clear) - time(a.clear))[0]!;
  }
  const rect = chosen.cand.rect(need);
  // A shot with a standing figure under the film's line takes the next line that clears all of its captions.
  const byClip = new Map<SceneClip | undefined, number[]>();
  captions.forEach((x, i) => byClip.set(x.clip, [...(byClip.get(x.clip) ?? []), i]));
  const lineOf = new Map<number, Candidate>();
  for (const [, group] of byClip) {
    const members = group.map((i) => captions[i]!);
    let cand = chosen.cand;
    const blocked = members.filter((x) => !clearOn(chosen.cand, x));
    if (blocked.length && blocked.every((x) => x.subject && figureLike(x.subject, L))) {
      // Above its own heads, not the film's lowest: a shot where the figure is small is not pushed up by one where
      // the figure grows to fill the frame.
      const heads = members.flatMap((x) => (x.subject ? [x.subject.top - g] : []));
      const ownUpper = Math.min(topLine + m.lineHeight + m.pad, ...heads);
      const own: Candidate[] = [candidates[0]!, candidates[1]!, { band: "upper", edge: ownUpper, rect: (n) => at(ownUpper - n, ownUpper) }];
      cand = own.find((c) => members.every((x) => clearOn(c, x))) ?? chosen.cand;
    }
    for (const i of group) lineOf.set(i, cand);
  }
  const lines: CaptionLine[] = captions.map((x, i) => {
    const cand = lineOf.get(i) ?? chosen.cand;
    return { band: cand.band, offset: L.H - cand.edge, rect: cand.rect(x.need) };
  });
  let bright = 0;
  let weight = 0;
  captions.forEach((x, i) => {
    const own = lines[i]!.rect;
    const b = x.clip ? bandBrightness(x.clip, L, own.top, own.bottom) : undefined;
    if (b === undefined) return;
    bright += b * x.length;
    weight += x.length;
  });
  const clear = votable > 1e-6 && captions.every((x, i) => hopeless.includes(x) || clearOn(lineOf.get(i) ?? chosen.cand, x));
  const covered = time(hopeless) > 0 || !clear;
  const scrim = style.captions.look === "chip" ? 0 : scrimFor(weight > 0 ? bright / weight : undefined, covered ? 0.3 : 0);
  return { anchor: "bottom", band: chosen.cand.band, offset: L.H - chosen.cand.edge, need, scrim, rect, clear, lines };
}

export interface TitlePlacement {
  band: "upper" | "lower";
  /** The block's vertical middle, px from the frame's top. */
  centre: number;
  /** False when neither band has room and the title sits in the lower band over the subject, with a scrim. */
  clear: boolean;
  scrim: number;
}

/**
 * Where a centred title goes: the band above or below the subject of the shot it opens on, whichever has room,
 * the larger when both do. Within the band it sits on the look's usual line, pushed just far enough to clear the
 * subject and the captions (titles sit above captions). With no clear band it takes the lower band over a scrim
 * rather than the face.
 */
export function placeTitle(
  scene: Pick<Scene, "clips" | "width" | "height" | "style">,
  L: Layout,
  o: Pick<Overlay, "start" | "end">,
  need: number,
  centres: { upper: number; lower: number },
  keepouts: Rect[] = [],
  floor = 0,
): TitlePlacement {
  const g = gapOf(L);
  const range = textRange(L);
  const time = o.start + Math.min(1, Math.max(0.1, o.end - o.start) / 2);
  const clip = clipAt(scene, time);
  const subject = subjectRect(scene, L, time, o.end);
  const upper = { top: range.top, bottom: subject ? Math.min(range.bottom, subject.top - g) : range.bottom };
  const lower = { top: subject ? Math.max(range.top, subject.bottom + g) : range.top, bottom: range.bottom };
  for (const k of keepouts) {
    if (k.top < upper.bottom && k.bottom > upper.top) upper.bottom = Math.min(upper.bottom, k.top - g);
    if (k.top < lower.bottom && k.bottom > lower.top) lower.bottom = Math.min(lower.bottom, k.top - g);
  }
  const roomU = upper.bottom - upper.top;
  const roomL = lower.bottom - lower.top;
  let band: "upper" | "lower";
  let clear = true;
  if (roomU >= need && roomL >= need) band = roomU > roomL ? "upper" : "lower";
  else if (roomU >= need) band = "upper";
  else if (roomL >= need) band = "lower";
  else {
    band = "lower";
    clear = false;
  }
  const room = band === "upper" ? upper : lower;
  const centre = clear ? clamp(centres[band], room.top + need / 2, room.bottom - need / 2) : centres[band];
  const brightness = clip ? bandBrightness(clip, L, centre - need / 2, centre + need / 2) : undefined;
  return { band, centre, clear, scrim: scrimFor(brightness, clear ? floor : Math.max(floor, 0.35)) };
}

export interface TagMetrics {
  /** The tag's natural width with its text on one line, px. */
  width: number;
  /** The narrowest the tag can get before its longest word breaks, px. */
  minWidth: number;
  /** The tag's height when its text wraps to the width it gets, px. */
  heightAt: (width: number) => number;
  /** Transparent run-out on the tag's open side (its gradient fades there), px. It may overlap the keep-out gap. */
  fade: number;
}

export interface TagPlacement {
  side: "left" | "right";
  /** The tag's bottom edge, px from the frame's bottom. */
  bottom: number;
  maxWidth: number;
  /** False when the tag could not keep off the subject and sits in its usual place over a stronger scrim. */
  clear: boolean;
  /** Alpha of the gradient behind the tag. */
  scrim: number;
}

/**
 * Where a name tag goes: on the side away from the subject, at its usual height, narrowed so it stops short of the
 * subject (the role wraps; only the tag's transparent run-out may reach into the gap). When that side is too narrow
 * for its longest word, it takes the full width in the band below the subject, then just above the head; around
 * captions and other cards either way. With no clear place it keeps its usual spot over a stronger scrim.
 */
export function placeNameTag(scene: Pick<Scene, "clips" | "width" | "height" | "style">, L: Layout, o: Pick<Overlay, "start" | "end">, m: TagMetrics, keepouts: Rect[] = []): TagPlacement {
  const g = gapOf(L);
  const range = textRange(L);
  const time = o.start + 0.2;
  const clip = clipAt(scene, time);
  const subject = subjectRect(scene, L, time, o.end);
  const side = cardSide(scene, time);
  const edge = side === "left" ? L.safe.left : L.W - L.safe.right;
  const fullWidth = Math.min(m.width, (L.W - L.safe.left - L.safe.right) * 0.62);
  const rectAt = (bottom: number, width: number): Rect => {
    const height = m.heightAt(width);
    const solid = width - m.fade;
    return side === "left" ? { left: edge, right: edge + solid, top: bottom - height, bottom } : { left: edge - solid, right: edge, top: bottom - height, bottom };
  };
  const defaultBottom = L.H * (1 - TAG_BOTTOM[L.shape]);
  const fits = (r: Rect) => r.top >= range.top && r.bottom <= range.bottom && (!subject || !intersects(r, subject, g)) && keepouts.every((k) => !intersects(r, k, g));
  const done = (r: Rect, width: number, clear: boolean): TagPlacement => {
    const brightness = clip ? bandBrightness(clip, L, r.top, r.bottom) : undefined;
    return { side, bottom: L.H - r.bottom, maxWidth: width, clear, scrim: clear ? 0.42 + scrimFor(brightness) * 0.5 : 0.62 };
  };
  const aroundKeepouts = keepouts.flatMap((k) => [k.top - g, (width: number) => k.bottom + g + m.heightAt(width)]);
  // 1. The free side, beside the subject.
  const free = sideWidth(scene, L, time, side) + m.fade;
  if (free >= m.minWidth) {
    const width = Math.min(fullWidth, free);
    for (const b of [defaultBottom, ...aroundKeepouts]) {
      const r = rectAt(typeof b === "function" ? b(width) : b, width);
      if (fits(r)) return done(r, width, true);
    }
  }
  // 2. A band across the subject's column: below it, then just above its head.
  const bottoms: (number | ((width: number) => number))[] = [defaultBottom, range.bottom, ...aroundKeepouts, ...(subject ? [subject.top - g] : [])];
  for (const b of bottoms) {
    const r = rectAt(typeof b === "function" ? b(fullWidth) : b, fullWidth);
    if (fits(r)) return done(r, fullWidth, true);
  }
  return done(rectAt(defaultBottom, fullWidth), fullWidth, false);
}

// ---------------------------------------------------------------- cards

function pick<T>(shape: Shape, values: { landscape: T; portrait: T; square: T }): T {
  return values[shape];
}

/** Keeps an element invisible until `start`, then shows it at once (its parts animate in on their own). */
function hideUntil(tracks: Tracks, id: string, start: number): Tracks {
  return tracks.add(id, "opacity", 0, 0, EASE.step).add(id, "opacity", start, 1);
}

/** A soft dark band behind a block of text, full frame width, fading at the top and bottom. */
function bandMarkup(id: string, alpha: number, style: string): string {
  if (alpha <= 0) return "";
  return `<div class="band" id="${id}" style="${style}background:linear-gradient(180deg,rgba(0,0,0,0) 0%,rgba(0,0,0,${fmt(alpha)}) 38%,rgba(0,0,0,${fmt(alpha)}) 62%,rgba(0,0,0,0) 100%);opacity:0"></div>`;
}

function overlayMarkup(scene: Scene, o: Overlay & { imageSrc?: string }, i: number, tracks: Tracks, L: Layout, keepouts: Rect[]): string {
  const id = `o${i}`;
  const text = escapeHtml(o.text);
  const sub = o.subtext ? escapeHtml(o.subtext) : "";
  const len = Math.max(0.1, o.end - o.start);
  const { u, t, shape } = L;

  if (o.kind === "lower_third") return lowerThirdMarkup(scene, o, id, tracks, L, text, sub, keepouts);
  if (o.kind === "end_card") return endCardMarkup(scene, o, id, tracks, L, text, sub);

  if (o.kind === "text") {
    tracks.window(id, o.start, o.end, 0.3, 0.3);
    return `<div class="tx" id="${id}" style="opacity:0">${text}</div>`;
  }

  // Titles: one treatment per look.
  const look = scene.style.look;
  const usable = L.W - L.safe.left - L.safe.right;
  if (look === "cinematic_shot") {
    // Tracked-out capitals centred in the band of the picture clear of the subject, an amber hairline, the credit
    // line underneath. The title settles from a touch larger and out of focus, like a film title. A soft dark band
    // behind it, darker over a bright sky, keeps the thin serif readable.
    const base = pick(shape, { landscape: 5.6, portrait: 6.2, square: 6 }) * u;
    const size = o.text.length <= 18 ? Math.min(base, usable / Math.max(1, o.text.length * EM.cineTitle)) : fitTitle(base, o.text, 18);
    const lines = estimateLines(o.text, size, usable, EM.cineTitle);
    const need = lines * size * 1.15 + 3.1 * t + 0.14 * u + (sub ? 1.6 * t * 1.3 : 0);
    const centres = {
      upper: L.picture.top + L.picture.height * (shape === "portrait" ? 0 : TITLE_CENTRE.cinematic.upper[shape]) + (shape === "portrait" ? L.H * TITLE_CENTRE.cinematic.upper.portrait : 0),
      lower: L.picture.top + L.picture.height * (shape === "portrait" ? 0 : TITLE_CENTRE.cinematic.lower[shape]) + (shape === "portrait" ? L.H * TITLE_CENTRE.cinematic.lower.portrait : 0),
    };
    const place = placeTitle(scene, L, o, need, centres, keepouts, 0.18);
    const fadeIn = Math.min(1.4, len * 0.3);
    const fadeOut = Math.min(1, len * 0.25);
    tracks.window(`${id}g`, o.start, o.end, fadeIn, fadeOut, EASE.inOut);
    tracks.window(`${id}a`, o.start, o.end, fadeIn, fadeOut, EASE.inOut);
    tracks.add(`${id}a`, "transform", o.start, "scale(1.05)", EASE.outStrong).add(`${id}a`, "transform", o.start + Math.min(2.4, len * 0.6), "scale(1)");
    tracks.add(`${id}a`, "filter", o.start, `blur(${fmt(0.6 * u)}px)`, EASE.out).add(`${id}a`, "filter", o.start + Math.min(1.6, len * 0.35), "blur(0px)");
    tracks.add(`${id}r`, "width", o.start + 0.4, "0px", EASE.outStrong).add(`${id}r`, "width", o.start + Math.min(1.6, len * 0.4), `${fmt(7 * u)}px`);
    tracks.window(`${id}r`, o.start + 0.4, o.end, 0.3, fadeOut);
    if (sub) tracks.window(`${id}b`, o.start + Math.min(0.8, len * 0.2), o.end, Math.min(1, len * 0.25), fadeOut);
    return `<div class="title title-cine band-${place.band}${place.clear ? "" : " covered"}" id="${id}" style="top:${fmt(place.centre)}px">${bandMarkup(`${id}g`, place.scrim, "")}<div class="t1" id="${id}a" style="font-size:${fmt(size)}px;opacity:0">${text}</div><div class="rule" id="${id}r" style="opacity:0"></div>${sub ? `<div class="t2" id="${id}b" style="opacity:0">${sub}</div>` : ""}</div>`;
  }
  if (look === "music_video") {
    // A song and artist block bottom left, the way music channels credit a video: a lime rule, the title in heavy
    // capitals rising out of a clip, the artist tracked out under it. It stops short of the subject: beside a
    // centred figure the title stacks one word per line rather than running across the coat.
    const side = cardSide(scene, o.start + 0.3);
    const free = sideWidth(scene, L, o.start + 0.3, side);
    const fullWidth = usable * (shape === "portrait" ? 0.82 : 0.6);
    const base = fitTitle(pick(shape, { landscape: 10, portrait: 11, square: 10 }) * u, o.text, 12);
    const width = free >= textWidth(longestWord(o.text), base * 0.75, EM.mvTitle) ? Math.min(fullWidth, free) : fullWidth;
    const size = fitWord(base, o.text, width, EM.mvTitle, 0.75);
    const subSize = sub ? fitLine(2.2 * t, o.subtext ?? "", width, EM.mvArtist, 0.72) : 0;
    tracks.add(`${id}r`, "width", o.start, "0px", EASE.outStrong).add(`${id}r`, "width", o.start + 0.5, `${fmt(6 * u)}px`);
    tracks.add(`${id}a`, "clip-path", o.start + 0.08, "inset(100% 0% 0% 0%)", EASE.outStrong).add(`${id}a`, "clip-path", o.start + 0.7, "inset(0% 0% 0% 0%)");
    tracks.add(`${id}a`, "transform", o.start + 0.08, `translateY(${fmt(3 * u)}px)`, EASE.outStrong).add(`${id}a`, "transform", o.start + 0.7, "translateY(0px)");
    if (sub) tracks.window(`${id}b`, o.start + 0.4, o.end, 0.4, 0.3);
    hideUntil(tracks, id, o.start).add(id, "opacity", o.end - 0.3, 1, EASE.in).add(id, "opacity", o.end, 0);
    const bottom = L.safe.bottom + pick(shape, { landscape: 4, portrait: 3, square: 3 }) * u;
    const x = side === "left" ? `left:${fmt(L.safe.left)}px` : `right:${fmt(L.safe.right)}px`;
    return `<div class="title title-mv side-${side}" id="${id}" style="bottom:${fmt(bottom)}px;${x};max-width:${fmt(width)}px"><div class="rule" id="${id}r"></div><div class="t1" id="${id}a" style="font-size:${fmt(size)}px;clip-path:inset(100% 0% 0% 0%)">${text}</div>${sub ? `<div class="t2" id="${id}b" style="font-size:${fmt(subSize)}px;opacity:0">${sub}</div>` : ""}</div>`;
  }
  if (look === "product_ad") {
    // The product name in a top corner on the side away from the subject, a coral rule above it, the tagline in
    // tracked capitals. It stops short of the subject when the subject leaves it room; over a product that fills
    // the frame it stays in its corner with a scrim.
    const side = cardSide(scene, o.start + 0.3);
    const free = sideWidth(scene, L, o.start + 0.3, side);
    const fullWidth = usable * (shape === "portrait" ? 0.8 : 0.56);
    const base = fitTitle(pick(shape, { landscape: 9, portrait: 10, square: 9 }) * u, o.text, 11);
    const beside = free >= textWidth(longestWord(o.text), base * 0.75, EM.adName);
    const width = beside ? Math.min(fullWidth, free) : fullWidth;
    const size = fitWord(base, o.text, width, EM.adName, 0.75);
    const subject = subjectRect(scene, L, o.start + 0.3);
    const top = L.safe.top + pick(shape, { landscape: 2, portrait: 3, square: 2 }) * u;
    const height = size * 0.96 * estimateLines(o.text, size, width, EM.adName) + 0.45 * u + 1.6 * t + (sub ? 1.3 * t + 2.4 * t * 1.2 : 0);
    const rect: Rect = { left: side === "left" ? L.safe.left : L.W - L.safe.right - width, right: side === "left" ? L.safe.left + width : L.W - L.safe.right, top, bottom: top + height };
    const covered = Boolean(subject && intersects(rect, subject, gapOf(L)));
    const clip = clipAt(scene, o.start + 0.3);
    const scrim = covered ? Math.max(0.3, scrimFor(clip ? bandBrightness(clip, L, rect.top, rect.bottom) : undefined)) : scrimFor(clip ? bandBrightness(clip, L, rect.top, rect.bottom) : undefined);
    tracks.add(`${id}r`, "width", o.start, "0px", EASE.outStrong).add(`${id}r`, "width", o.start + 0.45, `${fmt(4.5 * u)}px`);
    tracks.add(`${id}a`, "clip-path", o.start + 0.08, "inset(100% 0% 0% 0%)", EASE.outStrong).add(`${id}a`, "clip-path", o.start + 0.65, "inset(0% 0% 0% 0%)");
    tracks.add(`${id}a`, "transform", o.start + 0.08, `translateY(${fmt(1.2 * u)}px)`, EASE.outStrong).add(`${id}a`, "transform", o.start + 0.65, "translateY(0px)");
    if (sub) {
      tracks.add(`${id}b`, "opacity", o.start + 0.4, 0, EASE.out).add(`${id}b`, "opacity", o.start + 0.75, 1);
      tracks.add(`${id}b`, "transform", o.start + 0.4, `translateY(${fmt(0.6 * u)}px)`, EASE.outStrong).add(`${id}b`, "transform", o.start + 0.8, "translateY(0px)");
    }
    hideUntil(tracks, id, o.start).add(id, "opacity", o.end - 0.3, 1, EASE.in).add(id, "opacity", o.end, 0);
    if (scrim > 0) tracks.window(`${id}g`, o.start, o.end, 0.4, 0.3);
    const x = side === "left" ? `left:${fmt(L.safe.left)}px` : `right:${fmt(L.safe.right)}px`;
    return `<div class="title title-ad side-${side}${covered ? " covered" : ""}" id="${id}" style="top:${fmt(top)}px;${x};max-width:${fmt(width)}px">${bandMarkup(`${id}g`, scrim, `left:${fmt(side === "left" ? -L.safe.left : -(L.W - width - L.safe.right))}px;right:${fmt(side === "left" ? -(L.W - width - L.safe.left) : -L.safe.right)}px;`)}<div class="rule" id="${id}r"></div><div class="t1" id="${id}a" style="font-size:${fmt(size)}px;clip-path:inset(100% 0% 0% 0%)">${text}</div>${sub ? `<div class="t2" id="${id}b" style="opacity:0">${sub}</div>` : ""}</div>`;
  }
  // talking_intro: an editorial serif centred in the band clear of the subject, a short sky rule, the subtitle
  // under it, over a soft band when the picture behind is bright.
  const size = fitTitle(pick(shape, { landscape: 6.8, portrait: 8, square: 7.4 }) * u, o.text, 20);
  const lines = estimateLines(o.text, size, usable, EM.introTitle);
  const need = lines * size * 1.04 + 3.6 * t + 0.5 * u + (sub ? 2.6 * t * 1.3 : 0);
  const centres = { upper: L.H * TITLE_CENTRE.intro.upper[shape], lower: L.H * TITLE_CENTRE.intro.lower[shape] };
  const place = placeTitle(scene, L, o, need, centres, keepouts, 0.12);
  tracks.window(`${id}g`, o.start, o.end, 0.5, 0.4);
  tracks.window(`${id}a`, o.start, o.end, 0.5, 0.4);
  tracks.add(`${id}a`, "transform", o.start, `translateY(${fmt(2 * u)}px)`, EASE.outStrong).add(`${id}a`, "transform", o.start + 0.8, "translateY(0px)");
  tracks.add(`${id}r`, "width", o.start + 0.2, "0px", EASE.outStrong).add(`${id}r`, "width", o.start + 0.9, `${fmt(10 * u)}px`);
  tracks.window(`${id}r`, o.start + 0.2, o.end, 0.2, 0.4);
  if (sub) tracks.window(`${id}b`, o.start + 0.4, o.end, 0.5, 0.4);
  return `<div class="title title-in band-${place.band}${place.clear ? "" : " covered"}" id="${id}" style="top:${fmt(place.centre)}px">${bandMarkup(`${id}g`, place.scrim, "")}<div class="t1" id="${id}a" style="font-size:${fmt(size)}px;opacity:0">${text}</div><div class="rule" id="${id}r" style="opacity:0"></div>${sub ? `<div class="t2" id="${id}b" style="opacity:0">${sub}</div>` : ""}</div>`;
}

/**
 * A name tag: a vertical accent bar that grows, the name and role sliding out of it. On the side away from the
 * subject, stopping short of it, with no box, just a soft shadow and a faint gradient so it reads on bright footage.
 */
function lowerThirdMarkup(scene: Scene, o: Overlay, id: string, tracks: Tracks, L: Layout, text: string, sub: string, keepouts: Rect[]): string {
  const { t } = L;
  const fade = 2 * t;
  // Padding, the bar, the gap to the text, and the run-out of the gradient on the open side.
  const chrome = 1.2 * t + 0.5 * t + 1.2 * t + fade;
  const roleSize = 2.1 * t;
  // The name may shrink a little so it stays on one line beside a figure that leaves it a narrow column.
  let nameSize = 4.4 * t;
  const column = sideWidth(scene, L, o.start + 0.2, cardSide(scene, o.start + 0.2)) + fade;
  const natural = textWidth(o.text, nameSize, EM.tagName);
  if (chrome + natural > column) nameSize *= clamp((column - chrome) / Math.max(1, natural), 0.86, 1);
  const nameWidth = textWidth(o.text, nameSize, EM.tagName);
  const roleWidth = o.subtext ? textWidth(o.subtext, roleSize, EM.tagRole) : 0;
  const metrics: TagMetrics = {
    width: chrome + Math.max(nameWidth, roleWidth),
    minWidth: chrome + Math.max(textWidth(longestWord(o.text), nameSize, EM.tagName), o.subtext ? textWidth(longestWord(o.subtext), roleSize, EM.tagRole) : 0),
    heightAt: (width) => {
      const inner = Math.max(1, width - chrome);
      const nameLines = estimateLines(o.text, nameSize, inner, EM.tagName);
      const roleLines = o.subtext ? estimateLines(o.subtext, roleSize, inner, EM.tagRole) : 0;
      return 2.4 * t + nameLines * nameSize * 1.08 + (roleLines ? 0.7 * t + roleLines * roleSize * 1.2 : 0);
    },
    fade,
  };
  const place = placeNameTag(scene, L, o, metrics, keepouts);
  const side = place.side;
  hideUntil(tracks, id, o.start).add(id, "opacity", o.end - 0.35, 1, EASE.inOut).add(id, "opacity", o.end, 0);
  tracks.add(`${id}b`, "transform", o.start, "scaleY(0)", EASE.outStrong).add(`${id}b`, "transform", o.start + 0.45, "scaleY(1)");
  const hidden = side === "left" ? "inset(0% 100% 0% 0%)" : "inset(0% 0% 0% 100%)";
  tracks.add(`${id}n`, "clip-path", o.start + 0.12, hidden, EASE.outStrong).add(`${id}n`, "clip-path", o.start + 0.75, "inset(0% 0% 0% 0%)");
  tracks.add(`${id}n`, "transform", o.start + 0.12, `translateX(${fmt((side === "left" ? -1.5 : 1.5) * t)}px)`, EASE.outStrong).add(`${id}n`, "transform", o.start + 0.8, "translateX(0px)");
  const x = side === "left" ? `left:${fmt(L.safe.left)}px` : `right:${fmt(L.safe.right)}px`;
  const gradient = `linear-gradient(${side === "left" ? 90 : 270}deg,rgba(0,0,0,${fmt(place.scrim)}),rgba(0,0,0,0))`;
  return `<div class="lt side-${side}${place.clear ? "" : " covered"}" id="${id}" style="bottom:${fmt(place.bottom)}px;${x};max-width:${fmt(place.maxWidth)}px;background:${gradient}"><div class="lt-bar" id="${id}b"></div><div class="lt-text" id="${id}n" style="clip-path:${hidden}"><div class="lt-name" style="font-size:${fmt(nameSize)}px">${text}</div>${sub ? `<div class="lt-role">${sub}</div>` : ""}</div></div>`;
}

/**
 * The end card fills the frame: the product photo on one side, a panel in the accent colour on the other with the
 * name, the tagline and the call to action. On a phone the photo takes the top, the panel the rest (its text stays
 * above the social apps' controls). Without a photo the panel takes the whole frame.
 */
function endCardMarkup(scene: Scene, o: Overlay & { imageSrc?: string }, id: string, tracks: Tracks, L: Layout, text: string, sub: string): string {
  const { u, shape } = L;
  const s = o.start;
  const fromBelow = shape !== "landscape";
  tracks.add(id, "opacity", s, 0, EASE.out).add(id, "opacity", s + 0.35, 1);
  if (o.imageSrc) tracks.add(`${id}i`, "transform", s, "scale(1.06)", EASE.linear).add(`${id}i`, "transform", o.end + 0.5, "scale(1)");
  const hidden = fromBelow ? "inset(100% 0% 0% 0%)" : "inset(0% 0% 0% 100%)";
  tracks.add(`${id}p`, "clip-path", s + 0.1, hidden, EASE.outStrong).add(`${id}p`, "clip-path", s + 0.75, "inset(0% 0% 0% 0%)");
  tracks.add(`${id}t`, "clip-path", s + 0.45, "inset(100% 0% 0% 0%)", EASE.outStrong).add(`${id}t`, "clip-path", s + 1.05, "inset(0% 0% 0% 0%)");
  tracks.add(`${id}t`, "transform", s + 0.45, `translateY(${fmt(1.5 * u)}px)`, EASE.outStrong).add(`${id}t`, "transform", s + 1.05, "translateY(0px)");
  tracks.add(`${id}u`, "opacity", s + 0.7, 0, EASE.out).add(`${id}u`, "opacity", s + 1.05, 1);
  tracks.add(`${id}c`, "opacity", s + 0.85, 0, EASE.out).add(`${id}c`, "opacity", s + 1.15, 1);
  tracks.add(`${id}c`, "transform", s + 0.85, "scale(0.82)", EASE.outBack).add(`${id}c`, "transform", s + 1.3, "scale(1)");
  const baseName = fitTitle(pick(shape, { landscape: 12, portrait: 13, square: 12 }) * u, o.text, 11);
  // The phone panel is shorter than half the frame and must also leave the social safe area clear.
  // Fit the whole group, including its gaps and button, rather than just counting title characters.
  const plain = !o.imageSrc;
  const width = plain || shape !== "landscape" ? L.W - L.safe.left - L.safe.right
    : L.W * 0.44 - 5 * u - Math.max(L.safe.right, 5 * u);
  const height = plain ? L.H - L.safe.top - L.safe.bottom
    : shape === "landscape" ? L.H - L.safe.top - L.safe.bottom
    : L.H * (shape === "square" ? 0.45 : 0.44) - 3 * u - L.safe.bottom;
  let scale = 1;
  for (let attempt = 0; attempt < 32; attempt++) {
    const name = baseName * scale;
    const subSize = 3.4 * L.t * scale;
    const ctaSize = 3.2 * L.t * scale;
    const widest = Math.max(textWidth(longestWord(o.text), name, 1),
      o.cta ? textWidth(o.cta, ctaSize, 0.65) + 7.6 * L.t * scale : 0);
    const total = estimateLines(o.text, name, width, 1) * name * 0.96
      + (sub ? 1.8 * L.t * scale + estimateLines(o.subtext ?? "", subSize, width, 0.6) * subSize * 1.25 : 0)
      + (o.cta ? (3.2 + 3.2 + 3.2) * L.t * scale : 0);
    if (widest <= width && total <= height) break;
    scale *= Math.min(0.98, width / Math.max(1, widest), height / Math.max(1, total));
  }
  const nameSize = baseName * scale;
  const photo = o.imageSrc ? `<div class="ec-photo"><img class="ec-img" id="${id}i" src="${escapeAttr(o.imageSrc)}" alt=""></div>` : "";
  return `<div class="ec${o.imageSrc ? "" : " ec-plain"}" id="${id}" style="opacity:0">${photo}<div class="ec-panel" id="${id}p" style="clip-path:${hidden}"><div class="ec-body" style="--ec-scale:${fmt(scale)}"><div class="ec-name" id="${id}t" style="font-size:${fmt(nameSize)}px;clip-path:inset(100% 0% 0% 0%)">${text}</div>${sub ? `<div class="ec-sub" id="${id}u" style="opacity:0">${sub}</div>` : ""}${o.cta ? `<div class="ec-cta" id="${id}c" style="opacity:0">${escapeHtml(o.cta)}</div>` : ""}</div></div></div>`;
}

// ---------------------------------------------------------------- captions

/** The captions' markup, and the blocks cards must keep off while they show: the lines used by captions up in a span. */
function captionsMarkup(scene: Scene, tracks: Tracks, L: Layout): { html: string; keepouts: (from: number, to: number) => Rect[] } {
  const { style } = scene;
  const { u, t, shape, letterbox } = L;
  const look = style.captions.look;
  const items: string[] = [];
  const shown: { caption: Caption; index: number; start: number; end: number }[] = [];
  const bodies: string[] = [];
  scene.captions.forEach((c, i) => {
    const end = Math.min(c.end, scene.duration);
    if (end <= c.start) return;
    shown.push({ caption: c, index: i, start: c.start, end });
    bodies.push(captionLine(look, c, `c${i}`, end, tracks));
  });
  if (bodies.length === 0) return { html: "", keepouts: () => [] };

  const metrics = CAPTION_METRICS[look];
  const size = metrics.size * metrics.shapes[shape] * style.captions.size * u;
  const lineHeight = size * metrics.lineHeight;
  const pad = metrics.pad[1] * size;
  const maxWidth = pick(shape, { landscape: look === "subtitle" ? 0.62 : 0.7, portrait: 0.78, square: 0.84 }) * L.W;
  const linesOf = (c: Caption) => estimateLines(c.text, size, maxWidth - metrics.pad[0] * size, metrics.em);
  const place = placeCaptions(scene, L, { width: maxWidth, lineHeight, pad, linesOf });
  const placement = place.anchor === "bar" ? `bottom:0;height:${fmt(letterbox)}px;` : `bottom:${fmt(place.offset)}px;height:0;`;
  // A caption on another line than the film's sits that much higher or lower inside the block.
  const lift = (w: (typeof shown)[number]) => place.lines[w.index]!.offset - place.offset;
  shown.forEach((w, k) => {
    const delta = place.anchor === "bar" ? 0 : lift(w);
    items.push(`<div class="cap" id="c${w.index}" style="visibility:hidden${delta ? `;bottom:${fmt(delta)}px` : ""}">${bodies[k]}</div>`);
  });
  // The scrim behind the block shows while captions are up, holding through short gaps between them, and grows up
  // from the block's bottom line to each caption's own height, so a one line caption never carries a tall band.
  let band = "";
  if (place.scrim > 0 && place.anchor !== "bar") {
    const reach = 0.6 * lineHeight;
    const heightOf = (c: Caption) => `${fmt(linesOf(c) * lineHeight + pad + 2 * reach)}px`;
    const ordered = [...shown].sort((a, b) => a.start - b.start);
    band = bandMarkup("cband", place.scrim, `bottom:${fmt(-reach)}px;height:${heightOf(ordered[0]!.caption)};`);
    let open: { start: number; end: number } | undefined;
    for (const w of ordered) {
      tracks.add("cband", "height", Math.max(0, w.start - 0.05), heightOf(w.caption), EASE.out).add("cband", "height", w.start + 0.1, heightOf(w.caption));
      tracks.add("cband", "bottom", Math.max(0, w.start - 0.05), `${fmt(lift(w) - reach)}px`, EASE.step);
      if (open && w.start - open.end < 0.6) open.end = Math.max(open.end, w.end);
      else {
        if (open) tracks.window("cband", open.start, open.end, 0.25, 0.25);
        open = { start: w.start, end: w.end };
      }
    }
    if (open) tracks.window("cband", open.start, open.end, 0.25, 0.25);
  }
  const html = `<div class="caps caps-${look} anchor-${place.anchor} band-${place.band}${style.captions.uppercase ? " upper" : ""}" style="${placement}--cap-size:${fmt(size)}px;--cap-width:${fmt(maxWidth)}px">\n${band}${items.join("\n")}\n</div>`;
  const keepouts = (from: number, to: number): Rect[] => {
    if (place.anchor === "bar") return [];
    const used = new Map<number, Rect>();
    for (const w of shown) {
      if (w.end <= from || w.start >= to) continue;
      const line = place.lines[w.index]!;
      const prior = used.get(line.offset);
      used.set(line.offset, prior ? { ...prior, top: Math.min(prior.top, line.rect.top) } : line.rect);
    }
    return [...used.values()];
  };
  return { html, keepouts };
}

// ---------------------------------------------------------------- styles

function baseCss(scene: Scene, L: Layout): string {
  const { style, width: W, height: H } = scene;
  const { u, t, letterbox, safe, shape } = L;
  const p = style.palette;
  const display = style.fonts.display;
  const body = style.fonts.body;
  const caps = style.fonts.captions;
  const photoShare = pick(shape, { landscape: 0.56, portrait: 0.56, square: 0.55 });
  const px = (v: number) => `${fmt(v)}px`;
  return `
:root{--bg:${p.background};--text:${p.text};--accent:${p.accent};--accent-text:${p.accentText};--scrim:${p.scrim};--cap-text:${p.text};--u:${px(u)}}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg)}
#root{position:relative;width:${W}px;height:${H}px;overflow:hidden;background:var(--bg);color:var(--text);font-family:${fontStack(body)};font-synthesis:${fontSynthesis(body)};font-optical-sizing:auto;-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
.stage{position:absolute;left:0;right:0;top:${px(letterbox)};bottom:${px(letterbox)};overflow:hidden;background:var(--bg);isolation:isolate;z-index:0}
.k,.m,.p{position:absolute;inset:0;transform-origin:50% 50%}
.k{opacity:0;overflow:hidden}
.media{position:absolute;inset:0;width:100%;height:100%;display:block}
.media.blur{filter:blur(${px(4 * u)}) brightness(0.55) saturate(1.15);transform:scale(1.15)}
.vignette{position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse 78% 72% at 50% 48%,rgba(0,0,0,0) 52%,rgba(0,0,0,${fmt(style.picture.vignette * 0.85)}) 100%)}
.grain-wrap{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.grain{position:absolute;inset:-64px;background:url("grain.png") repeat;background-size:192px 192px;opacity:${fmt(Math.min(1, style.picture.grain * 1.4))}}
.bar{position:absolute;left:0;right:0;height:${px(letterbox)};background:#000}
.bar-top{top:0}.bar-bottom{bottom:0}
.overlays,.flash,.fade{position:absolute;inset:0;pointer-events:none}
.flash{background:#fff;opacity:0}
.fade{background:var(--bg);opacity:0}
.band{position:absolute;pointer-events:none;z-index:-1}

/* Titles */
.title{position:absolute;display:flex;flex-direction:column;font-family:${fontStack(display)};font-synthesis:${fontSynthesis(display)};isolation:isolate}
.title .t1{line-height:1.02;text-wrap:balance;max-width:100%}
.title .t2{font-family:${fontStack(body)};text-wrap:balance}
.title .rule{height:${px(0.45 * u)};width:0;background:var(--accent);border-radius:${px(0.3 * u)}}
.title-cine,.title-in{left:${px(safe.left)};right:${px(safe.right)};align-items:center;text-align:center;transform:translateY(-50%)}
.title-cine .band,.title-in .band{left:${px(-safe.left)};right:${px(-safe.right)};top:-70%;bottom:-70%}
.title-cine .t1{font-weight:600;text-transform:uppercase;letter-spacing:0.3em;padding-left:0.3em;line-height:1.15;text-shadow:0 ${px(0.2 * u)} ${px(2.4 * u)} rgba(0,0,0,0.6),0 0 ${px(0.8 * u)} rgba(0,0,0,0.45)}
.title-cine .rule{height:${px(0.14 * u)};margin:${px(1.6 * t)} 0 ${px(1.5 * t)};border-radius:0}
.title-cine .t2{font-size:${px(1.6 * t)};font-weight:500;letter-spacing:0.36em;padding-left:0.36em;text-transform:uppercase;opacity:0.92;text-shadow:0 0 ${px(1.6 * u)} rgba(0,0,0,0.7)}
.title-mv{align-items:flex-start;text-align:left}
.title-mv.side-right{align-items:flex-end;text-align:right}
.title-mv .rule{height:${px(0.5 * u)};margin-bottom:${px(1.6 * t)}}
.title-mv .t1{font-weight:800;line-height:0.9;letter-spacing:-0.015em;text-transform:uppercase;text-shadow:0 ${px(0.3 * u)} ${px(2 * u)} rgba(0,0,0,0.45)}
.title-mv .t2{font-weight:600;letter-spacing:0.22em;text-transform:uppercase;margin-top:${px(1.3 * t)};opacity:0.92;text-shadow:0 0 ${px(1.4 * u)} rgba(0,0,0,0.6)}
.title-ad{align-items:flex-start;text-align:left}
.title-ad.side-right{align-items:flex-end;text-align:right}
.title-ad .band{top:${px(-safe.top)};bottom:-60%}
.title-ad .rule{margin-bottom:${px(1.6 * t)}}
.title-ad .t1{font-weight:800;line-height:0.96;letter-spacing:-0.02em;text-shadow:0 ${px(0.3 * u)} ${px(2.4 * u)} rgba(0,0,0,0.4)}
.title-ad .t2{font-weight:600;font-size:${px(2.4 * t)};letter-spacing:0.14em;text-transform:uppercase;opacity:0.94;margin-top:${px(1.3 * t)};text-shadow:0 0 ${px(1.4 * u)} rgba(0,0,0,0.6)}
.title-in .t1{font-weight:600;letter-spacing:-0.015em;line-height:1.04;text-shadow:0 ${px(0.3 * u)} ${px(3 * u)} rgba(0,0,0,0.45)}
.title-in .rule{height:${px(0.5 * u)};margin:${px(2 * t)} 0 ${px(1.6 * t)}}
.title-in .t2{font-size:${px(2.6 * t)};font-weight:500;opacity:0.9;text-shadow:0 0 ${px(1.6 * u)} rgba(0,0,0,0.6)}

/* Name tag */
.lt{position:absolute;display:flex;align-items:stretch;gap:${px(1.2 * t)};padding:${px(1.2 * t)} ${px(2 * t)} ${px(1.2 * t)} ${px(1.2 * t)};border-radius:${px(0.8 * t)}}
.lt.side-right{flex-direction:row-reverse;text-align:right;padding:${px(1.2 * t)} ${px(1.2 * t)} ${px(1.2 * t)} ${px(2 * t)}}
.lt-bar{width:${px(0.5 * t)};flex:none;border-radius:${px(0.25 * t)};background:var(--accent);transform-origin:50% 0%}
.lt-text{min-width:0}
.lt-name{font-family:${fontStack(display)};font-synthesis:${fontSynthesis(display)};font-weight:600;letter-spacing:-0.01em;line-height:1.08;text-wrap:balance;text-shadow:0 ${px(0.2 * u)} ${px(1.6 * u)} rgba(0,0,0,0.6)}
.lt-role{font-weight:500;font-size:${px(2.1 * t)};letter-spacing:0.1em;text-transform:uppercase;opacity:0.88;margin-top:${px(0.7 * t)};line-height:1.2;text-wrap:balance;text-shadow:0 0 ${px(1.2 * u)} rgba(0,0,0,0.7)}

/* End card */
.ec{position:absolute;inset:0;overflow:hidden}
.ec-photo{position:absolute;overflow:hidden;background:var(--bg)}
.ec-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform-origin:50% 50%}
.ec-panel{position:absolute;background:var(--accent);color:var(--accent-text)}
.ec-body{position:absolute;display:flex;flex-direction:column;justify-content:center}
.ec-body>*{max-width:100%;flex-shrink:0;overflow-wrap:anywhere}
.ec-name{font-family:${fontStack(display)};font-synthesis:${fontSynthesis(display)};font-weight:800;letter-spacing:-0.02em;line-height:0.96;text-wrap:balance}
.ec-sub{font-size:calc(${px(3.4 * t)} * var(--ec-scale));font-weight:500;line-height:1.25;margin-top:calc(${px(1.8 * t)} * var(--ec-scale));text-wrap:balance;opacity:0.92}
.ec-cta{align-self:flex-start;margin-top:calc(${px(3.2 * t)} * var(--ec-scale));background:var(--accent-text);color:var(--accent);font-weight:700;font-size:calc(${px(3.2 * t)} * var(--ec-scale));line-height:1;padding:calc(${px(1.6 * t)} * var(--ec-scale)) calc(${px(3.8 * t)} * var(--ec-scale));border-radius:${px(6 * t)};letter-spacing:-0.005em;transform-origin:0% 50%}
.landscape .ec-photo{left:0;top:0;bottom:0;width:${fmt(photoShare * 100)}%}
.landscape .ec-panel{top:0;bottom:0;right:0;width:${fmt((1 - photoShare) * 100)}%}
.landscape .ec-body{left:${px(5 * u)};right:${px(Math.max(safe.right, 5 * u))};top:${px(safe.top)};bottom:${px(safe.bottom)};align-items:flex-start;text-align:left}
.portrait .ec-photo,.square .ec-photo{left:0;right:0;top:0;height:${fmt(photoShare * 100)}%}
.portrait .ec-panel,.square .ec-panel{left:0;right:0;bottom:0;height:${fmt((1 - photoShare) * 100)}%}
.portrait .ec-body,.square .ec-body{left:${px(safe.left)};right:${px(safe.right)};top:${px(3 * u)};bottom:${px(safe.bottom)};align-items:flex-start;text-align:left}
.ec-plain .ec-panel{inset:0;width:auto;height:auto}
.ec-plain .ec-body{left:${px(safe.left)};right:${px(safe.right)};top:${px(safe.top)};bottom:${px(safe.bottom)};align-items:center;text-align:center}
.ec-plain .ec-cta{align-self:center;transform-origin:50% 50%}
.tx{position:absolute;left:10%;right:10%;top:50%;transform:translateY(-50%);text-align:center;font-family:${fontStack(display)};font-size:${px(6 * u)};font-weight:700;text-wrap:balance}

/* Captions */
.caps{position:absolute;left:0;right:0;display:flex;align-items:center;justify-content:center;pointer-events:none;font-family:${fontStack(caps)};font-synthesis:${fontSynthesis(caps)};isolation:isolate}
.caps .band{left:0;right:0}
.cap{position:absolute;width:var(--cap-width);left:50%;margin-left:calc(var(--cap-width) / -2);text-align:center;font-size:var(--cap-size);color:var(--cap-text)}
.anchor-bottom .cap{bottom:0;transform-origin:50% 100%}
.anchor-bar .cap{top:50%;translate:0 -50%}
${captionCss()}
.caps.upper .cap{text-transform:uppercase}
`;
}

// ---------------------------------------------------------------- helpers

export function fmt(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text);
}
