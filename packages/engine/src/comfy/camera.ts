/** Camera paths in a photo's reconstructed space. X right, Y up, Z away from the source camera. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { findFfmpeg } from "../media/ffmpeg.js";
import { abortError } from "../util.js";
import type { StepContext, StepOutput, StepRequest } from "../runner/types.js";

export interface CameraPose { x: number; y: number; z: number; targetX: number; targetY: number; targetZ: number; zoom: number; shiftX: number; shiftY: number }
export interface CameraSubject { x: number; y: number; z: number }

export function cameraPose(move: string, t: number, subject: CameraSubject = { x: 0, y: 0, z: 3 }): CameraPose {
  const u = Math.max(0, Math.min(1, t));
  const e = u * u * (3 - 2 * u);
  const p: CameraPose = { x: 0, y: 0, z: 0, targetX: 0, targetY: 0, targetZ: 3, zoom: 1, shiftX: 0, shiftY: 0 };
  switch (move) {
    case "dolly_in": p.z = 1.35 * e; break;
    case "push_in": {
      const fast = Math.min(1, u / 0.75);
      p.z = 1.65 * fast * fast * (3 - 2 * fast); break;
    }
    case "pull_back": p.z = -2.4 * e; break;
    case "crane_up": p.y = 0.75 * e; break;
    case "crash_zoom": {
      const snap = Math.min(1, Math.max(0, (u - 0.15) / 0.12));
      const zoom = snap * snap * (3 - 2 * snap);
      p.zoom = 1 + 1.8 * zoom;
      // An off-axis lens shift aims at the depth subject without rotating or changing frame zero.
      p.shiftX = -subject.x / subject.z * (p.zoom - 1 + zoom);
      p.shiftY = -subject.y / subject.z * (p.zoom - 1 + zoom);
      break;
    }
    case "dolly_zoom": {
      // The camera backs away along its line to the subject, facing the same way, while the lens zooms in to match.
      // The zoom and a lens shift hold the whole subject plane in place, so the world behind grows out from the
      // subject, even an off-centre one. `dollyZoomPoints` shapes the scene for it.
      const back = DOLLY_ZOOM_BACK * e, ax = subject.x / subject.z, ay = subject.y / subject.z;
      p.x = -back * ax; p.y = -back * ay; p.z = -back;
      p.targetX = p.x; p.targetY = p.y; p.targetZ = p.z + 3;
      p.zoom = (subject.z + back) / subject.z;
      p.shiftX = -ax * back / subject.z; p.shiftY = -ay * back / subject.z;
      break;
    }
    default: throw new Error(`Unknown camera move: ${move}`);
  }
  // Keep the source camera exact, including IEEE negative zero.
  for (const k of ["x", "y", "z", "targetX", "targetY", "shiftX", "shiftY"] as const) if (p[k] === 0) p[k] = 0;
  return p;
}

/** MoGe exports normalized inverse depth. Set central depth to 3, then find a subject within that reconstruction. */
export function cameraPoints(depth: Uint8Array, photo: Uint8Array, width: number, height: number) {
  const count = width * height;
  if (depth.length !== count * 3 || photo.length !== count * 3) throw new Error("Camera image dimensions do not match");
  const focus: number[] = [];
  for (let y = Math.floor(height * 0.4); y < Math.ceil(height * 0.6); y++) {
    for (let x = Math.floor(width * 0.4); x < Math.ceil(width * 0.6); x++) focus.push(1 / (0.12 + depth[(y * width + x) * 3]! / 255));
  }
  focus.sort((a, b) => a - b);
  const scale = 3 / focus[Math.floor(focus.length / 2)]!;
  const focal = Math.max(width, height) * 0.9;
  // Weight the near-depth region toward the centre. Ignore the far horizon in landscapes,
  // where a foreground floor or lake would otherwise pull the target to the bottom edge.
  const centralDepths: number[] = [];
  for (let y = Math.floor(height * 0.15); y < Math.ceil(height * 0.75); y++) {
    for (let x = Math.floor(width * 0.15); x < Math.ceil(width * 0.85); x++) centralDepths.push(depth[(y * width + x) * 3]!);
  }
  centralDepths.sort((a, b) => a - b);
  const nearDepth = Math.max((scale / 3 - 0.12) * 255, centralDepths[Math.floor(centralDepths.length * 0.9)]!);
  let weight = 0, sx = 0, sy = 0, sz = 0;
  let prominenceWeight = 0, px = 0, py = 0, pz = 0, prominentPixels = 0;
  const radius = Math.max(1, Math.round(width * 0.12));
  if (nearDepth >= 32) for (let y = 0; y < Math.ceil(height * 0.8); y++) for (let x = 0; x < width; x++) {
    const d = depth[(y * width + x) * 3]!;
    const nx = (x - (width - 1) / 2) / width, ny = (y - (height - 1) / 2) / height;
    const w = Math.exp(-0.5 * ((nx / 0.22) ** 2 + (ny / 0.25) ** 2));
    const z = scale / (0.12 + d / 255);
    if (d >= nearDepth * 0.85) {
      weight += w; sx += w * x; sy += w * y; sz += w * z;
    }
    // Depth above its horizontal neighbourhood finds a discrete object on a sloping floor.
    // Absolute near-depth alone would aim a product zoom at the table in front of it.
    if (d >= 32 && x >= radius && x + radius < width) {
      const background = (depth[(y * width + x - radius) * 3]! + depth[(y * width + x + radius) * 3]!) / 2;
      const prominence = Math.max(0, d - background - 8);
      if (prominence > 0) {
        const pw = w * prominence;
        prominentPixels++; prominenceWeight += pw; px += pw * x; py += pw * y; pz += pw * z;
      }
    }
  }
  if (prominentPixels >= count * 0.002) { weight = prominenceWeight; sx = px; sy = py; sz = pz; }
  const subjectZ = weight ? sz / weight : 3;
  const subject: CameraSubject = weight ? {
    x: (sx / weight - (width - 1) / 2) / focal * subjectZ,
    y: ((height - 1) / 2 - sy / weight) / focal * subjectZ,
    z: subjectZ,
  } : { x: 0, y: 0, z: 3 };
  const xyz = new Float32Array(count * 3);
  const shade = new Uint8Array(count);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    const z = scale / (0.12 + depth[i * 3]! / 255);
    xyz[i * 3] = (x - (width - 1) / 2) / focal * z;
    xyz[i * 3 + 1] = ((height - 1) / 2 - y) / focal * z;
    xyz[i * 3 + 2] = z;
    // A clay-like depth shade with a little source luminance to preserve edges on flat surfaces.
    const luma = photo[i * 3]! * 0.2126 + photo[i * 3 + 1]! * 0.7152 + photo[i * 3 + 2]! * 0.0722;
    const slope = x + 1 < width ? depth[(i + 1) * 3]! - depth[i * 3]! : 0;
    shade[i] = Math.max(45, Math.min(220, 105 + depth[i * 3]! * 0.22 + luma * 0.18 - slope * 0.7));
  }
  return { xyz, shade, focal, subject };
}

