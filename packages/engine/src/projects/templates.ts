/**
 * The four templates as the engine uses them: the visual style added to every prompt, the instructions for the
 * local LLM that drafts the shot list, and the deterministic shot list when there is no LLM (or it fails).
 * That fallback and the form's option tables live in the contract (`fallbackShots`), shared with the UI's mock
 * engine, so a brief gives the same shot list in both.
 */
import { fallbackShots, genres, looks, scriptLines, sentence, sentenceCase, splitLines, templates, type TemplateId } from "@nightshift/contract";
import { z } from "zod";

export interface ShotPlan {
  prompt: string;
  cameraMove?: string;
  durationSec: number;
  line?: string;
}

export const CAMERA_MOVES = [
  "static",
  "dolly_in",
  "dolly_out",
  "pan_left",
  "pan_right",
  "tilt_up",
  "tilt_down",
  "crane_up",
  "orbit_left",
  "orbit_right",
  "handheld",
  "crash_zoom",
] as const;

const MOVE_WORDS: Record<string, string> = {
  static: "The camera holds still.",
  dolly_in: "The camera slowly dollies in.",
  push_in: "The camera slowly pushes in.",
  dolly_out: "The camera slowly pulls back.",
  pull_out: "The camera slowly pulls back.",
  pan_left: "The camera pans left.",
  pan_right: "The camera pans right.",
  truck_left: "The camera trucks left.",
  truck_right: "The camera trucks right.",
  tilt_up: "The camera tilts up.",
  tilt_down: "The camera tilts down.",
  crane_up: "The camera cranes up.",
  crane_down: "The camera cranes down.",
  orbit_left: "The camera orbits left around the subject.",
  orbit_right: "The camera orbits right around the subject.",
  handheld: "Handheld camera, a little drift and breath.",
  crash_zoom: "A fast crash zoom into the subject.",
};

export function cameraMoveWords(move: string | undefined): string {
  if (!move) return "";
  return MOVE_WORDS[move] ?? `Camera: ${move.replace(/_/g, " ")}.`;
}

/** Prompt phrase of a look id from the new-project form (`looks` in the contract). */
const lookPhrase = (id: unknown): string | undefined => looks.find((l) => l.id === id)?.phrase;

/**
 * The voiceover a template's shots carry: none (cinematic shots, music videos, quick shots), a short line or none per
 * shot (a product ad), or the script line it shows, as written (a talking intro).
 */
export type ShotLines = "none" | "short" | "script";

interface TemplateDef {
  /** Appended to every image and video prompt. */
  style: string;
  /** System prompt for the local LLM. It must answer with the JSON shape of `storyboardFormat(lines)`. */
  instructions: string;
  lines: ShotLines;
  fallback(brief: Brief): ShotPlan[];
}

type Brief = Record<string, unknown>;

/** Re-exported for the engine's callers: the voiceover lines a template implies, a script's sentences. */
export { scriptLines, splitLines };

