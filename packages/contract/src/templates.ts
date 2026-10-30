/**
 * Template copy shared by the UI and the engine: the new-project form's options, and the shot list and voiceover
 * lines a template drafts from a brief when no language model writes them. Copy is user-facing.
 *
 * Brief keys the generator reads (the new-project form's):
 * - cinematic_shot: idea, look, cameraMove, sequence ("one" | "three")
 * - music_video: subject, genre, length ("30" | "60")
 * - product_ad: productName, does, tone
 * - talking_intro: script, visuals ("match" | "abstract" | "broll")
 * - camera_move: photoAssetId, move (a quickMoves id), prompt (optional, what the scene is)
 * - vfx_effect: photoAssetId, effect (a quickEffects id), prompt (optional)
 * - blank: none. A blank project has no shot list; it fills from the project's tools.
 */
import type { Aspect, TemplateId } from "./index.js";
import { fallbackWhatIf } from "./what-if.js";


/**
 * The options of the new-project form, shared by the UI (labels, hints) and the engine (prompt phrases, tempo).
 * Copy is user-facing. Brief keys hold the ids: `look`, `cameraMove`, `genre`, `tone`, `voice`.
 */
export interface TemplateMeta {
  id: TemplateId;
  name: string;
  tagline: string;
  gives: string;
  gets: string;
  defaultAspect: Aspect;
  /** Rough length of the finished video, for the picker. */
  length: string;
}

export interface CameraMoveOption {
  id: string;
  label: string;
  hint: string;
}

export interface LookOption {
  id: string;
  label: string;
  /** Added to image and video prompts. */
  phrase: string;
  /** Index of the placeholder palette the UI mock paints with. */
  palette: number;
}

export interface VoiceOption {
  id: string;
  label: string;
  hint: string;
}

export interface ToneOption {
  id: string;
  label: string;
  hint: string;
}

export interface GenreOption {
  id: string;
  label: string;
  /** Typical tempo. The shot list makes each shot two bars long at it. */
  bpm: number;
  palette: number;
}

export const templates: TemplateMeta[] = [
  {
    id: "blank",
    name: "Blank",
    tagline: "An empty project. You decide what goes in.",
    gives: "Nothing to start with",
    gets: "Images, clips, effects, camera moves, voice and music you make with the tools, cut on one timeline",
    defaultAspect: "16:9",
    length: "Up to you",
  },
  {
    id: "what_if",
    name: "What if?",
    tagline: "One question. One impossible change.",
    gives: "A question, a look and an optional photo",
    gets: "One continuous film with narration, music and captions",
    defaultAspect: "9:16",
    length: "About 15 seconds",
  },
  {
    id: "cinematic_shot",
    name: "Cinematic shot",
    tagline: "One idea, shot like a film.",
    gives: "A line about the shot, a camera move, a look",
    gets: "A short film-grade shot, or a three-shot sequence",
    defaultAspect: "16:9",
    // A shot is one clip of the video model: about 4 s for LTX 2.5, the longest the model lab measured.
    length: "4 to 12 seconds",
  },
  {
    id: "music_video",
    name: "Music video",
    tagline: "A song, cut to the beat.",
    gives: "A song, or a few words to write one, and a subject",
    gets: "A music video with shots that change on the beat",
    defaultAspect: "9:16",
    length: "30 or 60 seconds",
  },
  {
    id: "product_ad",
    name: "Product ad",
    tagline: "Your product, with a voice.",
    gives: "A product photo, its name, what it does, a tone",
    gets: "A 15 second ad with voiceover and captions",
    defaultAspect: "9:16",
    length: "15 seconds",
  },
  {
    id: "talking_intro",
    name: "Talking intro",
    tagline: "Say it, and show it.",
    gives: "A script and a voice",
    gets: "A narrated intro with visuals per line and captions",
    defaultAspect: "16:9",
    length: "Follows your script",
  },
  {
    id: "camera_move",
    name: "Camera move",
    tagline: "Your photo. A camera path.",
    gives: "One photo and a camera move",
    gets: "A shot guided by a camera path through your photo",
    defaultAspect: "16:9",
    length: "4 seconds",
  },
  {
    id: "vfx_effect",
    name: "Effect",
    tagline: "One photo, one effect.",
    gives: "One photo and an effect",
    gets: "A short effect shot that starts from your photo",
    defaultAspect: "9:16",
    length: "4 seconds",
  },
];

