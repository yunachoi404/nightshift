import { run } from "../media/process.js";
import type { ResolvedTools } from "../media/tools.js";

export interface Focus {
  x: number;
  y: number;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface FocusResult extends Focus {
  /** Where the subject is in the source, 0..1 each way: the centre of the most salient tenth of the picture. */
  subject: Focus;
  /**
   * How far the subject extends in the source over the whole clip, 0..1 each way, so captions and cards can keep
   * off the whole figure (head to feet), not just its centre.
   */
  box: Box;
  /** The same per sampled frame, evenly spaced over the clip, so a moving or growing subject is boxed when it shows. */
  boxes: Box[];
  /** Mean brightness of 16 horizontal strips of the source, top to bottom, 0..1: a text band can tell a bright sky from a dark road. */
  rows: number[];
}

export interface FocusOptions {
  /** Seconds into the source the clip uses. */
  start: number;
  end: number;
  srcWidth: number;
  srcHeight: number;
  /** Width / height of the frame the clip is cropped into. */
  frameAspect: number;
  /** The path is a still image, not a video. */
  still?: boolean;
  signal?: AbortSignal;
}

const SAMPLE_WIDTH = 160;

const CENTRE: FocusResult = { x: 0.5, y: 0.5, subject: { x: 0.5, y: 0.5 }, box: { left: 0.42, top: 0.35, right: 0.58, bottom: 0.65 }, boxes: [], rows: [] };

/**
 * Where to centre a crop so the subject stays in frame (9:16 or 1:1 from a 16:9 shot), and where the subject is, so
 * titles and name tags can keep away from it. Samples a few frames and scores each pixel by how rare its colour is
 * in the frame (histogram contrast: a red coat on a grey street scores, a big pale sky does not), its edges and its
 * motion, with a pull towards the centre. The crop centre is 0.5 on an axis the frame does not crop. Works on a
 * still too (one frame, no motion).
 */
export async function findFocus(tools: Pick<ResolvedTools, "ffmpeg">, path: string, options: FocusOptions): Promise<FocusResult> {
  const srcAspect = options.srcWidth / options.srcHeight;
  const cropsX = options.frameAspect < srcAspect * 0.92;
  const cropsY = options.frameAspect > srcAspect * 1.08;
  const w = SAMPLE_WIDTH;
  const h = Math.max(2, Math.round((w / srcAspect) / 2) * 2);
  const length = options.still ? 1 : Math.max(0.1, options.end - options.start);
  const samples = options.still ? 1 : 6;
  const { stdout } = await run(
    tools.ffmpeg,
    [
      "-v", "error", "-nostdin",
      ...(options.still ? ["-loop", "1"] : ["-ss", options.start.toFixed(3)]),
      "-t", length.toFixed(3),
      "-i", path,
      "-vf", `fps=${(samples / length).toFixed(4)},scale=${w}:${h}:flags=area,format=rgb24`,
      "-frames:v", String(samples),
      "-f", "rawvideo", "pipe:1",
    ],
    { signal: options.signal },
  );
  const frameBytes = w * h * 3;
  const frames: Uint8Array[] = [];
  for (let o = 0; o + frameBytes <= stdout.length; o += frameBytes) frames.push(stdout.subarray(o, o + frameBytes));
  if (frames.length === 0) return CENTRE;
  const map = saliencyMap(frames, w, h);
  const x = cropsX ? bestWindow(profile(map, w, h, "x"), (options.frameAspect / srcAspect) * w) / w : 0.5;
  const y = cropsY ? bestWindow(profile(map, w, h, "y"), (srcAspect / options.frameAspect) * h) / h : 0.5;
  // Edges are everywhere in a street or a room; the subject is what moves, and what has a colour of its own.
  const subject = subjectPoint(saliencyMap(frames, w, h, frames.length > 1 ? SUBJECT_WEIGHTS : STILL_SUBJECT_WEIGHTS), w, h);
  // Brightness is measured on the part of the picture the frame shows, so a 9:16 crop between dark towers reads the sky.
  const visibleW = cropsX ? (options.frameAspect / srcAspect) * w : w;
  const visibleH = cropsY ? (srcAspect / options.frameAspect) * h : h;
  const window = { left: Math.round(x * w - visibleW / 2), right: Math.round(x * w + visibleW / 2), top: Math.round(y * h - visibleH / 2), bottom: Math.round(y * h + visibleH / 2) };
  const extent = subjectExtent(frames, w, h, subject);
  return { x, y, subject, box: extent.box, boxes: extent.boxes, rows: rowBrightness(frames, w, h, 16, window) };
}

/**
 * The subject's position: the strongest blob of the saliency map. Smooths the map, starts at its peak (with a pull
 * towards the middle, and ignoring the outermost pixels where scaling leaves artefacts) and shifts to the weighted
 * centre of what lies within a short radius a few times (mean shift), so one person or product wins over scattered
 * specks of rain and flicker. Exported for tests.
 */
export function subjectPoint(map: Float32Array, w: number, h: number): Focus {
  const smooth = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          sum += map[yy * w + xx] as number;
          n++;
        }
      }
      smooth[y * w + x] = sum / n;
    }
  }
  let peak = 0;
  let at = -1;
  const margin = 2;
  for (let y = margin; y < h - margin; y++) {
    for (let x = margin; x < w - margin; x++) {
      const dx = (x + 0.5) / w - 0.5;
      const dy = (y + 0.5) / h - 0.5;
      const prior = Math.exp(-(dx * dx + dy * dy) / (2 * 0.3 * 0.3));
      const v = (smooth[y * w + x] as number) * prior;
      if (v > peak) {
        peak = v;
        at = y * w + x;
      }
    }
  }
  if (at < 0) return { x: 0.5, y: 0.5 };
  let cx = (at % w) + 0.5;
  let cy = Math.floor(at / w) + 0.5;
  const radius = Math.max(4, Math.round(w * 0.1));
  for (let pass = 0; pass < 4; pass++) {
    let sx = 0;
    let sy = 0;
    let total = 0;
    for (let y = Math.max(0, Math.floor(cy - radius)); y < Math.min(h, Math.ceil(cy + radius)); y++) {
      for (let x = Math.max(0, Math.floor(cx - radius)); x < Math.min(w, Math.ceil(cx + radius)); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy > radius * radius) continue;
        const v = smooth[y * w + x] as number;
        const weight = v * v;
        sx += (x + 0.5) * weight;
        sy += (y + 0.5) * weight;
        total += weight;
      }
    }
    if (total <= 0) break;
    cx = sx / total;
    cy = sy / total;
  }
  return { x: cx / w, y: cy / h };
}

