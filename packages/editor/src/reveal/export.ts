/**
 * Renders a shot's reveal clip: the source photo, the draft, a freeze, the wipe to the final at the same frame,
 * the final playing on with its own sound, and an end card. HyperFrames draws the picture, ffmpeg cuts the media
 * and mixes the sound, like the timeline export.
 *
 * Frame exactness: the draft's run-up to the freeze and the final's run on from it are cut by frame index, not by
 * time, and the two frozen frames are extracted by index too, so the clip compares frame F of the draft with frame
 * F of its own final. A long take plays a window around F (see plan.ts). The final's run-on and its opening (the
 * end card) are one file, so one video element plays through both.
 */
import { copyFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { Aspect, FinalKind, Project } from "@nightshift/contract";
import { probeMedia } from "../media/ffmpeg.js";
import { run, type RunOptions } from "../media/process.js";
import { resolveTools, type ResolvedTools, type ToolOverrides } from "../media/tools.js";
import { frameSize } from "../render/export.js";
import { installFonts } from "../render/fonts.js";
import { grainPng } from "../render/grain.js";
import { renderPicture } from "../render/hyperframes.js";
import { buildRevealComposition, revealLayout, type RevealScene, type RevealTheme } from "./composition.js";
import { revealPair, type RevealPair } from "./pair.js";
import { planReveal, type RevealPlan } from "./plan.js";

export interface RevealProgress {
  stage: "prepare" | "render" | "audio" | "mux" | "done";
  progress: number;
  message: string;
}

export interface ExportRevealOptions {
  projectDir: string;
  outPath: string;
  /** The shot to reveal. Defaults to the project's only shot. */
  shotId?: string;
  /** 9:16 for social (default), 16:9 for wide. */
  aspect?: Aspect;
  theme?: RevealTheme;
  /** Pixels on the short side. 1080 by default. */
  shortSide?: number;
  quality?: "draft" | "standard" | "high";
  workers?: number;
  workDir?: string;
  keepWorkDir?: boolean;
  tools?: ToolOverrides;
  signal?: AbortSignal;
  onProgress?: (progress: RevealProgress) => void;
}

export interface RevealResult {
  outPath: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  sizeBytes: number;
  kind: FinalKind;
  /** The frame the draft froze on and the final was revealed at, and the draft's length in frames. */
  freezeFrame: number;
  frames: number;
  plan: RevealPlan;
  pair: RevealPair;
  warnings: string[];
  workDir?: string;
}

export async function exportReveal(project: Project, options: ExportRevealOptions): Promise<RevealResult> {
  const tools = resolveTools(options.tools);
  const report = (stage: RevealProgress["stage"], progress: number, message: string) => options.onProgress?.({ stage, progress: Math.min(1, Math.max(0, progress)), message });
  const signal = options.signal;
  const warnings: string[] = [];
  const workDir = options.workDir ?? (await mkdtemp(join(tmpdir(), "nightshift-reveal-")));
  const compDir = join(workDir, "composition");
  try {
    const bundle = await buildRevealFolder(project, { ...options, outDir: compDir, tools, warnings, report });
    const { plan, pair, width, height } = bundle;

    const picturePath = join(workDir, "picture.mp4");
    const mixPath = join(workDir, "mix.m4a");
    report("render", 0.2, "Rendering the picture");
    const audioTask = mixRevealAudio(tools, bundle, mixPath, signal).then(() => report("audio", 0.2, "Sound mixed"));
    const pictureTask = renderPicture({
      compDir,
      outPath: picturePath,
      fps: bundle.fps,
      quality: options.quality ?? "standard",
      chrome: tools.chrome,
      ffmpeg: tools.ffmpeg,
      ...(options.workers ? { workers: options.workers } : {}),
      ...(signal ? { signal } : {}),
      onProgress: (fraction) => report("render", 0.2 + 0.72 * fraction, "Rendering the reveal"),
    });
    await Promise.all([audioTask, pictureTask]);

    report("mux", 0.94, "Writing the MP4");
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
        "-af", "aresample=192000,alimiter=limit=0.8:attack=3:release=60:level=0,aresample=48000",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-t", plan.duration.toFixed(3),
        "-movflags", "+faststart",
        partial,
      ],
      { signal },
    );
    await rename(partial, options.outPath);
    const out = await probeMedia(tools, options.outPath, { signal });
    if (Math.abs(out.durationSec - plan.duration) > 2 / bundle.fps + 0.05) warnings.push(`The MP4 is ${out.durationSec.toFixed(2)} s long; the plan is ${plan.duration.toFixed(2)} s.`);
    if (out.width !== width || out.height !== height) warnings.push(`The MP4 is ${out.width}x${out.height}; expected ${width}x${height}.`);
    const { size } = await stat(options.outPath);
    report("done", 1, "Reveal finished");
    return {
      outPath: options.outPath,
      durationSec: out.durationSec,
      width,
      height,
      fps: bundle.fps,
      sizeBytes: size,
      kind: pair.kind,
      freezeFrame: plan.freezeFrame,
      frames: plan.draftFrames,
      plan,
      pair,
      warnings,
      ...(options.keepWorkDir ? { workDir } : {}),
    };
  } finally {
    if (!options.keepWorkDir) await rm(workDir, { recursive: true, force: true });
  }
}