/** A quick shot preset. Ids are stable once shipped. */
export interface QuickPreset {
  id: string;
  label: string;
  hint: string;
}

/** Camera moves for the camera_move quick shot (real 3D camera paths through the photo). */
export const quickMoves: QuickPreset[] = [
  { id: "dolly_in", label: "Dolly in", hint: "Close the distance in a smooth, strong move" },
  { id: "push_in", label: "Push in", hint: "Rush toward the subject, then settle" },
  { id: "pull_back", label: "Pull back", hint: "Back away to reveal a much wider view" },
  { id: "crash_zoom", label: "Crash zoom", hint: "Snap to a tight close-up of the subject" },
  { id: "crane_up", label: "Crane up", hint: "Rise above the subject and tilt down" },
  { id: "dolly_zoom", label: "Dolly zoom", hint: "Hold the subject as the background grows" },
];

/** Effects for the vfx_effect quick shot. */
export const quickEffects: QuickPreset[] = [
  { id: "disintegrate", label: "Disintegrate", hint: "Turns to dust and drifts away" },
  { id: "freeze", label: "Freeze", hint: "Frost spreads until it is ice" },
  { id: "ignite", label: "Ignite", hint: "Catches fire" },
  { id: "melt", label: "Melt", hint: "Solid objects turn into a glossy pool" },
  { id: "explode", label: "Shatter", hint: "Solid objects burst into fragments" },
  { id: "bloom", label: "Bloom", hint: "Vines climb and flowers open" },
  { id: "gold", label: "Solid gold", hint: "Turns to polished gold" },
  { id: "crystal", label: "Crystallize", hint: "Grows into iridescent crystal" },
  { id: "levitate", label: "Levitate", hint: "Lifts off and floats in place" },
  { id: "earth_zoom", label: "Earth zoom out", hint: "Product shot, through clouds to Earth" },
];

export const cameraMoves: CameraMoveOption[] = [
  { id: "static", label: "Still camera", hint: "Locked off. Lets the scene move." },
  { id: "dolly_in", label: "Push in", hint: "The camera glides toward the subject." },
  { id: "dolly_out", label: "Pull back", hint: "The camera backs away to reveal more." },
  { id: "pan_left", label: "Pan left", hint: "Turns left across the scene." },
  { id: "pan_right", label: "Pan right", hint: "Turns right across the scene." },
  { id: "crane_up", label: "Rise", hint: "Lifts up and looks down over the scene." },
  { id: "orbit_left", label: "Orbit", hint: "Circles the subject. Keep it under a quarter turn." },
  { id: "handheld", label: "Handheld", hint: "A little drift and breath, documentary feel." },
  { id: "crash_zoom", label: "Crash zoom", hint: "A fast punch toward the subject." },
];

export const looks: LookOption[] = [
  { id: "natural", label: "Natural light", phrase: "natural daylight, true colors, soft shadows", palette: 0 },
  { id: "golden", label: "Golden hour", phrase: "low warm sun, long shadows, amber haze", palette: 1 },
  { id: "neon", label: "Neon night", phrase: "wet streets, neon reflections, deep blue shadows", palette: 2 },
  { id: "overcast", label: "Overcast", phrase: "flat grey sky, muted tones, documentary feel", palette: 3 },
  { id: "noir", label: "Film noir", phrase: "hard single light, black and silver, smoke in the air", palette: 4 },
  { id: "dawn", label: "Blue dawn", phrase: "cold blue light before sunrise, one warm lamp", palette: 5 },
];