/** A box of this size around the subject point when nothing better can be measured, as fractions of the source. */
export const POINT_BOX = { halfWidth: 0.08, halfHeight: 0.15 };

export interface SubjectExtent {
  /** Over the whole clip. */
  box: Box;
  /** Per sampled frame; a frame whose patch could not be traced gets the clip's box. */
  boxes: Box[];
}

/**
 * How far the subject extends in the source, 0..1 each way. Saliency maps of a street are too even to trace a
 * figure, so the extent comes from colour instead: the patch of one colour around the subject point in each sampled
 * frame (a red coat, a cup), widened for what a figure carries above and below its coloured part (a head above, legs
 * below) and padded by a pixel. The clip's box joins the frames' boxes, so it covers the whole move. A frame whose patch runs
 * over the background is skipped; with no usable frame the box is a modest one around the point. Exported for tests.
 */
export function subjectExtent(frames: readonly Uint8Array[], w: number, h: number, point: Focus): SubjectExtent {
  const perFrame = frames.map((rgb) => {
    const patch = colourPatch(rgb, w, h, point);
    if (!patch) return undefined;
    const height = patch.bottom - patch.top;
    return {
      left: Math.max(0, (patch.left - 1) / w),
      top: Math.max(0, (patch.top - 0.3 * height - 1) / h),
      right: Math.min(1, (patch.right + 1) / w),
      bottom: Math.min(1, (patch.bottom + 0.45 * height + 1) / h),
    };
  });
  const traced = perFrame.filter((b): b is Box => b !== undefined);
  const box: Box = traced.length
    ? traced.reduce((u, b) => ({ left: Math.min(u.left, b.left), top: Math.min(u.top, b.top), right: Math.max(u.right, b.right), bottom: Math.max(u.bottom, b.bottom) }))
    : {
        left: Math.max(0, point.x - POINT_BOX.halfWidth),
        top: Math.max(0, point.y - POINT_BOX.halfHeight),
        right: Math.min(1, point.x + POINT_BOX.halfWidth),
        bottom: Math.min(1, point.y + POINT_BOX.halfHeight),
      };
  return { box, boxes: perFrame.map((b) => b ?? box) };
}

/** Share of the frame a colour patch may cover before it counts as background rather than subject. */
const PATCH_LIMIT = 0.35;

/**
 * The bounding box, in pixels, of the pixels joined to the subject point that share its colour: hue and chroma for
 * a coloured subject, brightness for a grey one. The seed is the most colourful pixel next to the point, so a point
 * on the edge of a coat still starts inside it. Undefined when the patch runs over more than a third of the frame.
 */
