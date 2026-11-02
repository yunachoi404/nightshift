/**
 * The four templates as the engine uses them: the visual style added to every prompt, the instructions for the
 * local LLM that drafts the shot list, and the deterministic shot list when there is no LLM (or it fails).
 * That fallback and the form's option tables live in the contract (`fallbackShots`), shared with the UI's mock
 * engine, so a brief gives the same shot list in both.
 */
import { dramaLookPhrase, dramaLooks, dramaMoods, fallbackShots, genres, looks, MAX_SHOTS, musicVideoShots, scriptLines, sentence, sentenceCase, splitLines, templates, type FallbackOptions, type TemplateId } from "@nightshift/contract";
import { z } from "zod";

export interface ShotPlan {
  prompt: string;
  cameraMove?: string;
  durationSec: number;
  line?: string;
  /** The project references the shot shows, when only some of them are in it (a micro drama's close-ups). */
  referenceIds?: string[];
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
 * The words a template's shots carry: none (cinematic shots, music videos, quick shots), a short voiceover line or none
 * per shot (a product ad), the script line it shows, as written (a talking intro), or what the character in it says on
 * screen (a micro drama).
 */
export type ShotLines = "none" | "short" | "script" | "dialogue";

interface TemplateDef {
  /** Appended to every image and video prompt, from the project's brief where the brief sets the look. */
  style: string | ((brief: Brief) => string);
  /** System prompt for the local LLM. It must answer with the JSON shape of `storyboardFormat(lines)`. */
  instructions: string;
  lines: ShotLines;
  fallback(brief: Brief, o?: FallbackOptions): ShotPlan[];
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
  dialogue: "what the character in this shot says out loud, at most 10 words, or empty",
};

/**
 * A drama's stills painted its characters' names as neon signs: the image model reads the names it is given for the
 * references as words to letter. Asked plainly, it letters less.
 */
const NO_LETTERING = "No signs, captions or lettering anywhere in the picture.";

/** How a micro drama's lines are said, by its mood. Part of the video prompt, so the voice and the face carry it. */
const DELIVERY: Record<string, string> = {
  romance: "softly, holding back",
  revenge: "coldly, every word measured",
  comedy: "deadpan, perfectly timed",
  thriller: "in a tense low voice",
};

/**
 * The JSON shape the shot list is written in. Only templates that speak over their shots ask for a line: a slow card
 * writes about two tokens a second, and a model asked for an optional line fills it anyway (with the whole brief, on
 * an 8 GB card: three minutes of an eight-minute list). `field` is one line the whole film shares, written once before
 * the shots (a micro drama's setting, a music video's look).
 *
 * A prompt is drawn as a still, so it never names the camera: asked for "camera crane_up to reveal the sky", the image
 * model drew a camera operator and a construction crane. The move goes in `cameraMove`, which only the video hears.
 */
export function storyboardFormat(lines: ShotLines, field?: { key: string; what: string } | { key: string; what: string }[]): string {
  const line = lines === "none" ? "" : `,"line":"${LINE[lines]}"`;
  const head = (Array.isArray(field) ? field : field ? [field] : []).map((f) => `"${f.key}":"${f.what}",`).join("");
  const shape = `{${head}"shots":[{"prompt":"what is in the picture: who or what, the action, the place and the light, in one or two sentences","cameraMove":"one of ${CAMERA_MOVES.join(", ")}","durationSec":4${line}}]}`;
  const camera = " A prompt never mentions the camera or how it moves: the move goes in cameraMove only.";
  const rules = lines === "none" ? "" : ` A line holds only spoken words, without speaker names or stage directions.${lines === "script" ? " Keep every script sentence verbatim." : ""}`;
  return `Answer with JSON only: ${shape}${camera}${rules}`;
}

/** A music video's look, in the shots' own words: what every still and draft is drawn in. See `TEMPLATES.music_video`. */
const MUSIC_LOOK = { key: "look", what: "the look every shot shares: the medium, the materials, the palette and the light, in one line" };
/** A music video's main character or thing, described once and named in every prompt that shows it. See `nameSubject`. */
const MUSIC_SUBJECT = { key: "subject", what: "who the video follows: what they are, their hair and what they wear, in a few words" };

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
    // The look the writer named once (`brief.style`), on every still and draft: a writer that put "claymation" in its
    // first shot only had the other five drawn photoreal.
    style: (brief) => [typeof brief.style === "string" && brief.style.trim() ? sentence(sentenceCase(brief.style)) : "", "Music video, bold color, stylized lighting, anamorphic lens."].filter(Boolean).join(" "),
    instructions: `You plan a music video as a list of shots that cut on the beat and tell what the brief describes in order, from the first shot to the last. Give the video's look once, as "look": the medium, the materials, the palette and the light every shot shares, taken from the brief (claymation, anime, grainy 16mm film...). Give who the video follows once, as "subject", taken from the brief (for example "a young woman with a short silver bob and a teal satin bomber jacket"). Each prompt is drawn on its own, without the others, so every prompt that shows the subject names them with those same words, never only as she, he or they. Each prompt is one moment in that world: who or what is in the picture, what happens, where, and the light. Vary places, actions and camera moves. Keep people small in frame or in silhouette. ${storyboardFormat("none", [MUSIC_LOOK, MUSIC_SUBJECT])}`,
    lines: "none",
    fallback: (brief, o) => fallbackShots("music_video", brief, o),
  },
  product_ad: {
    style: "Commercial product film, crisp detail.",
    instructions: `You write a 15-second product ad: a short voiceover script split into shots, each with what the camera sees. The product is the hero of every shot. ${storyboardFormat("short")}`,
    lines: "short",
    fallback: (brief) => fallbackShots("product_ad", brief),
  },
  micro_drama: {
    // The scene's setting, which the writer names once, keeps every shot in one place: the small writers leave it out of
    // the shot prompts, and each still then invents its own.
    style: (brief) => [typeof brief.setting === "string" && brief.setting.trim() ? sentence(sentenceCase(brief.setting)) : "", `${sentenceCase(dramaLookPhrase(brief.look))}.`, "Vertical drama, cinematic framing.", NO_LETTERING].filter(Boolean).join(" "),
    instructions: `You write one scene of a vertical micro drama, the short episodes people binge on their phones: two characters, high emotion, and a cliffhanger on the last line. Give the scene's setting once, as "setting": the place, the time of day and the light, in one line; every shot stays in it. Shot 1 sets the scene, wide, with no line. Every other shot frames one character in a medium close-up or close-up as they speak, or both in a two-shot. Begin each prompt with the name of the character who speaks in it, then describe their pose, expression and action in concrete visual terms, in at most 35 words. Each line is what the character in that shot says out loud: natural spoken dialogue of at most 10 words. The last line is a twist or a threat that makes people want the next episode. No narration and no on-screen text. ${storyboardFormat("dialogue", { key: "setting", what: "the place, the time of day and the light, in one line" })}`,
    lines: "dialogue",
    fallback: (brief) => fallbackShots("micro_drama", brief),
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
  // A blank project has no shot list: it fills from the project's tools, and its prompts are used as written.
  blank: {
    style: "",
    instructions: `You describe one shot. ${storyboardFormat("none")}`,
    lines: "none",
    fallback: () => [],
  },
};

