import { writeFile } from "node:fs/promises";
import { run, type RunOptions } from "./process.js";
import type { ResolvedTools } from "./tools.js";

/** What ffprobe tells us about a media file. */
export interface MediaInfo {
  path: string;
  kind: "video" | "image" | "audio";
  /** Seconds. Infinity for still images (they can fill any length). */
  durationSec: number;
  width: number | null;
  height: number | null;
  /** Frames per second of the video stream, or null. */
  fps: number | null;
  hasAudio: boolean;
}

const IMAGE_CODECS = new Set(["png", "mjpeg", "webp", "bmp", "tiff", "gif", "jpegls", "jpeg2000", "heif", "hevc_image", "av1_image"]);

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  nb_frames?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
}

export async function probeMedia(tools: Pick<ResolvedTools, "ffprobe">, path: string, options: RunOptions = {}): Promise<MediaInfo> {
  const { stdout } = await run(
    tools.ffprobe,
    ["-v", "error", "-show_entries", "format=duration,format_name:stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,nb_frames,duration:stream_disposition=attached_pic", "-of", "json", path],
    options,
  );
  const data = JSON.parse(stdout.toString("utf8")) as { format?: { duration?: string; format_name?: string }; streams?: ProbeStream[] };
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === "audio");
  const formatDuration = Number(data.format?.duration);
  const isImage =
    video !== undefined &&
    !audio &&
    (IMAGE_CODECS.has(video.codec_name ?? "") || /image2|png_pipe|jpeg_pipe|webp_pipe/.test(data.format?.format_name ?? "")) &&
    !(Number(video.nb_frames) > 1);
  if (isImage) {
    return { path, kind: "image", durationSec: Infinity, width: video.width ?? null, height: video.height ?? null, fps: null, hasAudio: false };
  }
  const streamDuration = Number(video?.duration ?? audio?.duration);
  const durationSec = Number.isFinite(formatDuration) ? formatDuration : Number.isFinite(streamDuration) ? streamDuration : 0;
  if (!video && !audio) throw new Error(`No audio or video stream in ${path}`);
  return {
    path,
    kind: video ? "video" : "audio",
    durationSec,
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: video ? parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate) : null,
    hasAudio: Boolean(audio),
  };
}

function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [num, den] = rate.split("/").map(Number);
  if (!num || !den) return null;
  return num / den;
}

/** Decoded audio: interleaving removed, one Float32Array per channel. Matches HyperFrames' AudioSignal. */
export interface Pcm {
  sampleRate: number;
  channels: Float32Array[];
}

export interface DecodeOptions extends RunOptions {
  sampleRate?: number;
  channels?: 1 | 2;
  /** Seconds into the source to start at. */
  start?: number;
  /** Seconds to decode. */
  duration?: number;
}

/** Decodes any audio (or the audio of a video) to float PCM. A file without sound decodes to silence of its length. */
export async function decodePcm(tools: Pick<ResolvedTools, "ffmpeg">, path: string, options: DecodeOptions = {}): Promise<Pcm> {
  const sampleRate = options.sampleRate ?? 48_000;
  const channelCount = options.channels ?? 2;
  const args = ["-v", "error", "-nostdin"];
  if (options.start) args.push("-ss", options.start.toFixed(6));
  if (options.duration !== undefined) args.push("-t", options.duration.toFixed(6));
  args.push("-i", path, "-vn", "-ac", String(channelCount), "-ar", String(sampleRate), "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1");
  const { stdout } = await run(tools.ffmpeg, args, options);
  const frames = Math.floor(stdout.length / 4 / channelCount);
  const interleaved = new Float32Array(stdout.buffer, stdout.byteOffset, frames * channelCount);
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) (channels[c] as Float32Array)[i] = interleaved[i * channelCount + c] as number;
  }
  return { sampleRate, channels };
}

/** Writes a WAV file: 32-bit float by default, or 16-bit integer (what speech tools read most reliably). */
export async function writeWav(path: string, pcm: Pcm, bits: 16 | 32 = 32): Promise<void> {
  const channelCount = pcm.channels.length;
  const frames = pcm.channels[0]?.length ?? 0;
  const bytes = bits / 8;
  const dataBytes = frames * channelCount * bytes;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(bits === 32 ? 3 : 1, 20); // IEEE float, or PCM
  buffer.writeUInt16LE(channelCount, 22);
  buffer.writeUInt32LE(pcm.sampleRate, 24);
  buffer.writeUInt32LE(pcm.sampleRate * channelCount * bytes, 28);
  buffer.writeUInt16LE(channelCount * bytes, 32);
  buffer.writeUInt16LE(bits, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      const v = (pcm.channels[c] as Float32Array)[i] as number;
      if (bits === 32) buffer.writeFloatLE(v, offset);
      else buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), offset);
      offset += bytes;
    }
  }
  await writeFile(path, buffer);
}

/** Parses `time=00:00:01.23` progress lines from ffmpeg's stderr into seconds. */
export function parseFfmpegTime(chunk: string): number | null {
  const matches = [...chunk.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
  const last = matches.at(-1);
  if (!last) return null;
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
}