export type CameraPoints = ReturnType<typeof cameraPoints>;

/** How far a dolly zoom's camera backs away, in scene units (the photo's central depth is 3). */
export const DOLLY_ZOOM_BACK = 4.5;
/** How much the middle of a dolly zoom's background grows by its last frame, in a deep corridor or a small kitchen. */
export const DOLLY_ZOOM_GROWTH = 1.7;

/**
 * A photo's points made ready for the dolly zoom. Its lens holds the subject's depth still while the camera backs away,
 * so whatever lies deeper grows and whatever lies nearer shrinks. One photo cannot show what a nearer object's shrinking
 * would uncover, and a guide that leaves that grey reads as a plain pull-back. So everything nearer than the subject
 * moves with it: the subject, the table it stands on and the frame's edges hold, and only the background grows.
 * A back wall one step behind the subject would barely grow, so depth beyond the subject is stretched, as a power of
 * its ratio to the hold depth, until the background's middle depth grows by `DOLLY_ZOOM_GROWTH`: a small room reads
 * as the vertigo effect as surely as a long corridor. `stretch` sets the power instead.
 * The hold depth sits a little behind the subject's average depth, so its whole body holds rather than its back half
 * growing. A pixel blended between a near edge and the far wall snaps to one of the two first; left between them, it
 * would scatter as dots into the gap the move opens behind the subject.
 * That gap is background the photo never showed. Left flat grey, the video model paints an object into it, so a
 * background plate fills it: behind every held pixel, a point continuing the background around it (`backgroundPlate`),
 * which grows with the background and shows only where the held pixels move off it.
 */
