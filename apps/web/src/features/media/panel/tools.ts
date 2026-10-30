/**
 * The prompt panel's tools as data: what each one runs on this setup, what it is called, how long it takes, and the
 * make requests the panel sends for it. Pure, so the panel and its tests read the same rules.
 */
import { quickEffects, quickMoves, type Asset, type Aspect, type MakeRequest, type Project, type StepId, type TierSummary } from "@nightshift/contract";
import { roughDuration } from "@/lib/format";

export type Tool = MakeRequest["tool"];

export interface ToolInfo {
  tool: Tool;
  label: string;
  /** Every step the tool runs. A setup without one of them cannot run it. */
  steps: StepId[];
  /** The step whose model the note beside the tool names. */
  modelStep: StepId;
  /** Whether the tool starts from an image: it must, it may (Video draws one first), or never. */
  source: "required" | "optional" | "none";
  cannot: string;
}

export const TOOLS: ToolInfo[] = [
  { tool: "image", label: "Image", steps: ["still"], modelStep: "still", source: "none", cannot: "This setup cannot draw images." },
  { tool: "video", label: "Video", steps: ["video_draft"], modelStep: "video_draft", source: "optional", cannot: "This setup cannot make videos." },
  { tool: "edit", label: "Edit", steps: ["effect_end_frame"], modelStep: "effect_end_frame", source: "required", cannot: "This setup cannot edit images." },
  { tool: "effect", label: "Effect", steps: ["effect_end_frame", "video_effect"], modelStep: "video_effect", source: "required", cannot: "This setup cannot make effects." },
  { tool: "camera_move", label: "Camera move", steps: ["camera_layout", "video_camera_move"], modelStep: "video_camera_move", source: "required", cannot: "This setup cannot make camera moves." },
];

export function toolInfo(tool: Tool): ToolInfo {
  return TOOLS.find((t) => t.tool === tool)!;
}

/** Whether the tool needs an image to start from. Video can draw its own. */
export function needsSource(tool: Tool): boolean {
  return toolInfo(tool).source === "required";
}

/**
 * Why this setup cannot run a tool, or undefined when it can. A setup not known yet runs every tool but Edit, which is
 * only offered where the recipe has its image edit step.
 */
export function toolBlocked(tier: TierSummary | null | undefined, tool: Tool): string | undefined {
  const t = toolInfo(tool);
  if (tool === "edit") return tier?.steps?.includes("effect_end_frame") ? undefined : t.cannot;
  return tier?.steps && t.steps.some((s) => !tier.steps!.includes(s)) ? t.cannot : undefined;
}

/** The tools the panel shows on this setup: all of them, but Edit only where the setup can edit images. */
export function shownTools(tier: TierSummary | null | undefined): ToolInfo[] {
  return TOOLS.filter((t) => t.tool !== "edit" || !toolBlocked(tier, "edit"));
}

/** The steps a make runs: Video without an image draws its still first. */
function stepsOf(tool: Tool, fromImage: boolean): StepId[] {
  return tool === "video" && !fromImage ? ["still", "video_draft"] : toolInfo(tool).steps;
}