export interface RevealFolder {
  dir: string;
  plan: RevealPlan;
  pair: RevealPair;
  scene: RevealScene;
  fps: 24 | 30 | 60;
  width: number;
  height: number;
  /** Absolute paths of the draft and the final, for the sound. */
  draftPath: string;
  finalPath: string;
  draftHasAudio: boolean;
  finalHasAudio: boolean;
}

interface FolderOptions extends Omit<ExportRevealOptions, "tools"> {
  outDir: string;
  tools: ResolvedTools;
  warnings: string[];
  report: (stage: RevealProgress["stage"], progress: number, message: string) => void;
}

/** Cuts the media by frame, picks the close crop, and writes the composition (index.html, fonts, media) to a folder. */
export async function buildRevealFolder(project: Project, o: FolderOptions): Promise<RevealFolder> {
  const { tools, signal } = o;
  const pair = revealPair(project, o.shotId);
  const aspect = o.aspect ?? "9:16";
  const { width, height } = frameSize(aspect, o.shortSide ?? 1080);
  const compDir = o.outDir;
  await mkdir(join(compDir, "media"), { recursive: true });
  o.report("prepare", 0, "Reading the draft and the final");

  const asset = (path: string) => join(o.projectDir, path);
  const draftPath = asset(pair.draftAsset.path);
  const finalPath = asset(pair.finalAsset.path);
  const [draftInfo, finalInfo] = await Promise.all([probeMedia(tools, draftPath, { signal }), probeMedia(tools, finalPath, { signal })]);
  if (!draftInfo.fps || !finalInfo.fps || !draftInfo.width || !draftInfo.height || !finalInfo.width || !finalInfo.height) throw new Error("The draft or the final is not a video.");
  const fps = pickRate(draftInfo.fps);
  if (Math.abs(draftInfo.fps - finalInfo.fps) > 0.01) o.warnings.push(`The draft runs at ${draftInfo.fps} fps and the final at ${finalInfo.fps} fps; frames are matched by index at the draft's rate.`);
  if (Math.abs(draftInfo.fps - fps) > 0.01) o.warnings.push(`The draft runs at ${draftInfo.fps} fps; the reveal renders at ${fps} fps.`);
  const [draftFrames, finalFrames] = await Promise.all([countFrames(tools, draftPath, signal), countFrames(tools, finalPath, signal)]);
  const plan = planReveal({ fps, draftFrames, finalFrames, hasSource: Boolean(pair.source), kind: pair.kind });
  const F = plan.freezeFrame;

  // Every piece of picture, cut by frame index.
  o.report("prepare", 0.03, "Cutting the draft and the final by frame");
  const media = {
    draftHead: "media/draft-head.mp4",
    draftFrame: "media/draft-frame.png",
    finalFrame: "media/final-frame.png",
    finalPlay: "media/final-play.mp4",
    srcWidth: finalInfo.width,
    srcHeight: finalInfo.height,
  } as RevealScene["media"];
  const encode = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-g", String(fps), "-keyint_min", String(fps), "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
  const even = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
  const runOpts: RunOptions = signal ? { signal } : {};
  const cuts: Promise<unknown>[] = [
    run(tools.ffmpeg, ["-v", "error", "-nostdin", "-y", "-i", draftPath, "-an", "-sn", "-vf", `select=gte(n\\,${plan.draftFrom}),setpts=PTS-STARTPTS,${even},fps=${fps}`, "-frames:v", String(F - plan.draftFrom), ...encode, join(compDir, media.draftHead)], runOpts),
    frameAt(tools, draftPath, F, join(compDir, media.draftFrame), runOpts),
    frameAt(tools, finalPath, F, join(compDir, media.finalFrame), runOpts),
    run(
      tools.ffmpeg,
      [
        "-v", "error", "-nostdin", "-y", "-i", finalPath, "-an", "-sn",
        "-filter_complex",
        `[0:v]trim=start_frame=${F}:end_frame=${plan.resumeTo},setpts=PTS-STARTPTS,${even},fps=${fps}[tail];[0:v]trim=end_frame=${Math.round((plan.endCard.end - plan.endCard.start) * fps)},setpts=PTS-STARTPTS,${even},fps=${fps}[head];[tail][head]concat=n=2:v=1:a=0[v]`,
        "-map", "[v]", ...encode, join(compDir, media.finalPlay),
      ],
      runOpts,
    ),
  ];
  if (pair.source) {
    const file = `media/source${extname(pair.source.path) || ".png"}`;
    cuts.push(copyFile(asset(pair.source.path), join(compDir, file)));
    media.source = file;
  }
  await Promise.all(cuts);

  // Where the close crop looks: the part of the final's frame F that gained the most detail over the draft's.
  o.report("prepare", 0.12, "Finding the sharpest detail");
  const layout = revealLayout({ width, height, media });
  const crop = await pickCrop(tools, join(compDir, media.draftFrame), join(compDir, media.finalFrame), layout.panel.width / layout.panel.height, signal, layout.cropW);

  const scene: RevealScene = {
    width,
    height,
    aspect,
    theme: o.theme ?? "dark",
    plan,
    media,
    copy: {
      opening: pair.opening,
      draftSize: `${draftInfo.width}×${draftInfo.height}`,
      finalSize: `${finalInfo.width}×${finalInfo.height}`,
      kind: pair.kind,
      freezeFrame: F,
      frames: draftFrames,
    },
    crop,
  };
  const html = buildRevealComposition(scene, await installFonts(["inter"], compDir));
  await writeFile(join(compDir, "index.html"), html);
  await writeFile(join(compDir, "grain.png"), grainPng());
  o.report("prepare", 0.18, "Composition ready");
  return { dir: compDir, plan, pair, scene, fps, width, height, draftPath, finalPath, draftHasAudio: draftInfo.hasAudio, finalHasAudio: finalInfo.hasAudio };
}