export const voices: VoiceOption[] = [
  { id: "mara", label: "Mara", hint: "Warm and calm" },
  { id: "theo", label: "Theo", hint: "Bright and upbeat" },
  { id: "june", label: "June", hint: "Low and steady" },
  { id: "kit", label: "Kit", hint: "Friendly and quick" },
];

export const tones: ToneOption[] = [
  { id: "confident", label: "Confident", hint: "Short lines, big claims, no fluff" },
  { id: "warm", label: "Warm", hint: "Friendly, human, everyday" },
  { id: "playful", label: "Playful", hint: "Light, quick, a wink" },
  { id: "luxury", label: "Luxury", hint: "Slow, quiet, precise" },
];

export const genres: GenreOption[] = [
  { id: "indie", label: "Indie pop", bpm: 118, palette: 1 },
  { id: "synth", label: "Synthwave", bpm: 110, palette: 2 },
  { id: "lofi", label: "Lo-fi", bpm: 84, palette: 5 },
  { id: "rock", label: "Alt rock", bpm: 132, palette: 4 },
  { id: "folk", label: "Folk", bpm: 96, palette: 0 },
  { id: "house", label: "House", bpm: 124, palette: 2 },
];


// ---------------------------------------------------------------- shot lists without a language model

/** A shot the template drafts from the brief. `line` is the voiceover over it (product ad, talking intro). */
export interface FallbackShot {
  prompt: string;
  cameraMove: string;
  durationSec: number;
  line?: string;
  keyframes?: import("./index.js").Keyframe[];
}

type Brief = Record<string, unknown>;

/**
 * The shot list a template drafts from a brief when no language model writes one. Deterministic: the same brief
 * gives the same shots in the UI's mock engine and in the real one.
 */
