/**
 * `timeline.style`: everything about how a timeline looks and sounds, as plain data, so a designer can restyle a
 * template without touching code. The contract stores it as an open record; this schema gives it shape.
 * Any field can be left out: it falls back to the template's default. Bad values are dropped with a warning.
 */
import type { TemplateId } from "@nightshift/contract";
import { z } from "zod";
import { whatIfStyle } from "./what-if.js";

/**
 * Fonts that ship with the package (all SIL Open Font License). Each template leans on its own pair, so a cinematic
 * shot, a music video, a product ad and a talking intro never look like the same template.
 */
export const FontIdSchema = z.enum([
  "inter",
  /** Inter's display cut (optical sizes): tight, even captions in the manner of a product film. */
  "inter-display",
  "bebas-neue",
  "playfair-display",
  /** Film titles: a Garamond with sharp serifs, tracked out in capitals. */
  "cormorant-garamond",
  /** Editorial display serif with optical sizes; the talking intro's title and name. */
  "fraunces",
  /** Humanist sans; captions and small print. The app's own text face. */
  "instrument-sans",
  /** Clean grotesk for ad copy and chip captions. */
  "archivo",
  /** Wide, heavy display face for product names. */
  "syne",
  /** Grotesk with ink traps and optical sizes; lyrics and song titles. */
  "bricolage-grotesque",
]);
export type FontId = z.infer<typeof FontIdSchema>;

const color = z.string().min(1);

export const TimelineStyleSchema = z.object({
  /** Which composition renders the timeline. Usually the template. */
  look: z.enum(["cinematic_shot", "music_video", "product_ad", "talking_intro"]),
  /** Export frame rate. "auto" follows the clips (24 for LTX shots). */
  fps: z.union([z.literal(24), z.literal(30), z.literal(60), z.literal("auto")]),
  palette: z.object({
    /** Behind the picture: letterbox bars, cards, the frame before the first shot. */
    background: color,
    text: color,
    accent: color,
    /** Text drawn on the accent color. */
    accentText: color,
    /** Dark wash behind text for legibility. */
    scrim: color,
  }),
  fonts: z.object({ display: FontIdSchema, body: FontIdSchema, captions: FontIdSchema }),
  picture: z.object({
    /** How a shot of another shape fills the frame: crop to fill, or fit it over a blurred copy of itself. */
    reframe: z.enum(["crop", "fit_blur"]),
    /** Film aspect ratio for letterbox bars (2.39, 2.0, 1.85). Landscape exports only. null = none. */
    letterbox: z.number().min(1.5).max(3).nullable(),
    vignette: z.number().min(0).max(1),
    grain: z.number().min(0).max(1),
    /** Slow zoom on still images, as a fraction (0.08 = 8% over the clip). */
    stillMotion: z.number().min(0).max(0.5),
    /** Slow push-in on video clips. 0 leaves them alone. */
    videoMotion: z.number().min(0).max(0.3),
  }),
  transition: z.object({
    /** What happens where clips overlap. The timeline's overlaps set the length. */
    kind: z.enum(["dissolve", "dip"]),
    /** Overlap the template builds between shots, in seconds. 0 = hard cuts. */
    duration: z.number().min(0).max(3),
    /** A hit on every hard cut. */
    accent: z.enum(["none", "flash", "punch", "whip"]),
    /** A white flash where the song changes section (music video). */
    sectionFlash: z.boolean(),
    /** Fade up from the background color at the start, and down at the end, in seconds. */
    head: z.number().min(0).max(5),
    tail: z.number().min(0).max(5),
  }),
  /** Scale bump on every downbeat (0.025 = 2.5%). 0 = off. */
  beatPulse: z.number().min(0).max(0.2),
  captions: z.object({
    enabled: z.boolean(),
    /**
     * subtitle: plain film subtitles. karaoke: the spoken word lights up with an underline. chip: the line sits in a
     * dark pill and the spoken word gets an accent chip. kinetic: words land as they are sung.
     */
    look: z.enum(["subtitle", "karaoke", "chip", "kinetic"]),
    position: z.enum(["bottom", "lower", "middle"]),
    /** 1 = the look's default size. */
    size: z.number().min(0.5).max(2),
    uppercase: z.boolean(),
    /** Longest caption line group, in characters, when captions are built from words. */
    maxChars: z.number().int().min(8).max(80),
  }),
  audio: z.object({
    /** Loudness of the finished mix (LUFS). -14 suits social platforms. */
    targetLufs: z.number().min(-30).max(-8),
    /** Voice level before the master. */
    voiceLufs: z.number().min(-40).max(-8),
    /** Song level when nothing talks over it. */
    musicLufs: z.number().min(-40).max(-8),
    /** Song level as a bed under a voice. */
    bedLufs: z.number().min(-50).max(-8),
    /** Shots' own sound (LTX ambience). */
    clipLufs: z.number().min(-50).max(-8),
    /** How far music and clip sound drop while someone speaks, in dB. */
    duckDb: z.number().min(-40).max(0),
    musicFadeIn: z.number().min(0).max(10),
    musicFadeOut: z.number().min(0).max(10),
  }),
});

