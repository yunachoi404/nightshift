/** ffmpeg and ffprobe wrappers: placeholder video in mock mode, and media probing. (Exports are the editor's.) */
import { readFile } from "node:fs/promises";
import { execCapture, runStreaming, which } from "../util.js";
import { pngSize } from "./png.js";

let ffmpegPath: Promise<string | undefined> | undefined;
let ffprobePath: Promise<string | undefined> | undefined;
let encoder: Promise<string[]> | undefined;

const EXTRA_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

export function findFfmpeg(): Promise<string | undefined> {
  ffmpegPath ??= process.env.NIGHTSHIFT_FFMPEG ? Promise.resolve(process.env.NIGHTSHIFT_FFMPEG) : which("ffmpeg", EXTRA_DIRS);
  return ffmpegPath;
}

export function findFfprobe(): Promise<string | undefined> {
  ffprobePath ??= process.env.NIGHTSHIFT_FFPROBE ? Promise.resolve(process.env.NIGHTSHIFT_FFPROBE) : which("ffprobe", EXTRA_DIRS);
  return ffprobePath;
}

async function requireFfmpeg(): Promise<string> {
  const bin = await findFfmpeg();
  if (!bin) throw new Error("ffmpeg is not installed. Install it (brew install ffmpeg, apt install ffmpeg) or set NIGHTSHIFT_FFMPEG.");
  return bin;
}

/** H.264 where we can get it; every browser plays it. */
function videoEncoder(bin: string): Promise<string[]> {
  encoder ??= execCapture(bin, ["-hide_banner", "-encoders"]).then(({ stdout }) => {
    if (/\blibx264\b/.test(stdout)) return ["-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p"];
    if (/\bh264_videotoolbox\b/.test(stdout)) return ["-c:v", "h264_videotoolbox", "-b:v", "6M", "-pix_fmt", "yuv420p"];
    return ["-c:v", "mpeg4", "-q:v", "3", "-pix_fmt", "yuv420p"];
  });
  return encoder;
}

async function ffmpeg(args: string[], signal?: AbortSignal): Promise<void> {
  const bin = await requireFfmpeg();
  await runStreaming(bin, ["-hide_banner", "-loglevel", "error", "-y", ...args], { signal });
}

/** zoompan expressions per camera move. `p` is progress through the shot, 0 to 1. */
function moveExpr(move: string | undefined, frames: number): { z: string; x: string; y: string } {
  const p = `(on/${Math.max(1, frames - 1)})`;
  const cx = "iw/2-(iw/zoom/2)";
  const cy = "ih/2-(ih/zoom/2)";
  switch (move) {
    case "dolly_in":
    case "push_in":
    case "zoom_in":
      return { z: `1+0.22*${p}`, x: cx, y: cy };
    case "dolly_out":
    case "pull_back":
    case "pull_out":
    case "zoom_out":
      return { z: `1.22-0.22*${p}`, x: cx, y: cy };
    case "crash_zoom":
      return { z: `1+0.6*pow(${p},3)`, x: cx, y: cy };
    case "pan_left":
    case "truck_left":
      return { z: "1.15", x: `(iw-iw/zoom)*(1-${p})`, y: cy };
    case "pan_right":
    case "truck_right":
      return { z: "1.15", x: `(iw-iw/zoom)*${p}`, y: cy };
    case "tilt_up":
    case "crane_up":
      return { z: "1.15", x: cx, y: `(ih-ih/zoom)*(1-${p})` };
    case "tilt_down":
    case "crane_down":
      return { z: "1.15", x: cx, y: `(ih-ih/zoom)*${p}` };
    case "handheld":
      return { z: "1.08", x: `(iw-iw/zoom)*(0.5+0.18*sin(on/9)+0.07*sin(on/3.7))`, y: `(ih-ih/zoom)*(0.5+0.15*cos(on/11)+0.06*sin(on/4.3))` };
    case "orbit_left":
      return { z: `1.12+0.05*${p}`, x: `(iw-iw/zoom)*(0.8-0.6*${p})`, y: cy };
    case "orbit_right":
      return { z: `1.12+0.05*${p}`, x: `(iw-iw/zoom)*(0.2+0.6*${p})`, y: cy };
    default:
      return { z: `1.04+0.05*${p}`, x: cx, y: cy };
  }
}