/** Seconds one make takes on this setup, from the recipe's estimates. Null when it does not say. */
export function toolSeconds(tier: TierSummary | null | undefined, tool: Tool, fromImage: boolean): number | null {
  const known = stepsOf(tool, fromImage)
    .map((s) => tier?.estimates?.[s]?.seconds)
    .filter((s): s is number => typeof s === "number");
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

/** The model a tool runs here, in plain words ("Krea 2 Turbo"). Video without an image names both of its models. */
export function toolModel(tier: TierSummary | null | undefined, tool: Tool, fromImage: boolean): string | undefined {
  const models = tier?.models;
  if (!models) return undefined;
  const main = models[toolInfo(tool).modelStep];
  if (tool === "video" && !fromImage && models.still && main && models.still !== main) return `${models.still}, then ${main}`;
  return main;
}

/** What the Generate bar says it does: "Generate image", "Generate 3 images", "Make the edit". */
export function actionLabel(tool: Tool, count: number): string {
  const many = count > 1;
  switch (tool) {
    case "image":
      return many ? `Generate ${count} images` : "Generate image";
    case "video":
      return many ? `Make ${count} videos` : "Make video";
    case "edit":
      return many ? `Make ${count} edits` : "Make the edit";
    case "effect":
      return many ? `Make ${count} effects` : "Apply effect";
    case "camera_move":
      return many ? `Make ${count} camera moves` : "Make camera move";
  }
}

/** What one card of the tool is called in a toast: "image", "edit", "camera move". */
export function toolNoun(tool: Tool, count = 1): string {
  const one = tool === "camera_move" ? "camera move" : tool;
  return count > 1 ? `${count} ${one}s` : one;
}

/** "About 30 s", "About 2 min", "About a minute": the time of one make, short enough for the Generate bar. */
export function roughShort(seconds: number): string {
  const rough = roughDuration(seconds).replace(/ seconds$/, " s").replace(/ minutes$/, " min");
  return rough[0]!.toUpperCase() + rough.slice(1);
}

/** The lengths a video may have here, in seconds: 2, 3 and 4, up to the longest clip the setup's model makes. */
export function videoLengths(tier: TierSummary | null | undefined): number[] {
  const longest = tier?.longestShotSec;
  if (!longest) return [2, 3, 4];
  const fit = [2, 3, 4].filter((s) => s <= longest + 0.05);
  return fit.length ? fit : [Math.max(1, Math.floor(longest))];
}

/** Seeds for `count` makes: the fixed seed counting up, distinct random ones, or none for a single random make. */
export function seedsFor(count: number, seed: number | null, random: () => number = randomSeed): Array<number | undefined> {
  if (seed !== null) return Array.from({ length: count }, (_, i) => seed + i);
  if (count <= 1) return [undefined];
  const out = new Set<number>();
  while (out.size < count) out.add(random());
  return [...out];
}

export function randomSeed(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0]! & 0x7fffffff;
}

/** What the panel holds. It stays as it was after a make, so the next card is one tweak away. */
export interface PanelState {
  tool: Tool;
  /** The image the tool starts from: a shot's still, an upload, a reference. */
  source?: string;
  /** The card that handed the source over, so the board can mark it. */
  sourceCard?: string;
  /** The user asked to choose a different image: the next card clicked hands over its image. */
  choosing: boolean;
  /** Image and Video: what to make. */
  prompt: string;
  /** Edit: what to change. */
  instruction: string;
  /** Effect: what changes (optional). */
  subject: string;
  /** Camera move: what is in the scene (optional). */
  scene: string;
  /** Video: a prompt-guided camera move (`cameraMoves`). */
  move: string;
  effect: string;
  /** Camera move: a camera path (`quickMoves`). */
  path: string;
  /** Image: the references to draw with. Absent: the project's first three. */
  refs?: string[];
  /** The new card's shape. Absent: the project's. */
  aspect?: Aspect;
  /** Video: its length in seconds. Absent: the longest the setup makes. */
  durationSec?: number;
  /** How many cards one Generate makes, each with its own seed. */
  variations: number;
  /** A fixed seed (variations count up from it), or null for random. */
  seed: number | null;
}

export const initialPanel: PanelState = {
  tool: "image",
  choosing: false,
  prompt: "",
  instruction: "",
  subject: "",
  scene: "",
  move: "static",
  effect: quickEffects[0]!.id,
  path: quickMoves[0]!.id,
  variations: 1,
  seed: null,
};

/** The image a source id points at, if it is still in the project. */
export function sourceImage(project: Pick<Project, "assets">, id: string | undefined) {
  return id ? project.assets.find((a) => a.id === id && a.kind === "image") : undefined;
}

/** The references an image is drawn with: the chosen ones still in the project, else the first three. */
export function chosenReferences(project: Pick<Project, "references">, refs: string[] | undefined): string[] {
  const all = project.references ?? [];
  return (refs ?? all.slice(0, 3).map((r) => r.id)).filter((id) => all.some((r) => r.id === id));
}