export function dollyZoomPoints(points: CameraPoints, width: number, height: number, stretch?: number): CameraPoints {
  const count = width * height;
  const z = new Float32Array(count);
  for (let i = 0; i < count; i++) z[i] = points.xyz[i * 3 + 2]!;
  const hold = points.subject.z * 1.08;
  // The nearest and farthest pixel within two pixels, as a separable min and max filter.
  const near = new Int32Array(count), far = new Int32Array(count);
  const rowNear = new Int32Array(count), rowFar = new Int32Array(count);
  const r = 2;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let lo = y * width + x, hi = lo;
    for (let k = Math.max(0, x - r); k <= Math.min(width - 1, x + r); k++) { const i = y * width + k; if (z[i]! < z[lo]!) lo = i; if (z[i]! > z[hi]!) hi = i; }
    rowNear[y * width + x] = lo; rowFar[y * width + x] = hi;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let lo = rowNear[y * width + x]!, hi = rowFar[y * width + x]!;
    for (let k = Math.max(0, y - r); k <= Math.min(height - 1, y + r); k++) { const i = k * width + x; if (z[rowNear[i]!]! < z[lo]!) lo = rowNear[i]!; if (z[rowFar[i]!]! > z[hi]!) hi = rowFar[i]!; }
    near[y * width + x] = lo; far[y * width + x] = hi;
  }
  const depth = new Float32Array(count);
  const shade = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const lo = z[near[i]!]!, hi = z[far[i]!]!;
    // A depth edge: a jump in disparity of more than a fifth of the subject's within the window. The pixel joins the
    // side nearer its depth, with that side's shade: an edge is shaded dark by its slope, which would streak as it grows.
    const side = (1 / lo - 1 / hi) * hold > 0.2 ? (z[i]! - lo < hi - z[i]! ? near[i]! : far[i]!) : i;
    depth[i] = z[side]!;
    shade[i] = points.shade[side]!;
  }
  const power = stretch ?? dollyZoomStretch(depth, hold);
  const plate = backgroundPlate(depth, shade, width, height, hold);
  const held = plate.pixels.length;
  const xyz = new Float32Array((count + held) * 3);
  const shaded = new Uint8Array(count + held);
  shaded.set(shade);
  // A point on pixel i's ray at `at`: the same pixel at the opening frame, at the shaped depth.
  const place = (n: number, i: number, at: number) => {
    const shaped = at <= hold ? hold : hold * (at / hold) ** power;
    const k = shaped / z[i]!;
    xyz[n * 3] = points.xyz[i * 3]! * k;
    xyz[n * 3 + 1] = points.xyz[i * 3 + 1]! * k;
    xyz[n * 3 + 2] = shaped;
  };
  for (let i = 0; i < count; i++) place(i, i, depth[i]!);
  plate.pixels.forEach((i, n) => {
    place(count + n, i, plate.depth[n]!);
    shaded[count + n] = plate.shade[n]!;
  });
  const s = hold / points.subject.z;
  return { ...points, xyz, shade: shaded, subject: { x: points.subject.x * s, y: points.subject.y * s, z: hold } };
}

