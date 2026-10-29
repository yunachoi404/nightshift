import type { Keyframe } from "./index.js";
import { WHAT_IF_PRESETS } from "./what-if-presets.js";

export const WHAT_IF_FPS = 24;
export const WHAT_IF_INTERVAL = 120;
export const WHAT_IF_FRAMES = WHAT_IF_INTERVAL * 3 + 1;
export const WHAT_IF_DURATION = 15;
export const whatIfBeatNames = ["Ordinary", "The change", "It grows", "Afterwards"] as const;
export const whatIfExamples = [
  "What if gravity stopped for ten seconds?",
  "What if the sea froze overnight?",
  "What if you fell into Jupiter?",
  "What if your coffee grew a forest?",
];

export const whatIfLooks = [
  { id: "cinematic", label: "Cinematic", phrase: "Cinematic photography, natural materials and light, realistic textures, no text.", palette: 1 },
  { id: "miniature", label: "Miniature world", phrase: "Photographic handmade miniature diorama, finely crafted scale-model materials, tilt-shift macro photography, soft sunlight, no text.", palette: 0 },
];

export function whatIfLook(brief: Record<string, unknown>): string {
  return (whatIfLooks.find((look) => look.id === brief.look) ?? whatIfLooks[0]!).phrase;
}

/** One film, with four visual states. The narration is fiction, not a factual explanation. */
export function fallbackWhatIf(brief: Record<string, unknown>): {
  prompt: string; cameraMove: string; durationSec: number; line: string; keyframes: Keyframe[];
} {
  const question = typeof brief.question === "string" && brief.question.trim()
    ? brief.question.trim().replace(/\s+/g, " ") : whatIfExamples[0]!;
  const preset = /jupiter|outer space|planet/i.test(question) ? WHAT_IF_PRESETS.space
    : /forest|tree|plant|nature|grow/i.test(question) ? WHAT_IF_PRESETS.forest
      : /sea|ocean|harbor|water.*freez|ice/i.test(question) ? WHAT_IF_PRESETS.sea
        : /gravity|float|levitat/i.test(question) ? WHAT_IF_PRESETS.gravity : undefined;
  const shortQuestion = question.split(/\s+/).length <= 16 ? question : "Imagine it happening, just for a moment.";
  const lines = preset ? [shortQuestion, ...preset.lines.slice(1)] : [shortQuestion, "Everything looks familiar at first.",
    "Then the ordinary world starts to change in a way nobody expected.",
    "Imagine staying here long enough to see what it becomes. Nothing feels quite the same again."];
  if (lines.join(" ").split(/\s+/).length < 35) lines[3] += " Take another look.";
  const prompts = preset ? [preset.anchor, ...preset.edits] : [
    `An ordinary, quiet place before the imagined change in this premise: ${question} Objects and places only, no close-up faces or text.`,
    `The same place, camera and light. The first small, clearly visible sign of this imagined change: ${question} Keep the unchanged objects in place.`,
    `The same place, camera and light. The imagined change has grown across the scene: ${question} Make the change large and visually clear.`,
    `The same place after this imagined change: ${question} Show a visible consequence in the setting and objects. No new scene or camera angle.`,
  ];
  const keyframes = prompts.map((prompt, index) => ({ id: `beat-${index}`, prompt, line: lines[index]! }));
  return {
    prompt: preset?.motion ?? `One continuous shot showing this imagined premise: ${question} The ordinary place changes gradually, the change grows, then we see its consequence. No cuts, no crossfade, no text.`,
    cameraMove: preset?.moving ? "dolly_in" : "static",
    durationSec: WHAT_IF_DURATION,
    line: lines.join(" "),
    keyframes,
  };
}
