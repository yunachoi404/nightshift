import { copyFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { TimelineSchema, type Aspect, type Asset, type Project, type TemplateId, type Timeline } from "@nightshift/contract";
import { mixAudio, type MixReport, type Stem } from "../audio/mix.js";
import { probeMedia, writeWav, type MediaInfo } from "../media/ffmpeg.js";
import { mapLimit, run, type RunOptions } from "../media/process.js";
import { resolveTools, type ResolvedTools, type ToolOverrides } from "../media/tools.js";
import { resolveStyle, type TimelineStyle } from "../style.js";
import { assetPath } from "../timeline/assemble.js";
import { timelineDuration } from "../timeline/plan.js";
import { buildComposition, type Scene, type SceneClip } from "./composition.js";
import { installFonts } from "./fonts.js";
import { grainPng } from "./grain.js";
import { renderPicture } from "./hyperframes.js";
import { findFocus } from "./reframe.js";

export interface ExportProgress {
  stage: "prepare" | "render" | "audio" | "mux" | "done";
  /** 0..1 over the whole export. */
  progress: number;
  message: string;
}

export interface ExportOptions {
  /** Folder that asset paths are relative to. */
  projectDir: string;
  /** Where the MP4 goes. Written atomically (to a temp name, then renamed). */
  outPath: string;
  /** Defaults to the project's aspect. */
  aspect?: Aspect;
  /** Defaults to the project's template. Picks the default style. */
  template?: TemplateId;
  /** Pixels on the short side of the frame. 1080 by default; 720 or 540 for quick previews. */
  shortSide?: number;
  /** Encoder preset. "draft" is fastest. */
  quality?: "draft" | "standard" | "high";
  /** Chrome capture workers (default: HyperFrames decides). */
  workers?: number;
  /** Intermediate files go here (default: a temp folder, removed afterwards). */
  workDir?: string;
  keepWorkDir?: boolean;
  tools?: ToolOverrides;
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
}

export interface ExportResult {
  outPath: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  sizeBytes: number;
  audio: MixReport;
  warnings: string[];
  /** Set when `keepWorkDir` is on: holds the composition (index.html) and intermediates. */
  workDir?: string;
}

export const FRAME_SIZES: Record<Aspect, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
};

/**
 * Renders a timeline to an MP4: trims the clips with ffmpeg, draws the composition (picture, cards, captions)
 * with HyperFrames, mixes the sound, and muxes the two. Any aspect from any source: shots are cropped around
 * their subject (or fitted over a blurred copy, per style).
 */