export type TimelineStyle = z.infer<typeof TimelineStyleSchema>;

/** Film: ivory capitals tracked out over the picture, an amber hairline, subtitles in the letterbox bar. */
const cinematic: TimelineStyle = {
  look: "cinematic_shot",
  fps: "auto",
  palette: { background: "#000000", text: "#F3EEE4", accent: "#E7B356", accentText: "#14110C", scrim: "rgba(0,0,0,0.55)" },
  fonts: { display: "cormorant-garamond", body: "instrument-sans", captions: "instrument-sans" },
  picture: { reframe: "crop", letterbox: 2.39, vignette: 0.35, grain: 0.1, stillMotion: 0.06, videoMotion: 0 },
  // Dissolves overlap the shots, so each one shortens the film: half a second reads as film without eating a
  // 4 s shot. Set duration to 0 for hard cuts.
  transition: { kind: "dissolve", duration: 0.5, accent: "none", sectionFlash: false, head: 0.6, tail: 0.9 },
  beatPulse: 0,
  captions: { enabled: true, look: "subtitle", position: "bottom", size: 1, uppercase: false, maxChars: 44 },
  audio: { targetLufs: -16, voiceLufs: -18, musicLufs: -18, bedLufs: -28, clipLufs: -22, duckDb: -10, musicFadeIn: 1, musicFadeOut: 2 },
};

/** Music video: a lime accent, heavy grotesk lyrics landing on the words, a song and artist block bottom left. */
const musicVideo: TimelineStyle = {
  look: "music_video",
  fps: "auto",
  palette: { background: "#000000", text: "#FFFFFF", accent: "#D9FF3F", accentText: "#0B0B0B", scrim: "rgba(0,0,0,0.45)" },
  fonts: { display: "bricolage-grotesque", body: "bricolage-grotesque", captions: "bricolage-grotesque" },
  picture: { reframe: "crop", letterbox: null, vignette: 0.22, grain: 0.06, stillMotion: 0.12, videoMotion: 0.03 },
  transition: { kind: "dissolve", duration: 0, accent: "punch", sectionFlash: true, head: 0, tail: 1 },
  beatPulse: 0.025,
  captions: { enabled: true, look: "kinetic", position: "middle", size: 1, uppercase: true, maxChars: 22 },
  audio: { targetLufs: -14, voiceLufs: -16, musicLufs: -14, bedLufs: -24, clipLufs: -30, duckDb: -6, musicFadeIn: 0, musicFadeOut: 1.5 },
};

/** Product ad: a coral panel, a wide display name in a corner clear of the subject, captions in a dark pill. */
const productAd: TimelineStyle = {
  look: "product_ad",
  fps: "auto",
  palette: { background: "#0B0B0F", text: "#FFFFFF", accent: "#FF5A3C", accentText: "#FFF6F1", scrim: "rgba(10,10,14,0.72)" },
  fonts: { display: "syne", body: "archivo", captions: "archivo" },
  picture: { reframe: "crop", letterbox: null, vignette: 0.15, grain: 0, stillMotion: 0.08, videoMotion: 0.04 },
  transition: { kind: "dissolve", duration: 0, accent: "punch", sectionFlash: false, head: 0, tail: 0.5 },
  beatPulse: 0,
  captions: { enabled: true, look: "chip", position: "lower", size: 1, uppercase: false, maxChars: 26 },
  audio: { targetLufs: -14, voiceLufs: -16, musicLufs: -16, bedLufs: -26, clipLufs: -34, duckDb: -8, musicFadeIn: 0, musicFadeOut: 1.2 },
};