/** The template's style for a brief: its fixed phrase, or the phrase of the look the brief chose. */
export function templateStyle(template: TemplateId, brief: Brief = {}): string {
  const style = TEMPLATES[template].style;
  return typeof style === "function" ? style(brief) : style;
}

/** The full image or video prompt: the shot's prompt as a finished sentence, the camera move, the template's style. */
export function stylePrompt(template: TemplateId, prompt: string, move?: string, brief: Brief = {}): string {
  return [sentence(sentenceCase(prompt)), cameraMoveWords(move), templateStyle(template, brief)].filter(Boolean).join(" ");
}

/**
 * A shot's video prompt. A micro drama's shot also says its line out loud, in quotes and in the scene's mood, so the
 * video model gives the character in frame the voice and the lips for it. A still never gets the line: image models
 * paint quoted words as text.
 */
export function videoPrompt(template: TemplateId, prompt: string, move: string | undefined, brief: Brief = {}, line?: string, names: string[] = []): string {
  const who = speakerOf(prompt, names) ?? "The character in focus";
  const spoken = template === "micro_drama" && line?.trim() ? `${who} says ${DELIVERY[String(brief.mood)] ?? DELIVERY.romance}, "${line.trim()}" Their lips move with every word.` : "";
  return [sentence(sentenceCase(prompt)), spoken, cameraMoveWords(move), templateStyle(template, brief)].filter(Boolean).join(" ");
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
 * for a template whose shots carry none is dropped, and so are the camera words a prompt slipped in (`withoutCamera`).
 */
export function parseStoryboard(raw: string, lines: ShotLines = "short"): ShotPlan[] | undefined {
  const json = parseJsonAnswer(raw);
  if (json === undefined) return undefined;
  const parsed = PlanSchema.safeParse(json);
  if (!parsed.success) return undefined;
  return parsed.data.shots.slice(0, MAX_SHOTS).map((s) => {
    const plan: ShotPlan = { prompt: withoutCamera(s.prompt.trim()), durationSec: clamp(s.durationSec ?? 4, 1, 12) };
    if (s.cameraMove) plan.cameraMove = s.cameraMove.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (lines !== "none" && s.line?.trim()) plan.line = s.line.trim();
    return plan;
  });
}

/**
 * Words that name the camera or its move. An image model draws them: "camera crane_up" became a camera operator and a
 * construction crane. Only unambiguous ones: "pans left", not "a pan"; a move id the writer copied ("orbit_left").
 */
const CAMERA_WORDS = /\bcameras?\b|\bdoll(?:y|ies|ying)\b|\bcran(?:e[sd]?|ing) (?:up|down|over)\b|\bcrash zoom|\bzoom(?:s|ing)? (?:in|out)\b|\bpan(?:s|ning)? (?:left|right|across)\b|\btracking shot\b|\b[a-z]+_(?:in|out|up|down|left|right|zoom)\b/i;

/**
 * A written prompt with the camera left out. Only the words about the camera go, so the picture and who is in it stay:
 * "The camera tilts down to her face, ..." reads "Her face, ...", and "A low-angle dolly out as she speeds toward us"
 * reads "She speeds toward us". A clause that is about the camera alone goes whole ("The frog floats up, camera crane_up
 * to reveal the sky." reads "The frog floats up."). The move is the shot's `cameraMove`. A prompt that is all camera
 * stays as it is.
 */
export function withoutCamera(prompt: string): string {
  if (!CAMERA_WORDS.test(prompt)) return prompt;
  const kept = splitLines(prompt).map((text) => {
    // Clauses and the marks before them: [clause, mark, clause, mark, clause...].
    const parts = text.split(/(\s*[,;:]\s+|\s+[—–-]+\s+|\s*[—–]+\s*)/);
    const clauses = parts.flatMap((part, i) => (i % 2 ? [] : [{ part: CAMERA_WORDS.test(part) ? cameraFree(part) : part, mark: i ? parts[i - 1]! : "" }]));
    if (clauses.every((c, i) => c.part === parts[i * 2])) return text;
    const left = clauses.filter((c) => c.part);
    return left.length ? sentence(sentenceCase(left.map((c, i) => (i ? c.mark : "") + c.part).join(""))) : "";
  });
  return kept.filter(Boolean).join(" ") || prompt;
}

/** Joins inside a clause: "The camera tilts up as she speeds toward us" is the camera, then her. */
const JOINS = /(\s+(?:as|while|and|then|before|until|when)\s+)/i;
/** A camera move at the head of a clause, up to where the picture starts: "The camera tilts down to", "A slow dolly in on". */
const CAMERA_HEAD = new RegExp(
  [
    String.raw`^(?:the\s+)?cameras?\s+(?:(?:slowly|quickly|gently|smoothly|rapidly|suddenly|then)\s+)?(?:[a-z]+_[a-z]+|crash\s+zooms?|[a-z]+s)(?:\s+(?:up|down|in|out|left|right|back|away|around|across|over|closer|upward|downward))?\s+(?:in\s+on|out\s+from|to|toward|towards|onto|on|over|across|around|into|past|along|through)\s+`,
    String.raw`^(?:an?\s+|the\s+)?(?:(?:slow|fast|quick|sweeping|smooth|gentle|dramatic|sudden|low[- ]angle|high[- ]angle|wide)\s+)*(?:doll(?:y|ies)(?:\s+(?:in|out))?|cran(?:e|es)(?:\s+(?:up|down|over))?|crash\s+zooms?|zooms?(?:\s+(?:in|out))?|pans?(?:\s+(?:left|right|across))?|tilts?(?:\s+(?:up|down))?|push(?:es)?[- ]in|pull(?:s)?[- ](?:back|out)|tracking\s+shot|orbits?|[a-z]+_[a-z]+)(?:\s+(?:in\s+on|to|toward|towards|onto|on|over|across|around|into|past|along|through|of|from))?(?:\s+|$)`,
  ].join("|"),
  "i",
);
/** How a picture's words begin: an article, a pronoun, a possessive or a name. Not a verb ("show the street"). */
const PICTURE_START = /^(?:(?:the|a|an|her|his|their|its|our|she|he|they|it|this|that|these|those|one|two|three|four)\b|[A-Z]|\S+['’]s\b)/;

/** A clause without its words about the camera, or "" when it is about nothing else. */
function cameraFree(clause: string): string {
  const parts = clause.split(JOINS);
  const pieces: { text: string; join: string }[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    let text = parts[i]!;
    if (CAMERA_WORDS.test(text)) {
      // The clause's head may name the camera and then the picture; any later piece about the camera goes whole.
      const rest = i === 0 ? text.replace(CAMERA_HEAD, "") : "";
      text = rest && rest !== text && !CAMERA_WORDS.test(rest) && PICTURE_START.test(rest) ? rest : "";
    }
    if (text) pieces.push({ text, join: i ? parts[i - 1]! : "" });
  }
  return pieces.map((p, i) => (i ? p.join : "") + p.text).join("");
}

/**
 * A music video's subject in every prompt that shows it. The writer gives the subject once ("a young woman with a short
 * silver bob and a teal satin bomber jacket") and is asked to name it in each prompt, but wrote "She skates past..."
 * after shot 1, so every still drew someone else. A prompt that speaks of her or him without the subject's words gets
 * them: in place of a leading "She" or "He", else as a sentence of its own. Changes the plans in place.
 */
export function nameSubject(plans: ShotPlan[], subject: string | undefined): void {
  const who = subject ? clauseOf(subject).replace(/^(?:she|he)\s+is\s+/i, "") : "";
  if (!who) return;
  const marks = contentWords(who);
  for (const plan of plans) {
    const pronoun = /\b(she|her|hers|herself|he|him|his|himself)\b/i.exec(plan.prompt)?.[1]?.toLowerCase();
    if (!pronoun) continue;
    const words = new Set(contentWords(plan.prompt));
    const named = marks.filter((w) => words.has(w)).length;
    if (named >= Math.min(3, Math.ceil(marks.length / 2))) continue;
    const lead = /^(she|he)\s+/i.exec(plan.prompt);
    if (lead) plan.prompt = sentenceCase(who) + " " + plan.prompt.slice(lead[0].length);
    else plan.prompt = `${sentence(plan.prompt)} ${/^(?:she|her|hers|herself)$/.test(pronoun) ? "She" : "He"} is ${who}.`;
  }
}

const STOP = new Set(["with", "and", "the", "her", "his", "their", "from", "into", "onto", "that", "this", "wearing", "who", "has"]);
const contentWords = (text: string) => (text.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w));

/**
 * A micro drama's characters by name: the template's shots say "the first character" and "the second character" (and
 * "the two characters") until the project's character references name them. Changes the plans in place.
 */
export function castNames(plans: ShotPlan[], names: string[]): void {
  const [first, second] = names;
  for (const plan of plans) {
    if (first && second) plan.prompt = plan.prompt.replace(/\bthe two characters\b/gi, `${first} and ${second}`);
    if (first) plan.prompt = plan.prompt.replace(/\bthe first character\b/gi, first);
    if (second) plan.prompt = plan.prompt.replace(/\bthe second character\b/gi, second);
  }
}

/** A character the writer of a micro drama casts when the project has no character photos. */
export interface CastMember {
  name: string;
  /** Age, face, hair and clothes in a few words: the portrait is drawn from it. */
  look: string;
}

/** What the writer is told when it casts the scene itself. Goes with the shot list's own JSON shape. */
export const CAST_INSTRUCTIONS = 'There are no character photos, so cast the two characters yourself: give each a short first name and describe their age, face, hair and clothes in a few words, and use those names in the shot prompts. Add them to the JSON as "characters":[{"name":"...","look":"..."}].';

/** What the writer of a micro drama is told when the characters have photos: the photos give their looks. */
export const CAST_FROM_PHOTOS = "Each character's face, hair and clothes come from their photo, so never describe them; describe only pose, expression, action and the setting.";

const CastSchema = z.object({
  characters: z.array(z.object({ name: z.string().trim().min(1).max(40), look: z.string().trim().min(1).max(300) })).max(6),
});

/** The characters a writer cast in its answer, at most two, by distinct names. Empty when it cast none. */
export function parseCast(raw: string): CastMember[] {
  const parsed = CastSchema.safeParse(parseJsonAnswer(raw));
  if (!parsed.success) return [];
  const seen = new Set<string>();
  return parsed.data.characters.filter((c) => !seen.has(c.name.toLowerCase()) && seen.add(c.name.toLowerCase())).slice(0, 2);
}

/** A line the writer gave the whole film (a micro drama's "setting", a music video's "look"), or undefined. */
export function parseLine(raw: string, key: "setting" | "look" | "product" | "subject"): string | undefined {
  const json = parseJsonAnswer(raw);
  const value = typeof json === "object" && json !== null ? (json as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim().slice(0, 300) : undefined;
}

/** Who speaks a micro drama's shot: the character named first in its prompt, of the given names. */
export function speakerOf(prompt: string, names: string[]): string | undefined {
  const at = (name: string) => prompt.search(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"));
  return names.map((name) => ({ name, i: at(name) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i)[0]?.name;
}

/**
 * What the writer of a product ad is told when there is no product photo: describe the product once, so it is drawn
 * once and every still is drawn from that picture. See `productPrompt`.
 */
export const PRODUCT_LOOK = 'There is no product photo, so design the product yourself: add "product":"what it looks like, its shape, materials and colors, in at most 20 words" to the JSON. Every shot shows this same product.';

/** A product ad's product name, as its reference is named. */
export function productLabel(brief: Brief): string {
  const name = typeof brief.productName === "string" ? brief.productName.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  return name || "The product";
}

/**
 * A product ad's product, drawn once as its reference: from the writer's description, else from what the brief says it
 * does. The whole product alone on a plain ground, and no lettering, which every still would copy.
 */
export function productPrompt(brief: Brief, look?: string): string {
  const does = typeof brief.does === "string" && brief.does.trim() ? `, a product that ${clauseOf(brief.does).replace(/^(it|that)\s+/i, "")}` : "";
  return `Product photo of ${productLabel(brief)}${look ? `, ${clauseOf(look)}` : does}. The whole product alone in the middle of the frame, on a plain soft grey studio background, soft even light, crisp detail. No lettering, labels or logos.`;
}

/** A cast character's portrait prompt: half-body, facing the camera, on a plain ground, in the scene's look. */
export function castPrompt(member: CastMember, brief: Brief): string {
  return `Half-body portrait of ${member.name}, ${clauseOf(member.look)}, facing the camera, plain soft grey studio background. ${templateStyle("micro_drama", brief)}`;
}

const clauseOf = (text: string) => text.replace(/\s+/g, " ").trim().replace(/[.\s]+$/, "");

/**
 * The JSON object in a writer's answer: from its first brace to its last. An answer cut off by the token limit
 * mid-shot is closed after its last whole shot, so the shots it finished still count. Undefined if there is none.
 */
export function parseJsonAnswer(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    // Close the shots array after each earlier "}" in turn, from the end, until the rest parses.
    for (let i = end, tries = 0; i > start && tries < 40; i = raw.lastIndexOf("}", i - 1), tries++) {
      try {
        return JSON.parse(`${raw.slice(start, i + 1)}]}`);
      } catch {
        // keep looking
      }
    }
    return undefined;
  }
}

/**
 * What a valid JSON answer breaks of the template the user chose, as the writer is told on its next try: its own
 * words would get the same answer again. Undefined when it fits. Lengths are not the writer's to get right: a product
 * ad's and a music video's are fitted afterwards (`fitDurations`).
 */
export function templateMisfit(template: TemplateId, brief: Brief, plans: ShotPlan[], o: FallbackOptions = {}): string | undefined {
  const expected = TEMPLATES[template].fallback(brief, o);
  const lines = TEMPLATES[template].lines;
  // A scene may take a shot more or less than asked to land its last line; other templates' shot counts are fixed.
  if (template === "micro_drama" ? Math.abs(plans.length - expected.length) > 1 : plans.length !== expected.length) {
    const keys = lines === "none" ? "prompt, cameraMove and durationSec" : "prompt, cameraMove, durationSec and line";
    return `Your last answer had ${plans.length === 1 ? "1 shot" : `${plans.length} shots`}. Write exactly ${expected.length} separate objects in the shots array, one per shot, each with its own ${keys} keys and no key repeated inside an object.`;
  }
  if (template === "talking_intro") {
    const i = plans.findIndex((shot, k) => shot.line !== expected[k]?.line);
    if (i >= 0) return `Shot ${i + 1}'s line was not the script's sentence ${i + 1}. Each shot's line is one sentence of the script, exactly as written, in order.`;
  }
  // A line is words, not "NAME: words". (A script's own sentence may start "Today:".)
  const labeled = template === "talking_intro" ? undefined : plans.find((shot) => shot.line && /^\w+:/.test(shot.line));
  if (labeled) return `A line began with a speaker's name: "${labeled.line}". A line holds only the words said out loud.`;
  // A scene that talks: most shots say something.
  const spoken = plans.filter((shot) => shot.line).length;
  if (template === "micro_drama" && spoken < 3) return `Only ${spoken} of the shots had a line. Every shot after the first says a line out loud.`;
  if (template === "product_ad" && !spoken) return "No shot had a voiceover line. Give most shots one short line.";
  return undefined;
}

/**
 * A written shot list in its template's time, in place. A product ad's shots share the ad's length in the proportions
 * the writer gave them (a writer copied the format's 4 seconds into each of five shots: a 20 second ad). A music
 * video's shots take its rhythm (`musicVideoShots`): the writer knows neither the bar nor the longest clip.
 */
export function fitDurations(template: TemplateId, brief: Brief, plans: ShotPlan[], o: FallbackOptions = {}): void {
  if (template === "music_video") {
    const { shotSec } = musicVideoShots(brief, o.longestShotSec);
    for (const plan of plans) plan.durationSec = shotSec;
  }
  if (template === "product_ad") {
    const target = TEMPLATES.product_ad.fallback(brief).reduce((sum, shot) => sum + shot.durationSec, 0);
    const written = plans.reduce((sum, shot) => sum + shot.durationSec, 0);
    for (const plan of plans) plan.durationSec = Math.max(1, Math.round((plan.durationSec * target * 10) / written) / 10);
  }
}

/**
 * Room for the writer's whole answer, in tokens: the setting, look or cast, then about 80 a shot, 100 with a line,
 * 120 for a drama's longer prompts. A writer cut off mid-list falls short of the shots asked for.
 */
export function writerTokens(lines: ShotLines, shots: number): number {
  return 200 + shots * (lines === "dialogue" ? 120 : lines === "none" ? 80 : 100);
}

/** The brief as the LLM's user message. Ids (asset references, look and genre ids) are spelled out or left out. */
export function briefForLlm(template: TemplateId, name: string, brief: Brief): string {
  const facts = Object.entries(brief)
    .filter(([k, v]) => (typeof v === "string" || typeof v === "number") && !k.endsWith("AssetId") && k !== "referenceKind" && k !== "songSource")
    .map(([k, v]) => {
      if (k === "look" && template === "micro_drama") return `look: ${dramaLooks.find((l) => l.id === v)?.label ?? String(v)}`;
      if (k === "look") return `look: ${lookPhrase(v) ?? String(v)}`;
      if (k === "genre") return `genre: ${genres.find((g) => g.id === v)?.label ?? String(v)}`;
      if (k === "mood") return `mood: ${dramaMoods.find((m) => m.id === v)?.label ?? String(v)}`;
      return `${k}: ${String(v)}`;
    });
  const label = templates.find((t) => t.id === template)?.name ?? template;
  return [`Template: ${label}`, `Project: ${name}`, ...facts].join("\n");
}