/** HyperFrames renders 24, 30 or 60; the clip takes the nearest, which is the source's own for LTX (24) and H3 (24 or 30). */
function pickRate(fps: number): 24 | 30 | 60 {
  return fps < 27 ? 24 : fps < 45 ? 30 : 60;
}

/** Video frames in a file, counted (nb_frames is a hint some muxers leave out). */
export async function countFrames(tools: Pick<ResolvedTools, "ffprobe">, path: string, signal?: AbortSignal): Promise<number> {
  const { stdout } = await run(tools.ffprobe, ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", path], signal ? { signal } : {});
  const n = Number(stdout.toString("utf8").trim());
  if (!Number.isInteger(n) || n < 1) throw new Error(`Could not count the frames of ${path}.`);
  return n;
}

/** Frame `index` of a video as a PNG, by index. */
function frameAt(tools: Pick<ResolvedTools, "ffmpeg">, src: string, index: number, out: string, options: RunOptions): Promise<unknown> {
  return run(tools.ffmpeg, ["-v", "error", "-nostdin", "-y", "-i", src, "-vf", `select=eq(n\\,${index})`, "-fps_mode", "passthrough", "-frames:v", "1", out], options);
}

/**
 * The window of the picture where the final's frame has the most fine detail the draft's lacks: the Laplacian
 * energy of the final minus the draft's, summed over a window of width `w` (a share of the picture) at the crop
 * panel's shape, best of a grid of positions kept off the very edges.
 */
export async function pickCrop(tools: Pick<ResolvedTools, "ffmpeg">, draftFrame: string, finalFrame: string, panelAspect: number, signal?: AbortSignal, w = 0.2): Promise<{ x: number; y: number; w: number }> {
  const W = 96;
  const gray = async (path: string): Promise<{ data: Buffer; h: number }> => {
    const { stdout } = await run(tools.ffmpeg, ["-v", "error", "-nostdin", "-i", path, "-vf", `scale=${W}:-1:flags=area,format=gray`, "-f", "rawvideo", "-"], signal ? { signal } : {});
    return { data: stdout, h: Math.floor(stdout.length / W) };
  };
  const [d, f] = await Promise.all([gray(draftFrame), gray(finalFrame)]);
  const H = Math.min(d.h, f.h);
  if (H < 4) return { x: 0.5 - w / 2, y: 0.5 - (w * (W / H)) / panelAspect / 2, w };
  const lap = (img: Buffer, x: number, y: number) => Math.abs(4 * img[y * W + x]! - img[y * W + x - 1]! - img[y * W + x + 1]! - img[(y - 1) * W + x]! - img[(y + 1) * W + x]!);
  const gain = new Float32Array(W * H);
  const detail = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const lf = lap(f.data, x, y);
      const ld = lap(d.data, x, y);
      gain[y * W + x] = Math.max(0, lf - ld);
      detail[y * W + x] = lf;
    }
  }
  const winW = Math.max(2, Math.round(w * W));
  const winH = Math.max(2, Math.round((w * W) / panelAspect));
  if (winH >= H) return { x: 0.5 - w / 2, y: 0, w };
  let best = { score: -1, x: 0, y: 0 };
  const margin = 2;
  for (let y = margin; y + winH <= H - margin; y += 2) {
    for (let x = margin; x + winW <= W - margin; x += 2) {
      let g = 0;
      let e = 0;
      for (let yy = y; yy < y + winH; yy++) for (let xx = x; xx < x + winW; xx++) (g += gain[yy * W + xx]!), (e += detail[yy * W + xx]!);
      // Fine detail in the final matters most (a flat wall shows nothing up close); detail gained over the draft
      // breaks ties towards where the finish shows.
      const score = e + 0.6 * g;
      if (score > best.score) best = { score, x, y };
    }
  }
  return { x: best.x / W, y: best.y / H, w };
}