/** Talking intro: an editorial serif for the title and the name, a sky accent, underlined spoken words. */
const talkingIntro: TimelineStyle = {
  look: "talking_intro",
  fps: "auto",
  palette: { background: "#0E1116", text: "#FFFFFF", accent: "#7DD3FC", accentText: "#0E1116", scrim: "rgba(10,12,16,0.6)" },
  fonts: { display: "fraunces", body: "instrument-sans", captions: "inter-display" },
  picture: { reframe: "crop", letterbox: null, vignette: 0.2, grain: 0, stillMotion: 0.07, videoMotion: 0.02 },
  transition: { kind: "dissolve", duration: 0.4, accent: "none", sectionFlash: false, head: 0.5, tail: 0.8 },
  beatPulse: 0,
  captions: { enabled: true, look: "karaoke", position: "lower", size: 1, uppercase: false, maxChars: 32 },
  audio: { targetLufs: -14, voiceLufs: -16, musicLufs: -18, bedLufs: -28, clipLufs: -34, duckDb: -10, musicFadeIn: 0.5, musicFadeOut: 1.5 },
};

const DEFAULTS: Record<TemplateId, TimelineStyle> = {
  what_if: whatIfStyle,
  cinematic_shot: cinematic,
  music_video: musicVideo,
  product_ad: productAd,
  talking_intro: talkingIntro,
  // Quick shots export one clean shot: the cinematic look without letterbox, titles or captions.
  camera_move: {
    ...cinematic,
    picture: { ...cinematic.picture, letterbox: null, vignette: 0, grain: 0, stillMotion: 0 },
    transition: { ...cinematic.transition, duration: 0, head: 0, tail: 0 },
    captions: { ...cinematic.captions, enabled: false },
  },
  vfx_effect: {
    ...cinematic,
    picture: { ...cinematic.picture, letterbox: null, vignette: 0, grain: 0, stillMotion: 0 },
    transition: { ...cinematic.transition, duration: 0, head: 0, tail: 0 },
    captions: { ...cinematic.captions, enabled: false },
  },
  // A blank project is whatever its tools made: clean shots with short dissolves, captions once there is a voice.
  blank: {
    ...cinematic,
    picture: { ...cinematic.picture, letterbox: null, vignette: 0, grain: 0 },
    transition: { ...cinematic.transition, duration: 0.3, head: 0, tail: 0.3 },
    captions: { ...talkingIntro.captions, enabled: true },
  },
};

export function defaultStyle(template: TemplateId): TimelineStyle {
  return structuredClone(DEFAULTS[template]);
}

export interface ResolvedStyle {
  style: TimelineStyle;
  /** Fields in the stored style that were invalid and fell back to the default. */
  warnings: string[];
}

/**
 * The full style for a timeline: the stored overrides on top of the template's defaults.
 * `look` in the overrides picks which defaults apply, so a product ad can borrow the cinematic look.
 */
export function resolveStyle(template: TemplateId, stored: Record<string, unknown> | undefined): ResolvedStyle {
  const overrides = isPlainObject(stored) ? structuredClone(stored) : {};
  // Quick-shot templates use the cinematic compositor with clean shot defaults.
  if ((template === "camera_move" || template === "vfx_effect" || template === "what_if" || template === "blank") && overrides.look === template) delete overrides.look;
  const lookParse = TimelineStyleSchema.shape.look.safeParse(overrides.look);
  const base = defaultStyle(lookParse.success ? lookParse.data : template);
  const warnings: string[] = [];
  if (overrides.look !== undefined && !lookParse.success) {
    warnings.push(`style.look: ${JSON.stringify(overrides.look)} is not a look, using ${base.look}`);
    delete overrides.look;
  }
  // Drop each invalid field and try again, so one typo does not throw away the rest of a designer's work.
  for (let attempt = 0; attempt < 32; attempt++) {
    const merged = deepMerge(base, overrides);
    const parsed = TimelineStyleSchema.safeParse(merged);
    if (parsed.success) return { style: parsed.data, warnings };
    for (const issue of parsed.error.issues) {
      const path = issue.path.map(String);
      warnings.push(`style.${path.join(".")}: ${issue.message}, using the default`);
      deletePath(overrides, path);
    }
  }
  return { style: base, warnings };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) out[key] = key in base ? deepMerge(base[key], value) : value;
  return out;
}

function deletePath(target: Record<string, unknown>, path: string[]): void {
  if (path.length === 0) return;
  let node: unknown = target;
  for (const key of path.slice(0, -1)) {
    if (!isPlainObject(node)) return;
    node = node[key];
  }
  if (isPlainObject(node)) delete node[path[path.length - 1] as string];
}