export function fallbackShots(template: TemplateId, brief: Brief): FallbackShot[] {
  const seed = hash(JSON.stringify(brief) + template);
  switch (template) {
    case "blank":
      return [];
    case "what_if":
      return [fallbackWhatIf(brief)];
    case "camera_move":
    case "vfx_effect": {
      // A quick shot is one shot of the photo; its still is the photo itself.
      const scene = sentence(sentenceCase(str(brief.prompt, "The scene in the photo")));
      return [{ prompt: scene, cameraMove: str(brief.move, "static"), durationSec: 4 }];
    }
    case "cinematic_shot": {
      const idea = sentence(sentenceCase(str(brief.idea, str(brief.prompt, "A lone lighthouse on a cliff as a storm rolls in"))));
      const look = sentenceCase(lookPhrase(brief.look));
      const move = str(brief.cameraMove, "dolly_in");
      // Each shot fits in one LTX 2.5 clip (97 frames at 24 fps, about 4 s).
      if (brief.sequence === "three") {
        return [
          { prompt: `Wide establishing shot. ${idea} ${look}. 35mm, cinematic.`, cameraMove: "static", durationSec: 4 },
          { prompt: `${idea} Closer, the subject fills a third of the frame. ${look}.`, cameraMove: move, durationSec: 4 },
          { prompt: `A detail from the scene: texture, light, a small movement. ${look}. Shallow focus.`, cameraMove: "handheld", durationSec: 3.5 },
        ];
      }
      return [{ prompt: `${idea} ${look}. 35mm, cinematic, shallow depth of field.`, cameraMove: move, durationSec: 4 }];
    }
    case "music_video": {
      const subject = sentence(sentenceCase(str(brief.subject, "a late night drive through an empty city")));
      const genre = genres.find((g) => g.id === brief.genre) ?? genres[0]!;
      const beat = (60 / genre.bpm) * 8; // two bars per shot
      const total = brief.length === "60" ? 60 : 30;
      const count = Math.max(6, Math.round(total / beat));
      const look =
        genre.palette === 2 ? "Neon reflections, deep blue shadows" : genre.palette === 1 ? "Warm golden light, grain" : genre.palette === 4 ? "High contrast, black and silver" : "Soft film color, gentle grain";
      return Array.from({ length: count }, (_, i) => ({
        prompt: `${i === 0 ? "Opening shot" : MUSIC_FRAMING[(i - 1) % MUSIC_FRAMING.length]}. ${subject} ${look}. ${genre.label} mood.`,
        cameraMove: pick(MUSIC_MOVES, seed + 11, i),
        durationSec: Math.round(beat * (i % 3 === 2 ? 0.5 : 1) * 10) / 10,
      }));
    }
    case "product_ad": {
      const name = clause(str(brief.productName, "the product"));
      const Name = sentenceCase(name);
      const does = sentence(`It ${continuing(str(brief.does, "makes mornings easier"))}`);
      const st = sentenceCase(AD_STYLES[str(brief.tone, "confident")] ?? AD_STYLES.confident!);
      const shots: FallbackShot[] = [
        { prompt: `${Name} alone on a surface, slow reveal from darkness. ${st}. Product photography, macro lens.`, cameraMove: "dolly_in", durationSec: 3 },
        { prompt: `Extreme close-up of ${name}: material, edge, texture. ${st}.`, cameraMove: "pan_right", durationSec: 2.5 },
        { prompt: `Hands using ${name}. ${does} ${st}. Natural gesture, shallow focus.`, cameraMove: "handheld", durationSec: 3.5 },
        { prompt: `${Name} in its place in a real room, the moment after use. ${st}.`, cameraMove: "dolly_out", durationSec: 3 },
        { prompt: `${Name} centered, clean backdrop, room for the name. ${st}. End card.`, cameraMove: "static", durationSec: 3 },
      ];
      // Four lines over five shots: the last line belongs to the end card.
      const lines = scriptLines("product_ad", brief);
      [0, 1, 2, 4].forEach((shot, i) => {
        if (lines[i]) shots[shot]!.line = lines[i];
      });
      return shots;
    }
    case "talking_intro": {
      const script = str(brief.script, "Hi, I'm making a show about things that take time. Each week, one slow idea. Let's start.");
      const visuals = str(brief.visuals, "match");
      return splitLines(script)
        .slice(0, 8)
        .map((line, i) => {
          // The line itself, unquoted: image models tend to paint quoted words as text in the picture.
          const prompt =
            visuals === "abstract"
              ? `${sentenceCase(pick(ABSTRACT, seed, i))}. Minimal, calm, caption-friendly.`
              : visuals === "broll"
                ? `${sentenceCase(pick(BROLL, seed, i))}. Cinematic B-roll, muted color.`
                : `${sentence(line)} A quiet, cinematic scene that shows it, with room for captions.`;
          const words = line.split(" ").length;
          return { prompt, cameraMove: i % 2 === 0 ? "dolly_in" : "handheld", durationSec: Math.max(2.5, Math.round((words / 2.6 + 0.6) * 10) / 10), line };
        });
    }
  }
}

/** The voiceover a template implies: the talking intro's script sentences (at most eight), the product ad's pitch. */
export function scriptLines(template: TemplateId, brief: Brief): string[] {
  if (template === "what_if") return fallbackWhatIf(brief).keyframes.map((frame) => frame.line);
  if (template === "talking_intro") return splitLines(str(brief.script)).slice(0, 8);
  if (template !== "product_ad") return [];
  const named = str(brief.productName);
  const Name = named ? sentence(sentenceCase(named)) : "This one.";
  const it = sentence(`It ${continuing(str(brief.does, "makes the small things easier"))}`);
  const tone = str(brief.tone, "confident");
  if (tone === "luxury") return [Name, "Made slowly, for people who notice.", it, `${Name} Quietly better.`];
  if (tone === "playful") return [sentence(`Meet ${named || "this one"}`), `${it} Yes, really.`, "Small thing. Big grin.", `${Name} Go on.`];
  if (tone === "warm") return [named ? sentence(`This is ${named}`) : "This is it.", it, "Made for the mornings you actually have.", `${Name} Welcome home.`];
  return [Name, it, "No setup. No fuss.", `${Name} Done.`];
}