/**
 * The stretch that makes the background's middle depth grow by `DOLLY_ZOOM_GROWTH`. At the last frame a depth `z`
 * grows by (1 + b) / (1 + b * hold / z), with b the camera's travel over the hold depth: the power that puts the median
 * background depth where that equals the growth. Between 1 (no stretch) and 6; 1 without any background.
 */
export function dollyZoomStretch(depth: Float32Array, hold: number): number {
  const behind = Array.from(depth).filter((z) => z > hold).sort((a, b) => a - b);
  if (!behind.length) return 1;
  const ratio = behind[Math.floor(behind.length / 2)]! / hold;
  const b = DOLLY_ZOOM_BACK / hold;
  const room = (1 + b) / DOLLY_ZOOM_GROWTH - 1;
  // A lens that cannot grow anything that much: stretch as far as it goes.
  if (room <= 0 || ratio <= 1.0001) return 6;
  return Math.min(6, Math.max(1, Math.log(b / room) / Math.log(ratio)));
}

/**
 * What lies behind the held pixels (depth at or nearer than `hold`), guessed from the background around them: depth (as
 * disparity) and shade spread inwards from the nearest background by a push-pull pyramid, with bilinear steps so the
 * fill is smooth. Always deeper than the hold plane. Empty when nothing is held or there is no background at all.
 */
export function backgroundPlate(depth: Float32Array, shade: Uint8Array, width: number, height: number, hold: number) {
  const pixels: number[] = [];
  for (let i = 0; i < width * height; i++) if (depth[i]! <= hold) pixels.push(i);
  if (!pixels.length || pixels.length === width * height) return { pixels: [] as number[], depth: new Float32Array(0), shade: new Uint8Array(0) };
  // Level 0: the background's disparity and shade, weight 1; held pixels weigh nothing.
  type Level = { w: number; h: number; q: Float32Array; s: Float32Array; n: Float32Array };
  const base: Level = { w: width, h: height, q: new Float32Array(width * height), s: new Float32Array(width * height), n: new Float32Array(width * height) };
  for (let i = 0; i < width * height; i++) if (depth[i]! > hold) { base.q[i] = 1 / depth[i]!; base.s[i] = shade[i]!; base.n[i] = 1; }
  const levels = [base];
  while (levels.at(-1)!.w > 1 || levels.at(-1)!.h > 1) {
    const f = levels.at(-1)!;
    const w = Math.ceil(f.w / 2), h = Math.ceil(f.h / 2);
    const c: Level = { w, h, q: new Float32Array(w * h), s: new Float32Array(w * h), n: new Float32Array(w * h) };
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      const from = y * f.w + x, to = (y >> 1) * w + (x >> 1);
      c.q[to]! += f.q[from]!; c.s[to]! += f.s[from]!; c.n[to]! += f.n[from]!;
    }
    levels.push(c);
  }
  // Pull: a cell with background keeps its own average, an empty one takes the coarser level, sampled bilinearly.
  let q = new Float32Array([levels.at(-1)!.q[0]! / levels.at(-1)!.n[0]!]), s = new Float32Array([levels.at(-1)!.s[0]! / levels.at(-1)!.n[0]!]);
  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l]!, c = levels[l + 1]!;
    const nq = new Float32Array(f.w * f.h), ns = new Float32Array(f.w * f.h);
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      const i = y * f.w + x;
      if (f.n[i]! > 0) { nq[i] = f.q[i]! / f.n[i]!; ns[i] = f.s[i]! / f.n[i]!; continue; }
      const cx = Math.min(c.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), cy = Math.min(c.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const x0 = Math.floor(cx), y0 = Math.floor(cy), x1 = Math.min(c.w - 1, x0 + 1), y1 = Math.min(c.h - 1, y0 + 1);
      const ax = cx - x0, ay = cy - y0;
      const mix = (v: Float32Array) => (v[y0 * c.w + x0]! * (1 - ax) + v[y0 * c.w + x1]! * ax) * (1 - ay) + (v[y1 * c.w + x0]! * (1 - ax) + v[y1 * c.w + x1]! * ax) * ay;
      nq[i] = mix(q); ns[i] = mix(s);
    }
    q = nq; s = ns;
  }
  return {
    pixels,
    depth: Float32Array.from(pixels, (i) => Math.max(hold * 1.05, 1 / q[i]!)),
    shade: Uint8Array.from(pixels, (i) => Math.round(s[i]!)),
  };
}

