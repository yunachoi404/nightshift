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
    case "dolly_zoom":
      p.z = -4.5 * e; p.zoom = (subject.z - p.z) / subject.z;
      // Parallel back move plus full lens compensation holds the whole subject plane in place.
      break;
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

/** Forward projection with a depth buffer. Newly revealed space stays grey; it is never fabricated geometry. */
export function cameraFrame(points: ReturnType<typeof cameraPoints>, width: number, height: number, pose: CameraPose): Buffer {
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
  return image;
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
  const points = cameraPoints(d, p, width, height);
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
      const frame = cameraFrame(points, width, height, cameraPose(move, i / (frames - 1), points.subject));
      await new Promise<void>((resolve, reject) => child.stdin.write(frame, (err) => err ? reject(err) : resolve()));
      if (i % 8 === 0) ctx.onProgress({ progress: 0.8 + 0.19 * i / frames, message: "Rendering the camera path" });
    }
    child.stdin.end();
    const [code] = await closed;
    if (code !== 0) throw new Error(`Camera layout encoding failed: ${error.slice(-500)}`);
  } catch (err) { child.kill(); await closed.catch(() => undefined); throw err; }
  return [{ path: dest, kind: "video", nodeId: "camera_layout" }];
}