/** A "motion draft" from a still: a slow camera move over the picture, with the shot's tag. */
export async function animateStill(o: {
  still: string;
  label: string;
  /** Where the tag image's top-left corner goes. */
  labelAt: { x: number; y: number };
  out: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  move?: string;
  signal?: AbortSignal;
}): Promise<void> {
  const bin = await requireFfmpeg();
  const { z, x, y } = moveExpr(o.move, o.frames);
  const filter =
    `[0:v]scale=${o.width * 3}:${o.height * 3}:flags=lanczos,` +
    `zoompan=z='${z}':x='${x}':y='${y}':d=${o.frames}:s=${o.width}x${o.height}:fps=${o.fps}[v];` +
    `[v][1:v]overlay=${o.labelAt.x}:${o.labelAt.y},format=yuv420p[o]`;
  await ffmpeg(
    ["-loop", "1", "-i", o.still, "-i", o.label, "-filter_complex", filter, "-map", "[o]", "-frames:v", String(o.frames), ...(await videoEncoder(bin)), "-movflags", "+faststart", o.out],
    o.signal,
  );
}

/** A placeholder "final": the draft scaled up, optionally regraded, with a new tag over the old one. */
export async function restyleVideo(o: {
  input: string;
  label: string;
  labelAt: { x: number; y: number };
  out: string;
  width: number;
  height: number;
  look: "same" | "remaster";
  signal?: AbortSignal;
}): Promise<void> {
  const bin = await requireFfmpeg();
  const grade = o.look === "remaster" ? "eq=contrast=1.08:saturation=1.35:gamma=0.96," : "";
  const filter = `[0:v]scale=${o.width}:${o.height}:flags=lanczos,${grade}unsharp=5:5:0.5[v];[v][1:v]overlay=${o.labelAt.x}:${o.labelAt.y},format=yuv420p[o]`;
  await ffmpeg(["-i", o.input, "-i", o.label, "-filter_complex", filter, "-map", "[o]", "-map", "0:a?", "-c:a", "copy", ...(await videoEncoder(bin)), "-movflags", "+faststart", o.out], o.signal);
}

export interface MediaInfo {
  width?: number;
  height?: number;
  durationSec?: number;
}

/** Dimensions and duration. PNGs are read directly; everything else needs ffprobe (skipped if missing). */
export async function probeMedia(path: string): Promise<MediaInfo> {
  if (path.toLowerCase().endsWith(".png")) {
    const head = await readFile(path).then((b) => b.subarray(0, 32)).catch(() => undefined);
    const size = head ? pngSize(head) : undefined;
    if (size) return size;
  }
  const bin = await findFfprobe();
  if (!bin) return {};
  const { stdout, code } = await execCapture(bin, ["-v", "error", "-show_entries", "stream=codec_type,width,height,duration:format=duration", "-of", "json", path]);
  if (code !== 0) return {};
  try {
    const j = JSON.parse(stdout) as { streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[]; format?: { duration?: string } };
    const video = j.streams?.find((s) => s.codec_type === "video");
    const duration = Number(j.format?.duration ?? video?.duration);
    const info: MediaInfo = {};
    if (video?.width) info.width = video.width;
    if (video?.height) info.height = video.height;
    if (Number.isFinite(duration) && duration > 0 && !/\.(png|jpe?g|webp)$/i.test(path)) info.durationSec = Math.round(duration * 100) / 100;
    return info;
  } catch {
    return {};
  }
}