/** Orthonormal look-at basis for the pose's target. */
export function cameraBasis(pose: CameraPose) {
  const x = pose.targetX - pose.x, y = pose.targetY - pose.y, z = pose.targetZ - pose.z;
  const length = Math.hypot(x, y, z);
  const forward = [x / length, y / length, z / length] as const;
  const horizontal = Math.hypot(forward[0], forward[2]);
  const right = [forward[2] / horizontal, 0, -forward[0] / horizontal] as const;
  const up = [forward[1] * right[2], forward[2] * right[0] - forward[0] * right[2], -forward[1] * right[0]] as const;
  return { forward, right, up };
}

/**
 * Forward projection with a depth buffer. Newly revealed space stays grey; it is never fabricated geometry.
 * `crackPx` fills a hole pixel with a rendered one at most that far away on both sides of it, along a row or a column,
 * from the farther side: a surface that grows faster than its splats leaves striped cracks, and a stretched background
 * opens thin slits beside the edges in front of it. Both are background, not revealed space. Wider holes stay grey.
 */
export function cameraFrame(points: ReturnType<typeof cameraPoints>, width: number, height: number, pose: CameraPose, crackPx = 0): Buffer {
  const { xyz, shade, focal } = points;
  const image = Buffer.alloc(width * height * 3, 95);
  const depths = new Float32Array(width * height).fill(Infinity);
  const { forward: [fx, fy, fz], right: [rx, , rz], up: [ux, uy, uz] } = cameraBasis(pose);
  for (let i = 0; i < shade.length; i++) {
    const x = xyz[i * 3]! - pose.x, y = xyz[i * 3 + 1]! - pose.y, z = xyz[i * 3 + 2]! - pose.z;
    const d = x * fx + y * fy + z * fz;
    if (d <= 0.05) continue;
    const px = Math.round((x * rx + z * rz) * focal * pose.zoom / d + (width - 1) / 2 + focal * pose.shiftX);
    const py = Math.round((height - 1) / 2 - (x * ux + y * uy + z * uz) * focal * pose.zoom / d - focal * pose.shiftY);
    // A small splat closes subpixel sampling gaps without bridging wide disocclusions.
    const radius = pose.x !== 0 || pose.y !== 0 || pose.z !== 0 || pose.zoom > 1 ? 1 : 0;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      const xx = px + dx, yy = py + dy;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
      const at = yy * width + xx;
      if (d >= depths[at]!) continue;
      depths[at] = d;
      const offset = at * 3;
      image[offset] = image[offset + 1] = image[offset + 2] = shade[i]!;
    }
  }
  if (crackPx > 0) fillCracks(image, depths, width, height, crackPx);
  return image;
}

/** How far the dolly zoom's frames reach across a crack: its stretched background spreads several pixels apart. */
export const DOLLY_ZOOM_CRACK_PX = 16;

function fillCracks(image: Buffer, depths: Float32Array, width: number, height: number, reach: number): void {
  const filled = Float32Array.from(depths);
  const source = Buffer.from(image);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = y * width + x;
    if (depths[at] !== Infinity) continue;
    let best = -1, bestDepth = 0;
    for (const [sx, sy] of [[1, 0], [0, 1]] as const) {
      // The nearest rendered pixel each way along the axis, within the crack width.
      let a = -1, b = -1;
      for (let k = 1; k <= reach && a < 0; k++) { const xx = x - sx * k, yy = y - sy * k; if (xx >= 0 && yy >= 0 && depths[yy * width + xx] !== Infinity) a = yy * width + xx; }
      for (let k = 1; k <= reach && b < 0; k++) { const xx = x + sx * k, yy = y + sy * k; if (xx < width && yy < height && depths[yy * width + xx] !== Infinity) b = yy * width + xx; }
      if (a < 0 || b < 0) continue;
      const far = depths[a]! >= depths[b]! ? a : b;
      if (depths[far]! > bestDepth) { best = far; bestDepth = depths[far]!; }
    }
    if (best < 0) continue;
    filled[at] = bestDepth;
    image[at * 3] = image[at * 3 + 1] = image[at * 3 + 2] = source[best * 3]!;
  }
  depths.set(filled);
}