/** A script's sentences, as written (whitespace collapsed). */
export function splitLines(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?…]["”]?)\s+/)
    .map((l) => l.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------- sentences from pieces

const END = /[\s.,;:!?…]+$/u;
const END_IN_QUOTE = /[\s.,;:!?…]+(["”]+)$/u;

/** Text that a sentence continues after: whitespace collapsed, trailing punctuation dropped (inside a closing quote too). */
export function clause(text: string): string {
  let t = text.replace(/\s+/g, " ").trim();
  for (;;) {
    const next = t.replace(END, "").replace(END_IN_QUOTE, "$1");
    if (next === t) return t;
    t = next;
  }
}

/**
 * Text as a finished sentence with exactly one end mark: its own question or exclamation mark if it had one, else a
 * period. A closing quote keeps the mark inside it (`says "open."`), so no period ever follows the quote.
 */
export function sentence(text: string): string {
  const body = clause(text);
  if (!body) return "";
  const tail = /[\s.,;:!?…"”]*$/u.exec(text)?.[0] ?? "";
  const mark = tail.includes("?") ? "?" : tail.includes("!") ? "!" : ".";
  const quote = /["”]+$/u.exec(body)?.[0] ?? "";
  return quote ? `${body.slice(0, -quote.length)}${mark}${quote}` : `${body}${mark}`;
}

/** Capitalize the first letter. */
export function sentenceCase(text: string): string {
  const t = text.trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
}

/**
 * Text that goes on mid-sentence ("It keeps coffee hot"): no end punctuation, and a capital dropped from a plain
 * first word (a phone's auto-capital). Names and acronyms that cannot be told from it ("I", "AI") keep theirs.
 */
function continuing(text: string): string {
  const t = clause(text);
  const first = t.split(" ")[0] ?? "";
  return /^[A-Z][a-z]+$/.test(first) ? t[0]!.toLowerCase() + t.slice(1) : t;
}

// ---------------------------------------------------------------- generator data

const MUSIC_FRAMING = [
  "A close detail within the scene",
  "A low-angle view of the same subject",
  "A wide view with the subject in its surroundings",
  "Light and texture within the scene",
  "A side view of the same subject",
  "A final wide view of the scene",
];

const MUSIC_MOVES = ["dolly_in", "pan_right", "handheld", "static", "crane_up", "dolly_out", "pan_left"];

const AD_STYLES: Record<string, string> = {
  luxury: "slow, quiet, soft light on dark stone, single highlight",
  playful: "bright pastel backdrop, bold shapes, quick energy",
  warm: "morning kitchen light, wood and linen, lived-in",
  confident: "clean studio light, sharp edges, deep shadow",
};

const ABSTRACT = ["slow drifting gradient, soft grain", "paper texture with moving light", "ink in water, dark background", "warm bokeh, out of focus lights", "fine lines drawing themselves", "dust in a sunbeam"];

const BROLL = ["a window at golden hour", "a desk with a lamp and a notebook", "a city street from above, long exposure", "trees moving in wind, backlit", "a hand turning a page", "steam rising from a cup"];

function lookPhrase(id: unknown): string {
  return (looks.find((l) => l.id === id) ?? looks[0]!).phrase;
}

/** FNV-1a: picks the same places and moves for a brief everywhere. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick<T>(arr: readonly T[], seed: number, i: number): T {
  return arr[(seed + i * 7919) % arr.length]!;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim() : fallback;
}