export async function exportVideo(project: Project, timeline: Timeline, options: ExportOptions): Promise<ExportResult> {
  const tools = resolveTools(options.tools);
  const report = (stage: ExportProgress["stage"], progress: number, message: string) => options.onProgress?.({ stage, progress: Math.min(1, Math.max(0, progress)), message });
  const signal = options.signal;
  const workDir = options.workDir ?? (await mkdtemp(join(tmpdir(), "nightshift-export-")));
  const compDir = join(workDir, "composition");
  try {
    const bundle = await buildCompositionFolder(project, timeline, {
      projectDir: options.projectDir,
      outDir: compDir,
      ...(options.aspect ? { aspect: options.aspect } : {}),
      ...(options.template ? { template: options.template } : {}),
      ...(options.shortSide ? { shortSide: options.shortSide } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
      ...(signal ? { signal } : {}),
      onProgress: (fraction, message) => report("prepare", 0.12 * fraction, message),
    });
    const { timeline: parsed, assets, media, style, duration, fps, width, height, warnings } = bundle;

    // Picture and sound render at the same time.
    const picturePath = join(workDir, "picture.mp4");
    const mixPath = join(workDir, "mix.wav");
    report("render", 0.12, "Rendering the picture");
    const audioTask = (async () => {
      const stems = buildStems(parsed, assets, media, options.projectDir, style);
      const mix = await mixAudio(tools, stems, duration, style.audio, signal);
      await writeWav(mixPath, mix.pcm);
      report("audio", 0.12, "Sound mixed");
      return mix.report;
    })();
    const pictureTask = renderPicture({
      compDir,
      outPath: picturePath,
      fps,
      quality: options.quality ?? "standard",
      chrome: tools.chrome,
      ffmpeg: tools.ffmpeg,
      ...(options.workers ? { workers: options.workers } : {}),
      ...(signal ? { signal } : {}),
      onProgress: (fraction) => report("render", 0.12 + 0.78 * fraction, "Rendering video"),
    });
    const [audio] = await Promise.all([audioTask, pictureTask]);

    report("mux", 0.92, "Writing the MP4");
    await mkdir(dirname(options.outPath), { recursive: true });
    const partial = join(dirname(options.outPath), `.${basename(options.outPath)}.partial.mp4`);
    await run(
      tools.ffmpeg,
      [
        "-v", "error", "-nostdin", "-y",
        "-i", picturePath,
        "-i", mixPath,
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "copy",
        // Peaks: limit at 4x oversampling so peaks between samples count too, leaving room for the AAC encoder.
        "-af", "aresample=192000,alimiter=limit=0.8:attack=3:release=60:level=0,aresample=48000",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-t", duration.toFixed(3),
        "-movflags", "+faststart",
        partial,
      ],
      { signal },
    );
    await rename(partial, options.outPath);

    const out = await probeMedia(tools, options.outPath, { signal });
    if (Math.abs(out.durationSec - duration) > 2 / fps + 0.05) warnings.push(`The MP4 is ${out.durationSec.toFixed(2)} s long; the timeline is ${duration.toFixed(2)} s.`);
    if (out.width !== width || out.height !== height) warnings.push(`The MP4 is ${out.width}x${out.height}; expected ${width}x${height}.`);
    const { size } = await stat(options.outPath);
    report("done", 1, "Export finished");
    return {
      outPath: options.outPath,
      durationSec: out.durationSec,
      width,
      height,
      fps,
      sizeBytes: size,
      audio,
      warnings,
      ...(options.keepWorkDir ? { workDir } : {}),
    };
  } finally {
    if (!options.keepWorkDir) await rm(workDir, { recursive: true, force: true });
  }
}

export interface CompositionFolderOptions {
  projectDir: string;
  /** Where the composition goes: index.html, fonts, and trimmed media. Created if missing. */
  outDir: string;
  aspect?: Aspect;
  template?: TemplateId;
  shortSide?: number;
  tools?: ToolOverrides;
  signal?: AbortSignal;
  onProgress?: (fraction: number, message: string) => void;
}

export interface CompositionFolder {
  dir: string;
  timeline: Timeline;
  scene: Scene;
  style: TimelineStyle;
  assets: Map<string, Asset>;
  media: Record<string, MediaInfo>;
  duration: number;
  fps: 24 | 30 | 60;
  width: number;
  height: number;
  warnings: string[];
}

/**
 * Builds the HyperFrames composition for a timeline into a folder, without rendering it. Self-contained (relative
 * paths only), so the engine can also serve it for a live preview in the browser (the HyperFrames player).
 */
export async function buildCompositionFolder(project: Project, timeline: Timeline, options: CompositionFolderOptions): Promise<CompositionFolder> {
  const parsed = TimelineSchema.parse(timeline);
  const tools = resolveTools(options.tools);
  const aspect = options.aspect ?? project.aspect;
  const { style, warnings } = resolveStyle(options.template ?? project.template, parsed.style);
  const duration = timelineDuration(parsed);
  if (!(duration > 0)) throw new Error("The timeline is empty: add a clip or a card before exporting.");
  const { width, height } = frameSize(aspect, options.shortSide ?? 1080);
  const signal = options.signal;
  const compDir = options.outDir;
  await mkdir(join(compDir, "media"), { recursive: true });
  options.onProgress?.(0, "Reading media");

  const assets = new Map(project.assets.map((a) => [a.id, a]));
  const used = new Set<string>([...parsed.clips.map((c) => c.assetId), ...parsed.audio.map((a) => a.assetId), ...(parsed.overlays ?? []).flatMap((o) => (o.assetId ? [o.assetId] : []))]);
  const media: Record<string, MediaInfo> = {};
  await mapLimit([...used], 4, async (id) => {
    const asset = assets.get(id);
    if (!asset) throw new Error(`The timeline uses asset ${id}, which is not in the project.`);
    media[id] = await probeMedia(tools, assetPath(options.projectDir, asset), { signal });
  });
  const fps = pickFps(style, parsed, media);

  // Trim and normalize every clip: constant frame rate, dense keyframes, no sound (sound is mixed separately).
  let prepared = 0;
  const frameAspect = width / pictureHeight(style, width, height);
  const clips = await mapLimit(parsed.clips, 3, async (clip, i): Promise<SceneClip> => {
    const asset = assets.get(clip.assetId) as Asset;
    const info = media[clip.assetId] as MediaInfo;
    const src = assetPath(options.projectDir, asset);
    const length = clip.out - clip.in;
    if (!(length > 0)) throw new Error(`Clip ${i + 1} (${asset.path}) has no length: in ${clip.in}, out ${clip.out}.`);
    let file: string;
    if (info.kind === "image") {
      file = `media/s${i}${extname(src) || ".png"}`;
      await copyFile(src, join(compDir, file));
    } else {
      if (clip.out > info.durationSec + 0.1) warnings.push(`Clip ${i + 1} runs past the end of ${asset.path}; the last frame holds.`);
      file = `media/c${i}.mp4`;
      await trimClip(tools, src, join(compDir, file), clip.in, length, fps, { signal });
    }
    const srcWidth = info.width ?? width;
    const srcHeight = info.height ?? height;
    // Where the subject is: the crop follows it on the axis the frame cuts, and the cards keep away from it.
    const seen = await findFocus(tools, join(compDir, file), { start: 0, end: length, srcWidth, srcHeight, frameAspect, still: info.kind === "image", signal }).catch(() => null);
    const focus = clip.focus ?? (seen ? { x: seen.x, y: seen.y } : { x: 0.5, y: 0.5 });
    const subject = seen?.subject ?? focus;
    prepared++;
    options.onProgress?.(prepared / Math.max(1, parsed.clips.length), `Prepared ${prepared} of ${parsed.clips.length} clips`);
    return {
      kind: info.kind === "image" ? "image" : "video",
      src: file,
      start: clip.start,
      end: clip.start + length,
      focus,
      subject,
      ...(seen ? { box: seen.box, boxes: seen.boxes, rows: seen.rows } : {}),
      srcWidth,
      srcHeight,
    };
  });

  const overlays = await Promise.all(
    (parsed.overlays ?? []).map(async (o, i) => {
      if (!o.assetId) return o;
      const asset = assets.get(o.assetId) as Asset;
      const file = `media/o${i}${extname(asset.path) || ".png"}`;
      await copyFile(assetPath(options.projectDir, asset), join(compDir, file));
      return { ...o, imageSrc: file };
    }),
  );

  const scene: Scene = { width, height, fps, duration, aspect, style, clips, overlays, captions: parsed.captions, markers: parsed.markers ?? [] };
  const composition = buildComposition(scene, await installFonts([style.fonts.body, style.fonts.display, style.fonts.captions], compDir));
  await writeFile(join(compDir, "index.html"), composition.html);
  if (composition.grain) await writeFile(join(compDir, "grain.png"), grainPng());
  return { dir: compDir, timeline: parsed, scene, style, assets, media, duration, fps, width, height, warnings };
}

export function frameSize(aspect: Aspect, shortSide: number): { width: number; height: number } {
  const base = FRAME_SIZES[aspect];
  const k = shortSide / 1080;
  const even = (v: number) => Math.max(2, Math.round((v * k) / 2) * 2);
  return { width: even(base.width), height: even(base.height) };
}

/** Height of the picture area: the frame minus letterbox bars. */
function pictureHeight(style: TimelineStyle, width: number, height: number): number {
  const ratio = style.picture.letterbox;
  if (ratio && width > height * 1.05 && width / height < ratio) return width / ratio;
  return height;
}

/** The export frame rate: the style's, or the one most clips were shot at (HyperFrames renders 24, 30 or 60). */
export function pickFps(style: TimelineStyle, timeline: Timeline, media: Record<string, MediaInfo>): 24 | 30 | 60 {
  if (style.fps !== "auto") return style.fps;
  const votes = new Map<number, number>();
  for (const clip of timeline.clips) {
    const fps = media[clip.assetId]?.fps;
    if (!fps) continue;
    const bucket = fps < 27 ? 24 : fps < 45 ? 30 : 60;
    votes.set(bucket, (votes.get(bucket) ?? 0) + (clip.out - clip.in));
  }
  const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  return (best?.[0] ?? 30) as 24 | 30 | 60;
}

async function trimClip(tools: ResolvedTools, src: string, out: string, start: number, length: number, fps: number, options: RunOptions): Promise<void> {
  await run(
    tools.ffmpeg,
    [
      "-v", "error", "-nostdin", "-y",
      "-ss", start.toFixed(4),
      "-i", src,
      "-t", length.toFixed(4),
      "-an", "-sn",
      // Hold the last frame if the clip asks for more than the source has.
      "-vf", `fps=${fps},scale=trunc(iw/2)*2:trunc(ih/2)*2,tpad=stop_mode=clone:stop_duration=${Math.ceil(length) + 1},format=yuv420p`,
      "-t", length.toFixed(4),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "12",
      "-g", String(fps), "-keyint_min", String(fps), "-sc_threshold", "0",
      "-movflags", "+faststart",
      out,
    ],
    options,
  );
}

/** Clip sound defaults to on for the cinematic look (LTX ambience) and off elsewhere. */
export function defaultClipGain(style: TimelineStyle): number {
  return style.look === "cinematic_shot" ? 1 : 0;
}

function buildStems(timeline: Timeline, assets: Map<string, Asset>, media: Record<string, MediaInfo>, projectDir: string, style: TimelineStyle): Stem[] {
  const stems: Stem[] = [];
  for (const a of timeline.audio) {
    const asset = assets.get(a.assetId) as Asset;
    const info = media[a.assetId];
    if (!info?.hasAudio && info?.kind !== "audio") continue;
    stems.push({
      path: assetPath(projectDir, asset),
      role: a.role,
      start: a.start,
      in: a.in ?? 0,
      ...(a.out === undefined ? {} : { out: a.out }),
      gain: a.gain,
      sourceDuration: info.durationSec,
    });
  }
  for (const c of timeline.clips) {
    const asset = assets.get(c.assetId) as Asset;
    const info = media[c.assetId];
    const gain = c.gain ?? defaultClipGain(style);
    if (!info?.hasAudio || gain <= 0) continue;
    stems.push({ path: assetPath(projectDir, asset), role: "clip", start: c.start, in: c.in, out: c.out, gain, sourceDuration: info.durationSec });
  }
  return stems;
}