export interface MakeContext {
  project: Pick<Project, "aspect" | "assets" | "references">;
  boardId: string;
  tier: TierSummary | null | undefined;
}

/** The video's length here: the one chosen when the setup makes it, else the longest it makes. */
export function videoLength(state: Pick<PanelState, "durationSec">, tier: TierSummary | null | undefined): number {
  const lengths = videoLengths(tier);
  return state.durationSec !== undefined && lengths.includes(state.durationSec) ? state.durationSec : lengths.at(-1)!;
}

/** The shape of an image, as the nearest of the three formats. */
export function shapeOfImage(asset: Pick<Asset, "width" | "height"> | undefined): Aspect | undefined {
  if (!asset?.width || !asset.height) return undefined;
  const r = asset.width / asset.height;
  return Math.abs(Math.log(r)) < Math.log(1.25) ? "1:1" : r > 1 ? "16:9" : "9:16";
}

/**
 * The new card's shape: the chosen format when the tool draws from words, else the shape of the image it starts from
 * (an edit keeps its image's shape, and a clip from a still keeps the still's), else the project's.
 */
export function cardShape(state: Pick<PanelState, "tool" | "aspect" | "source">, project: Pick<Project, "aspect" | "assets">): Aspect {
  const source = sourceImage(project, state.source);
  if (source && state.tool !== "image") return shapeOfImage(source) ?? project.aspect;
  return state.aspect ?? project.aspect;
}

/** Why Generate cannot run yet, in one plain line, or undefined when it can. */
export function whyNot(state: PanelState, ctx: Omit<MakeContext, "boardId">): string | undefined {
  const blocked = toolBlocked(ctx.tier, state.tool);
  if (blocked) return blocked;
  const source = sourceImage(ctx.project, state.source);
  switch (state.tool) {
    case "image":
      return state.prompt.trim() ? undefined : "Write a prompt first.";
    case "video":
      if (source) return undefined;
      if (!state.prompt.trim()) return "Write a prompt, or choose an image to start from.";
      return toolBlocked(ctx.tier, "image") ? "Choose an image to start from. This setup cannot draw one." : undefined;
    case "edit":
      if (!source) return "Choose the image to change.";
      return state.instruction.trim() ? undefined : "Say what to change.";
    case "effect":
    case "camera_move":
      return source ? undefined : "Choose an image first.";
  }
}

/**
 * The requests one Generate sends: one per variation, each with its own seed. The shape goes only when it is not the
 * project's, and a single random make sends no seed (the engine picks one).
 */
export function makeRequests(state: PanelState, ctx: MakeContext, random: () => number = randomSeed): MakeRequest[] {
  const { project, boardId, tier } = ctx;
  const source = sourceImage(project, state.source);
  const words = { image: state.prompt, video: state.prompt, edit: state.instruction, effect: state.subject, camera_move: state.scene }[state.tool].trim();
  const base: MakeRequest = {
    tool: state.tool,
    boardId,
    ...(words ? { prompt: words } : {}),
    ...(cardShape(state, project) !== project.aspect ? { aspect: cardShape(state, project) } : {}),
  };
  const refLimit = Math.min(3, tier?.referenceImageLimit ?? 3);
  let body: MakeRequest;
  switch (state.tool) {
    case "image":
      body = { ...base, ...((project.references ?? []).length && refLimit > 0 ? { referenceIds: chosenReferences(project, state.refs).slice(0, refLimit) } : {}) };
      break;
    case "video":
      body = { ...base, ...(source ? { imageAssetId: source.id } : {}), move: state.move, durationSec: videoLength(state, tier) };
      break;
    case "edit":
      body = { ...base, imageAssetId: source!.id };
      break;
    case "effect":
      body = { ...base, imageAssetId: source!.id, effect: state.effect };
      break;
    case "camera_move":
      body = { ...base, imageAssetId: source!.id, move: state.path };
      break;
  }
  const count = Math.max(1, Math.min(4, Math.round(state.variations)));
  return seedsFor(count, state.seed, random).map((seed) => (seed === undefined ? body : { ...body, seed }));
}
