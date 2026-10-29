/**
 * Fills a WorkflowRef's named inputs into an API-format ComfyUI graph. Pure: the SDK runner turns the
 * file bindings into uploaded assets afterwards.
 */
import type { WorkflowRef } from "@nightshift/contract";
import { omitUnusedReferenceImages } from "./referenceImages.js";

export type Graph = Record<string, { class_type?: string; inputs: Record<string, unknown> }>;

/** Named inputs that take a local file, uploaded as an SDK asset and bound to a loader's filename widget. */
export const FILE_INPUTS = new Set(["image", "image2", "image3", "lastImage", "video", "latent", "voiceRef", "audio", "layout"]);

export interface FileBinding {
  name: string;
  node: string;
  field: string;
  path: string;
}

export interface BoundWorkflow {
  graph: Graph;
  files: FileBinding[];
  /** The value each named input ended up with (files as their local path). */
  applied: Record<string, unknown>;
}

export class BindError extends Error {
  override name = "BindError";
}

export function bindWorkflow(source: Graph, ref: WorkflowRef, values: Record<string, unknown>): BoundWorkflow {
  const graph = structuredClone(source);
  const files: FileBinding[] = [];
  const applied: Record<string, unknown> = {};

  const set = (node: string, field: string, value: unknown, what: string) => {
    const target = graph[node];
    if (!target || typeof target !== "object") throw new BindError(`${what}: node ${node} is not in ${ref.workflow}`);
    target.inputs ??= {};
    target.inputs[field] = value;
  };

  const named: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(ref.params ?? {})) {
    const dot = key.indexOf(".");
    // Node ids never contain dots; field names can ("format.codec"), so split at the first one.
    if (dot > 0) set(key.slice(0, dot), key.slice(dot + 1), value, `param ${key}`);
    else if (key in ref.inputs) named[key] = value;
  }
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) named[key] = value;
  }

  for (const [name, value] of Object.entries(named)) {
    const target = ref.inputs[name];
    if (!target) continue; // the workflow does not take this input
    if (FILE_INPUTS.has(name)) {
      if (typeof value !== "string" || !value) throw new BindError(`input ${name} needs a file path`);
      set(target.node, target.field, value, `input ${name}`); // placeholder until the asset is uploaded
      files.push({ name, node: target.node, field: target.field, path: value });
    } else {
      set(target.node, target.field, value, `input ${name}`);
    }
    applied[name] = value;
  }
  omitUnusedReferenceImages(graph, ref, named);
  return { graph, files, applied };
}

export type OutputKind = "image" | "video" | "audio" | "latent" | "text";

/**
 * The proxy reports SaveVideo outputs as "image" (ComfyUI files them under "images"), so the kind comes
 * from the file extension, not the SDK's output type.
 */
export function kindFromFilename(name: string): OutputKind | undefined {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (["png", "jpg", "jpeg", "webp"].includes(ext)) return "image";
  if (["mp4", "webm", "mov", "mkv", "gif"].includes(ext)) return "video";
  if (["wav", "mp3", "flac", "ogg", "m4a", "opus"].includes(ext)) return "audio";
  if (ext === "latent") return "latent";
  if (["txt", "json", "md"].includes(ext)) return "text";
  return undefined;
}

/** The frame counts a video model takes: `step * k + offset`. */
export interface FrameGrid {
  step: number;
  offset: number;
}

/** LTX takes 8k+1 frames; Kandinsky 6 takes 4k+1, which 8k+1 satisfies too. */
export const LTX_FRAMES: FrameGrid = { step: 8, offset: 1 };
/** MiniMax H3 takes 17k+5 frames, the rule its official template computes a length with (124 = 17 * 7 + 5). */
export const H3_FRAMES: FrameGrid = { step: 17, offset: 5 };

/**
 * A video workflow's frame grid, and the most frames the model lab measured its model at: LTX 2.5 97 (about 4 s at
 * 24 fps), H3 124. A recipe step's `maxFrames` param replaces that limit. Other models have none until the lab sets one.
 */