async function pixels(bin: string, path: string, width: number, height: number, signal: AbortSignal): Promise<Buffer> {
  const child = spawn(bin, ["-v", "error", "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { signal, stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = []; let size = 0; let error = "";
  child.stdout.on("data", (b: Buffer) => { chunks.push(b); size += b.length; if (size > width * height * 3) child.kill(); });
  child.stderr.on("data", (b: Buffer) => { error += b.toString(); });
  const [code] = await once(child, "close");
  const result = Buffer.concat(chunks);
  if (code !== 0 || result.length !== width * height * 3) throw new Error(`Could not read camera depth: ${error.slice(-500)}`);
  return result;
}

/** The GPU step estimates depth once. Its remaining frames render on the CPU, leaving the shared GPU free. */
export async function renderCameraLayout(req: StepRequest, outputs: StepOutput[], ctx: StepContext): Promise<StepOutput[]> {
  const depth = outputs.find((o) => o.nodeId === "save_depth");
  const photo = outputs.find((o) => o.nodeId === "save_photo");
  if (!depth || !photo) throw new Error("The camera layout workflow must return its depth map and resized photo");
  const bin = await findFfmpeg();
  if (!bin) throw new Error("Camera layout needs ffmpeg");
  const width = Number(req.values.width ?? 640), height = Number(req.values.height ?? 384);
  const frames = Number(req.values.frames ?? 97), fps = Number(req.values.fps ?? 24);
  const move = String(req.values.move ?? "dolly_in");
  if (!Number.isInteger(frames) || frames < 2 || frames > 97) throw new Error("Camera layouts need 2 to 97 frames");
  cameraPose(move, 0);
  const [d, p] = await Promise.all([pixels(bin, depth.path, width, height, ctx.signal), pixels(bin, photo.path, width, height, ctx.signal)]);
  const photoPoints = cameraPoints(d, p, width, height);
  const points = move === "dolly_zoom" ? dollyZoomPoints(photoPoints, width, height) : photoPoints;
  const dest = join(req.outDir, "camera-layout.mp4");
  const child = spawn(bin, ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${width}x${height}`, "-r", String(fps), "-i", "pipe:0", "-an", "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", dest], { signal: ctx.signal, stdio: ["pipe", "ignore", "pipe"] });
  let error = "";
  child.stderr.on("data", (b: Buffer) => { error += b.toString(); });
  child.stdin.on("error", () => undefined);
  const closed = once(child, "close");
  void closed.catch(() => undefined);
  try {
    for (let i = 0; i < frames; i++) {
      if (ctx.signal.aborted) throw abortError(ctx.signal);
      const frame = cameraFrame(points, width, height, cameraPose(move, i / (frames - 1), points.subject), move === "dolly_zoom" ? DOLLY_ZOOM_CRACK_PX : 0);
      await new Promise<void>((resolve, reject) => child.stdin.write(frame, (err) => err ? reject(err) : resolve()));
      if (i % 8 === 0) ctx.onProgress({ progress: 0.8 + 0.19 * i / frames, message: "Rendering the camera path" });
    }
    child.stdin.end();
    const [code] = await closed;
    if (code !== 0) throw new Error(`Camera layout encoding failed: ${error.slice(-500)}`);
  } catch (err) { child.kill(); await closed.catch(() => undefined); throw err; }
  return [{ path: dest, kind: "video", nodeId: "camera_layout" }];
}