/**
 * The clip's sound, from the takes themselves: the draft's sound while the draft plays, silence through the freeze
 * and the wipe, then the final's sound from the same frame on, and the final's opening under the end card.
 */
async function mixRevealAudio(tools: Pick<ResolvedTools, "ffmpeg">, b: RevealFolder, outPath: string, signal?: AbortSignal): Promise<void> {
  const { plan, fps } = b;
  const ms = (sec: number) => Math.round(sec * 1000);
  const F = plan.freezeFrame / fps;
  const inputs: string[] = [];
  const graph: string[] = [];
  const mixed: string[] = [];
  let n = 0;
  const add = (path: string): number => {
    inputs.push("-i", path);
    return n++;
  };
  const piece = (label: string, input: number, from: number, length: number, at: number, fadeIn: number, fadeOut: number, extra = "") => {
    const fades = [extra, fadeIn > 0 ? `afade=t=in:st=0:d=${fadeIn.toFixed(3)}` : "", fadeOut > 0 ? `afade=t=out:st=${Math.max(0, length - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}` : ""].filter(Boolean);
    graph.push(`[${input}:a]atrim=start=${from.toFixed(4)}:duration=${length.toFixed(4)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo${fades.length ? "," + fades.join(",") : ""},adelay=${ms(at)}:all=1[${label}]`);
    mixed.push(`[${label}]`);
  };
  const stills = { start: plan.freeze.start, end: plan.resume.start };
  if (b.draftHasAudio) {
    const i = add(b.draftPath);
    piece("ad", i, plan.draftFrom / fps, plan.draft.end - plan.draft.start, plan.draft.start, plan.draftFrom > 0 ? 0.25 : 0.02, 0.1);
  }
  if (b.finalHasAudio) {
    const i = add(b.finalPath);
    // Under the opening photo, the take's first moments, soft. Through the freeze and the compare time stands still:
    // the take's sound from that moment, low and soft, a few dB under the playing sections.
    if (plan.source) piece("as", i, 0, plan.source.end - plan.source.start, plan.source.start, 0.25, 0.1, "lowpass=f=1600,volume=0.5");
    piece("ab", i, F, stills.end - stills.start, stills.start, 0.2, 0.25, "lowpass=f=1600,volume=0.5");
    piece("af", i, F, plan.resume.end - plan.resume.start, plan.resume.start, 0.1, 0.1);
    piece("ae", i, 0, plan.endCard.end - plan.endCard.start, plan.endCard.start, 0.08, Math.min(0.7, plan.endCard.end - plan.endCard.start));
  }
  if (mixed.length === 0) {
    await run(tools.ffmpeg, ["-v", "error", "-nostdin", "-y", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", plan.duration.toFixed(3), "-c:a", "aac", "-b:a", "96k", outPath], signal ? { signal } : {});
    return;
  }
  // One loudness for every clip, whatever the take's own level: social players expect about -16 LUFS.
  graph.push(`${mixed.join("")}amix=inputs=${mixed.length}:normalize=0:dropout_transition=0,apad,loudnorm=I=-16:TP=-1.5:LRA=11[out]`);
  await run(tools.ffmpeg, ["-v", "error", "-nostdin", "-y", ...inputs, "-filter_complex", graph.join(";"), "-map", "[out]", "-t", plan.duration.toFixed(3), "-c:a", "aac", "-b:a", "256k", "-ar", "48000", outPath], signal ? { signal } : {});
}