export function frameRule(graph: Graph | undefined): { grid: FrameGrid; maxFrames?: number } {
  const classes = Object.values(graph ?? {}).map((n) => n.class_type ?? "");
  if (classes.some((c) => c.startsWith("MiniMaxH3"))) return { grid: H3_FRAMES, maxFrames: 124 };
  if (classes.some((c) => c.includes("LTXV"))) return { grid: LTX_FRAMES, maxFrames: 97 };
  return { grid: LTX_FRAMES };
}

/** The most frames on the grid not above `frames`, and never fewer than the grid's smallest real clip. */
export function floorFrames(frames: number, grid: FrameGrid = LTX_FRAMES): number {
  return Math.max(grid.step + grid.offset, Math.floor((frames - grid.offset) / grid.step) * grid.step + grid.offset);
}

/** The longest clip `maxFrames` allows on the grid, in seconds, rounded down to the hundredth (97 at 24 fps: 4.04). */
export function longestClipSec(maxFrames: number, fps: number, grid: FrameGrid = LTX_FRAMES): number {
  return Math.floor((floorFrames(maxFrames, grid) / fps) * 100) / 100;
}

/**
 * The fewest frames on the grid that cover `durationSec` at `fps`, so a clip never comes out shorter than its shot,
 * but at most `maxFrames` (snapped down to the grid).
 */
export function frameCount(durationSec: number, fps: number, maxFrames?: number, grid: FrameGrid = LTX_FRAMES): number {
  const needed = durationSec * fps - 1e-6;
  let frames = Math.max(grid.step + grid.offset, Math.ceil((needed - grid.offset) / grid.step) * grid.step + grid.offset);
  if (maxFrames !== undefined) frames = Math.min(frames, floorFrames(maxFrames, grid));
  return frames;
}

/**
 * The value a named input has in a workflow before the engine sets it: the mapped field's own value, or the value of
 * the Primitive node it is wired to (LTX graphs take width and height from PrimitiveInt nodes). Undefined when the
 * workflow does not take the input or the field is wired to anything else.
 */
export function graphDefault(graph: Graph, ref: WorkflowRef, name: string): unknown {
  const target = ref.inputs[name];
  if (!target) return undefined;
  let value = graph[target.node]?.inputs?.[target.field];
  for (let hops = 0; Array.isArray(value) && hops < 4; hops++) {
    const source = graph[String(value[0])];
    if (!source || !/^Primitive/.test(source.class_type ?? "")) return undefined;
    value = source.inputs.value;
  }
  return Array.isArray(value) ? undefined : value;
}

export interface Size {
  width: number;
  height: number;
}

type AspectId = "16:9" | "9:16" | "1:1";

/** The grid a size sits on: the largest power of two up to 64 that divides both sides (LTX sizes sit on 64). */
export function sizeGrid(width: number, height: number): number {
  let grid = 64;
  while (grid > 8 && (width % grid !== 0 || height % grid !== 0)) grid /= 2;
  return grid;
}

/**
 * Width and height for an aspect, from a step's base size: the recipe's, else its workflow's own (the size the model
 * lab measured). The base is used as given for the aspect that has its orientation, since its author picked what the
 * model wants; the other orientation swaps it, so the pixel count and memory stay the same. 1:1 is the square on the
 * base's grid nearest the same pixel count, never more than 10% above it. A square base gets the aspect's shape.
 */
export function sizeForAspect(width: number, height: number, aspect: AspectId): Size {
  const grid = sizeGrid(width, height);
  if (aspect === "1:1") {
    let side = Math.max(grid, Math.round(Math.sqrt(width * height) / grid) * grid);
    if (side * side > width * height * 1.1) side -= grid;
    return { width: side, height: side };
  }
  if (width === height) return sizeForRatio(width, height, aspect === "16:9" ? 16 / 9 : 9 / 16);
  const landscape = width > height;
  return landscape === (aspect === "16:9") ? { width, height } : { width: height, height: width };
}

/** A size of the given shape (width over height) with the base's pixel count, on the base's grid. */
export function sizeForRatio(width: number, height: number, ratio: number): Size {
  const grid = sizeGrid(width, height);
  const area = width * height;
  const snap = (v: number) => Math.max(grid, Math.round(v / grid) * grid);
  return { width: snap(Math.sqrt(area * ratio)), height: snap(Math.sqrt(area / ratio)) };
}