function colourPatch(rgb: Uint8Array, w: number, h: number, point: Focus): { left: number; top: number; right: number; bottom: number } | undefined {
  const px = Math.min(w - 1, Math.max(0, Math.round(point.x * w - 0.5)));
  const py = Math.min(h - 1, Math.max(0, Math.round(point.y * h - 0.5)));
  const at = (x: number, y: number) => {
    const i = (y * w + x) * 3;
    return [rgb[i] as number, rgb[i + 1] as number, rgb[i + 2] as number] as const;
  };
  const chromaOf = (c: readonly [number, number, number]) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
  const lumaOf = (c: readonly [number, number, number]) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  const hueOf = (c: readonly [number, number, number]) => {
    const max = Math.max(c[0], c[1], c[2]);
    const d = chromaOf(c);
    if (d === 0) return 0;
    let hue = max === c[0] ? (c[1] - c[2]) / d : max === c[1] ? 2 + (c[2] - c[0]) / d : 4 + (c[0] - c[1]) / d;
    hue *= 60;
    return hue < 0 ? hue + 360 : hue;
  };
  // Seed: the most colourful pixel within two of the point.
  let seedX = px;
  let seedY = py;
  let seedChroma = -1;
  for (let y = Math.max(0, py - 2); y <= Math.min(h - 1, py + 2); y++) {
    for (let x = Math.max(0, px - 2); x <= Math.min(w - 1, px + 2); x++) {
      const c = chromaOf(at(x, y));
      if (c > seedChroma) {
        seedChroma = c;
        seedX = x;
        seedY = y;
      }
    }
  }
  const seed = at(seedX, seedY);
  const colourful = seedChroma >= 40;
  const seedHue = hueOf(seed);
  const seedLuma = lumaOf(seed);
  const alike = (c: readonly [number, number, number]) => {
    const chroma = chromaOf(c);
    if (colourful) {
      if (chroma < Math.max(25, seedChroma * 0.4)) return false;
      const diff = Math.abs(hueOf(c) - seedHue);
      return Math.min(diff, 360 - diff) <= 25;
    }
    return chroma < 40 && Math.abs(lumaOf(c) - seedLuma) <= 28;
  };
  const seen = new Uint8Array(w * h);
  const stack = [seedY * w + seedX];
  seen[seedY * w + seedX] = 1;
  let count = 0;
  const limit = PATCH_LIMIT * w * h;
  let left = seedX;
  let right = seedX;
  let top = seedY;
  let bottom = seedY;
  while (stack.length) {
    const i = stack.pop() as number;
    const x = i % w;
    const y = (i - x) / w;
    count++;
    if (count > limit) return undefined;
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const j = yy * w + xx;
      if (seen[j]) continue;
      seen[j] = 1;
      if (alike(at(xx, yy))) stack.push(j);
    }
  }
  return { left, top, right: right + 1, bottom: bottom + 1 };
}

/** Mean brightness of `strips` horizontal bands of the frames (inside `window` when given), top to bottom, 0..1. Exported for tests. */
export function rowBrightness(frames: readonly Uint8Array[], w: number, h: number, strips = 16, window?: Box): number[] {
  const x0 = Math.max(0, window?.left ?? 0);
  const x1 = Math.min(w, window?.right ?? w);
  const y0 = Math.max(0, window?.top ?? 0);
  const y1 = Math.min(h, window?.bottom ?? h);
  const sums = new Float64Array(strips);
  const counts = new Float64Array(strips);
  for (const rgb of frames) {
    for (let y = y0; y < y1; y++) {
      const s = Math.min(strips - 1, Math.floor((y / h) * strips));
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 3;
        sums[s] = (sums[s] as number) + (0.299 * (rgb[i] as number) + 0.587 * (rgb[i + 1] as number) + 0.114 * (rgb[i + 2] as number)) / 255;
        counts[s] = (counts[s] as number) + 1;
      }
    }
  }
  return Array.from(sums, (v, i) => ((counts[i] as number) > 0 ? v / (counts[i] as number) : 0));
}

export interface SaliencyWeights {
  colour: number;
  edges: number;
  motion: number;
}

const CROP_WEIGHTS: SaliencyWeights = { colour: 0.55, edges: 0.25, motion: 0.2 };
export const SUBJECT_WEIGHTS: SaliencyWeights = { colour: 0.15, edges: 0, motion: 0.85 };
export const STILL_SUBJECT_WEIGHTS: SaliencyWeights = { colour: 0.7, edges: 0.3, motion: 0 };