/** Named voice designs from the UI, expressed in Breeze's instruction input. */
export const VOICE_INSTRUCTIONS: Record<string, string> = {
  mara: "A warm clear adult female voice speaking natural American English. Calm, friendly, unhurried.",
  theo: "A bright clear adult male voice speaking natural American English. Upbeat, lively and friendly.",
  june: "A low warm adult female voice speaking natural American English. Steady, measured and composed.",
  kit: "A clear adult voice speaking natural American English. Friendly, quick, conversational and articulate.",
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const LINE: Record<Exclude<ShotLines, "none">, string> = {
  short: "the voiceover over this shot, one short sentence of at most 12 words, or empty",
  script: "the script line this shot shows, exactly as written",
};

/**
 * The JSON shape the shot list is written in. Only templates that speak over their shots ask for a line: a slow card
 * writes about two tokens a second, and a model asked for an optional line fills it anyway (with the whole brief, on
 * an 8 GB card: three minutes of an eight-minute list).
 */
export function storyboardFormat(lines: ShotLines): string {
  const line = lines === "none" ? "" : `,"line":"${LINE[lines]}"`;
  const shape = `{"shots":[{"prompt":"what the camera sees, one or two sentences","cameraMove":"one of ${CAMERA_MOVES.join(", ")}","durationSec":4${line}}]}`;
  const rules = lines === "none" ? "" : ` A line holds only spoken words, without speaker names or stage directions.${lines === "script" ? " Keep every script sentence verbatim." : ""}`;
  return `Answer with JSON only: ${shape}${rules}`;
}

export const TEMPLATES: Record<TemplateId, TemplateDef> = {
  what_if: {
    style: "One continuous imagined transformation, no cuts or text.",
    instructions: "Plan a fictional What-if film in one continuous shot.",
    lines: "none",
    fallback: (brief) => fallbackShots("what_if", brief),
  },
  cinematic_shot: {
    style: "Cinematic film still, shot on 35mm, shallow depth of field.",
    instructions: `You plan a single cinematic shot, or a three-shot sequence when asked, from a short idea. Describe the subject, setting, light and lens in concrete visual terms. Avoid close-ups of faces. ${storyboardFormat("none")}`,
    lines: "none",
    fallback: (brief) => fallbackShots("cinematic_shot", brief),
  },
  music_video: {
    style: "Music video, bold color, stylized lighting, anamorphic lens.",
    instructions: `You plan a music video as a list of shots two bars long that cut on the beat. Vary places, actions and camera moves. Keep people small in frame or in silhouette. ${storyboardFormat("none")}`,
    lines: "none",
    fallback: (brief) => fallbackShots("music_video", brief),
  },
  product_ad: {
    style: "Commercial product film, crisp detail.",
    instructions: `You write a 15-second product ad: a short voiceover script split into shots, each with what the camera sees. The product is the hero of every shot. ${storyboardFormat("short")}`,
    lines: "short",
    fallback: (brief) => fallbackShots("product_ad", brief),
  },
  talking_intro: {
    style: "Clean, quiet visual with room for captions.",
    instructions: `You turn a script into an explainer: one shot per line, each a simple visual that illustrates the line (no people talking to camera, no on-screen text). Keep each line as written. ${storyboardFormat("script")}`,
    lines: "script",
    fallback: (brief) => fallbackShots("talking_intro", brief),
  },
  // Quick shots: one shot from the user's photo, no storyboard writing.
  camera_move: {
    style: "Cinematic, photoreal, natural motion.",
    instructions: `You describe the scene in a photo in one sentence for a single shot. ${storyboardFormat("none")}`,
    lines: "none",
    fallback: (brief) => fallbackShots("camera_move", brief),
  },
  vfx_effect: {
    style: "Cinematic visual effect, photoreal.",
    instructions: `You describe the scene in a photo in one sentence for a single effect shot. ${storyboardFormat("none")}`,
    lines: "none",
    fallback: (brief) => fallbackShots("vfx_effect", brief),
  },
};

/** The full image or video prompt: the shot's prompt as a finished sentence, the camera move, the template's style. */
export function stylePrompt(template: TemplateId, prompt: string, move?: string): string {
  return [sentence(sentenceCase(prompt)), cameraMoveWords(move), TEMPLATES[template].style].filter(Boolean).join(" ");
}

const PlanSchema = z.object({
  shots: z
    .array(
      z.object({
        prompt: z.string().min(1),
        cameraMove: z.string().optional(),
        durationSec: z.coerce.number().positive().optional(),
        line: z.string().optional(),
      }),
    )
    .min(1),
});

/**
 * Parse an LLM answer leniently: take the outermost JSON object, validate, clamp. Undefined if unusable. A line written
 * for a template whose shots carry none is dropped.
 */
export function parseStoryboard(raw: string, lines: ShotLines = "short"): ShotPlan[] | undefined {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const parsed = PlanSchema.safeParse(json);
  if (!parsed.success) return undefined;
  return parsed.data.shots.slice(0, 15).map((s) => {
    const plan: ShotPlan = { prompt: s.prompt.trim(), durationSec: clamp(s.durationSec ?? 4, 1, 12) };
    if (s.cameraMove) plan.cameraMove = s.cameraMove.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (lines !== "none" && s.line?.trim()) plan.line = s.line.trim();
    return plan;
  });
}

/** A valid JSON answer must still fulfill the template the user chose. */
export function conformsToTemplate(template: TemplateId, brief: Brief, plans: ShotPlan[]): boolean {
  const expected = TEMPLATES[template].fallback(brief);
  if (plans.length !== expected.length) return false;
  if (template === "product_ad" || template === "music_video") {
    const duration = plans.reduce((sum, shot) => sum + shot.durationSec, 0);
    const target = template === "product_ad" ? 15 : Number(brief.length) || 30;
    if (duration < target * 0.8 || duration > target * 1.2) return false;
  }
  if (template === "talking_intro") return plans.every((shot, i) => shot.line === expected[i]?.line);
  if (template === "product_ad") return plans.some((shot) => shot.line) && plans.every((shot) => !shot.line || !/^\w+:/.test(shot.line));
  return true;
}

/** The brief as the LLM's user message. Ids (asset references, look and genre ids) are spelled out or left out. */
export function briefForLlm(template: TemplateId, name: string, brief: Brief): string {
  const facts = Object.entries(brief)
    .filter(([k, v]) => (typeof v === "string" || typeof v === "number") && !k.endsWith("AssetId") && k !== "referenceKind" && k !== "songSource")
    .map(([k, v]) => {
      if (k === "look") return `look: ${lookPhrase(v) ?? String(v)}`;
      if (k === "genre") return `genre: ${genres.find((g) => g.id === v)?.label ?? String(v)}`;
      return `${k}: ${String(v)}`;
    });
  const label = templates.find((t) => t.id === template)?.name ?? template;
  return [`Template: ${label}`, `Project: ${name}`, ...facts].join("\n");
}