/** Per-pixel saliency averaged over frames. Exported for tests. */
export function saliencyMap(frames: readonly Uint8Array[], w: number, h: number, weights: SaliencyWeights = CROP_WEIGHTS): Float32Array {
  const total = new Float32Array(w * h);
  let previous: Float32Array | null = null;
  for (const rgb of frames) {
    const luma = new Float32Array(w * h);
    const blurred = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) luma[i] = 0.299 * (rgb[i * 3] as number) + 0.587 * (rgb[i * 3 + 1] as number) + 0.114 * (rgb[i * 3 + 2] as number);
    // 5x5 box blur, then how rare the colour is in the frame: what stands out because little else looks like it.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dy = -2; dy <= 2; dy++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          for (let dx = -2; dx <= 2; dx++) {
            const xx = Math.min(w - 1, Math.max(0, x + dx));
            const k = (yy * w + xx) * 3;
            r += rgb[k] as number;
            g += rgb[k + 1] as number;
            b += rgb[k + 2] as number;
            n++;
          }
        }
        const k = (y * w + x) * 3;
        blurred[k] = r / n;
        blurred[k + 1] = g / n;
        blurred[k + 2] = b / n;
      }
    }
    const colour = colourRarity(blurred, w * h);
    const edges = new Float32Array(w * h);
    const motion = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (x > 0 && y > 0 && x < w - 1 && y < h - 1) {
          const gx = (luma[i + 1] as number) - (luma[i - 1] as number);
          const gy = (luma[i + w] as number) - (luma[i - w] as number);
          edges[i] = Math.sqrt(gx * gx + gy * gy);
        }
        if (previous) motion[i] = Math.abs((luma[i] as number) - (previous[i] as number));
      }
    }
    normalize(colour);
    normalize(edges);
    normalize(motion);
    for (let i = 0; i < w * h; i++) total[i] = (total[i] as number) + weights.colour * (colour[i] as number) + weights.edges * (edges[i] as number) + weights.motion * (motion[i] as number);
    previous = luma;
  }
  return total;
}

/**
 * How rare each pixel's colour is: minus the log of the share of the frame in its colour bin (6 levels per channel),
 * 0..1 with everything under one percent of the frame scoring 1. A colour that covers a third of the frame scores
 * near 0.25; a coat that covers a fortieth scores near 0.8.
 */
function colourRarity(rgb: Float32Array, n: number): Float32Array {
  const LEVELS = 6;
  const bins = new Uint32Array(LEVELS * LEVELS * LEVELS);
  const index = new Uint16Array(n);
  const q = (v: number) => Math.min(LEVELS - 1, Math.floor((v / 256) * LEVELS));
  for (let i = 0; i < n; i++) {
    const k = (q(rgb[i * 3] as number) * LEVELS + q(rgb[i * 3 + 1] as number)) * LEVELS + q(rgb[i * 3 + 2] as number);
    index[i] = k;
    bins[k] = (bins[k] as number) + 1;
  }
  const out = new Float32Array(n);
  const scale = -Math.log(0.01);
  for (let i = 0; i < n; i++) out[i] = Math.min(1, -Math.log((bins[index[i] as number] as number) / n) / scale);
  return out;
}

function normalize(values: Float32Array): void {
  let max = 0;
  for (const v of values) max = Math.max(max, v);
  if (max <= 0) return;
  for (let i = 0; i < values.length; i++) values[i] = (values[i] as number) / max;
}

/** Saliency summed across the other axis, weighted towards the middle of that axis. */
function profile(map: Float32Array, w: number, h: number, axis: "x" | "y"): Float32Array {
  const out = new Float32Array(axis === "x" ? w : h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const across = axis === "x" ? y / (h - 1) - 0.5 : x / (w - 1) - 0.5;
      const weight = Math.exp(-(across * across) / (2 * 0.3 * 0.3));
      const v = (map[y * w + x] as number) * weight;
      if (axis === "x") out[x] = (out[x] as number) + v;
      else out[y] = (out[y] as number) + v;
    }
  }
  return out;
}

/** Centre (in samples) of the window of `size` samples with the most saliency, mildly preferring the middle. */
export function bestWindow(values: Float32Array, size: number): number {
  const n = values.length;
  const win = Math.max(1, Math.min(n, Math.round(size)));
  if (win >= n) return n / 2;
  let sum = 0;
  for (let i = 0; i < win; i++) sum += values[i] as number;
  let total = 0;
  for (const v of values) total += v;
  let bestScore = -Infinity;
  let bestStart = 0;
  for (let start = 0; start + win <= n; start++) {
    if (start > 0) sum += (values[start + win - 1] as number) - (values[start - 1] as number);
    const centre = (start + win / 2) / n - 0.5;
    const score = sum / Math.max(total, 1e-9) - 1.0 * centre * centre;
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  return bestStart + win / 2;
}
