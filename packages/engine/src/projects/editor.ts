/**
 * The engine's side of the editor (packages/editor), the library that cuts a project into a timeline (beats, word
 * times, template rules) and renders it to an MP4.
 *
 * - The editor reads its own brief keys and style; `editorProject` translates the new-project form's keys and the
 *   UI's caption settings into them. The stored project keeps what the UI wrote.
 * - What is slow to measure (a song's beats, the words of a voice or a song) is kept per project in
 *   `projects/<id>/editor.json`, keyed by asset id, so each audio file is analysed once.
 */
import type { Aspect, Asset, Caption, ExportRequest, Project, TemplateId, Timeline } from "@nightshift/contract";
import type { AssembleOptions, BeatMap, ExportResult, RevealResult, ToolOverrides, Word } from "@nightshift/editor";
import { join } from "node:path";
import type { EditorLib } from "../editorLib.js";
import { readJson, writeJsonAtomic, type Logger } from "../util.js";
import type { ProjectStore } from "./store.js";
import { scriptLines } from "./templates.js";

/** How word times were found: aligned (known text), transcribed, estimated from the text, or none. */
export type CaptionMethod = "aligned" | "transcribed" | "estimated" | "none";

interface Analysis {
  /** Beat maps of songs, by asset id. null: the song has no steady beat. */
  beats: Record<string, BeatMap | null>;
  /** Word times of voices and songs, by asset id, in the file's own time. */
  words: Record<string, { method: CaptionMethod; words: Word[] }>;
  /** How the word times were measured (WORDS_VERSION). Older ones are measured again. */
  wordsVersion?: number;
}

/**
 * Raised when measuring word times changes, so times kept from before are measured again (beats are kept).
 * 2: snapping words to the sound keeps the script's order. Before, "One more ride" could be stored as "One ride more".
 */
const WORDS_VERSION = 2;

export interface Assembled {
  /** The cut to store: the editor's timeline with the project's own style record kept as it was. */
  timeline: Timeline;
  durationSec: number;
  warnings: string[];
  /** How the captions were timed, when there are any. */
  captionMethod: CaptionMethod | null;
}

export interface RenderOptions {
  aspect: Aspect;
  quality: NonNullable<ExportRequest["quality"]>;
  outPath: string;
  /** Scratch folder for the render, removed when it is done. */
  workDir: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number, message: string) => void;
}

const QUALITY: Record<RenderOptions["quality"], { shortSide: number; quality: "draft" | "standard" | "high" }> = {
  preview: { shortSide: 540, quality: "draft" },
  standard: { shortSide: 1080, quality: "standard" },
  high: { shortSide: 1080, quality: "high" },
};

export class EditorBridge {
  constructor(private readonly d: { store: ProjectStore; lib: () => Promise<EditorLib>; tools?: ToolOverrides; log: Logger }) {}

  /** Whether word times can be measured here (whisper.cpp and a model). Without it captions are estimated. */
  async canRecognize(): Promise<boolean> {
    const report = (await this.d.lib()).checkTools(this.d.tools ?? {});
    return Boolean(report.whisper && report.whisperModel);
  }

  /**
   * Cut the project into a timeline. `analyze` measures what is not stored yet (beats, word times; whisper can take
   * a while); without it the cut uses what is stored and estimates the rest, which is quick.
   */
  async assemble(project: Project, o: { analyze: boolean; signal?: AbortSignal; onProgress?: (fraction: number, message: string) => void }): Promise<Assembled> {
    const lib = await this.d.lib();
    const view = editorProject(project);
    const analysis = await this.load(project.id);
    const song = lib.audioAsset(view, "music", view.template);
    const voice = view.template === "music_video" ? undefined : lib.audioAsset(view, "voice", view.template);
    const opts: AssembleOptions = { projectDir: this.d.store.dir(project.id), analyze: o.analyze };
    if (this.d.tools) opts.tools = this.d.tools;
    if (o.signal) opts.signal = o.signal;
    if (o.onProgress) opts.onProgress = (p) => o.onProgress!(p.progress, p.message);
    const songWords = song ? analysis.words[song.id] : undefined;
    const voiceWords = voice ? analysis.words[voice.id] : undefined;
    if (song && analysis.beats[song.id]) opts.beats = analysis.beats[song.id]!;
    if (songWords) opts.lyricWords = songWords.words;
    if (voiceWords) opts.voiceWords = voiceWords.words;

    const result = await lib.assembleTimeline(view, opts);
    const measured = asMethod(result.analysis.captionMethod);
    if (o.analyze) {
      let changed = false;
      if (song && view.template === "music_video" && !(song.id in analysis.beats)) {
        analysis.beats[song.id] = result.analysis.beats;
        changed = true;
      }
      // Estimates are not kept: once whisper is installed, the next cut measures them.
      const analysed = view.template === "music_video" ? song : voice;
      const words = view.template === "music_video" ? result.analysis.lyricWords : result.analysis.voiceWords;
      if (analysed && words && measured && (await this.canRecognize()) && !analysis.words[analysed.id]) {
        analysis.words[analysed.id] = { method: measured, words };
        changed = true;
      }
      if (changed) await this.save(project.id, analysis);
    }
    const stored = view.template === "music_video" ? songWords : voiceWords;
    const timeline: Timeline = { ...result.timeline, style: { ...(project.timeline?.style ?? {}), look: result.timeline.style.look } };
    delete timeline.edited;
    const hasCaptions = timeline.captions.length > 0;
    return { timeline, durationSec: result.durationSec, warnings: result.warnings, captionMethod: hasCaptions ? (measured ?? stored?.method ?? null) : null };
  }

  /** The song or the voiceover the cut plays: the soundtrack's pick, else the newest of its role. */
  async audioPick(project: Project, role: "music" | "voice"): Promise<Asset | undefined> {
    const lib = await this.d.lib();
    return lib.audioAsset(editorProject(project), role, project.template);
  }

  /**
   * Word-timed captions for one voice or song placed on a hand-edited timeline: `start` is where the track sits,
   * `inSec` and `outSec` the part of the file it plays.
   */
  async captionsFor(project: Project, asset: Asset, o: { kind: "speech" | "lyrics"; start: number; inSec?: number; outSec?: number; signal?: AbortSignal }): Promise<{ captions: Caption[]; method: CaptionMethod }> {
    const lib = await this.d.lib();
    const analysis = await this.load(project.id);
    let entry = analysis.words[asset.id];
    if (!entry) {
      const aligned = await lib.alignCaptions({
        audioPath: this.d.store.assetPath(project, asset),
        ...(asset.text ? { text: asset.text } : {}),
        kind: o.kind,
        ...(this.d.tools ? { tools: this.d.tools } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
      });
      entry = { method: aligned.method, words: aligned.words };
      if (await this.canRecognize()) {
        analysis.words[asset.id] = entry;
        await this.save(project.id, analysis);
      }
    }
    const from = o.inSec ?? 0;
    const words = entry.words.filter((w) => w.start >= from && (o.outSec === undefined || w.end <= o.outSec));
    const { style } = lib.resolveStyle(project.template, editorStyle(project.template, project.timeline?.style ?? {}));
    const shifted = lib.shiftCaptions(lib.groupCaptions(words, { maxChars: style.captions.maxChars }), o.start - from);
    // Captions linger a little after their last word; never past the part of the file the track plays.
    const end = o.outSec === undefined ? Infinity : o.start + (o.outSec - from);
    const captions = shifted.map((c) => ({ ...c, end: Math.min(c.end, end) })).filter((c) => c.end > c.start);
    return { captions, method: entry.method };
  }

  /** Render a timeline to an MP4 in one aspect. */
  async render(project: Project, timeline: Timeline, o: RenderOptions): Promise<ExportResult> {
    const lib = await this.d.lib();
    const view = editorProject(project);
    const { shortSide, quality } = QUALITY[o.quality];
    return lib.exportVideo(view, { ...timeline, style: editorStyle(project.template, timeline.style) }, {
      projectDir: this.d.store.dir(project.id),
      outPath: o.outPath,
      aspect: o.aspect,
      shortSide,
      quality,
      workDir: o.workDir,
      ...(this.d.tools ? { tools: this.d.tools } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
      ...(o.onProgress ? { onProgress: (p) => o.onProgress!(p.progress, p.message) } : {}),
    });
  }

  /**
   * Render one shot's reveal clip (the draft, a freeze, the wipe to its own final at the same frame). The editor
   * pairs the final with the draft it was made from and labels a remaster as one; it throws a RevealError in plain
   * words when the shot cannot be revealed.
   */
  async renderReveal(project: Project, o: RenderOptions & { shotId?: string }): Promise<RevealResult> {
    const lib = await this.d.lib();
    const { shortSide, quality } = QUALITY[o.quality];
    return lib.exportReveal(project, {
      projectDir: this.d.store.dir(project.id),
      outPath: o.outPath,
      ...(o.shotId ? { shotId: o.shotId } : {}),
      aspect: o.aspect,
      shortSide,
      quality,
      workDir: o.workDir,
      ...(this.d.tools ? { tools: this.d.tools } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
      ...(o.onProgress ? { onProgress: (p) => o.onProgress!(p.progress, p.message) } : {}),
    });
  }

  private async load(projectId: string): Promise<Analysis> {
    const raw = await readJson<Partial<Analysis>>(join(this.d.store.dir(projectId), "editor.json")).catch((err) => {
      this.d.log(`project ${projectId}: editor.json unreadable, measuring again (${String(err)})`);
      return undefined;
    });
    const current = raw?.wordsVersion === WORDS_VERSION;
    return { beats: raw?.beats ?? {}, words: current ? (raw?.words ?? {}) : {}, wordsVersion: WORDS_VERSION };
  }

  private async save(projectId: string, analysis: Analysis): Promise<void> {
    // The project may have been deleted while its audio was being measured.
    if (!this.d.store.get(projectId)) return;
    await writeJsonAtomic(join(this.d.store.dir(projectId), "editor.json"), analysis);
  }
}

function asMethod(method: string | null): CaptionMethod | null {
  return method === "aligned" || method === "transcribed" || method === "estimated" || method === "none" ? method : null;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The project as the editor reads it. The new-project form's keys become the editor's:
 * - music_video: `length` ("30", "60") is how long the cut runs (`durationSec`).
 * - product_ad: the uploaded photo (`referenceAssetId`) is the end card's product photo, what it `does` is the
 *   tagline, and the storyboard's lines (else the template's pitch) are the script until a voiceover exists.
 * Keys the brief already has in the editor's form win. The timeline's style gets the editor's caption settings.
 */
export function editorProject(project: Project): Project {
  const brief: Record<string, unknown> = { ...project.brief };
  if (project.template === "music_video") {
    const length = Number(brief.length);
    if (brief.durationSec === undefined && Number.isFinite(length) && length > 0) brief.durationSec = length;
  }
  if (project.template === "product_ad") {
    const photo = project.assets.find((a) => a.id === brief.referenceAssetId && a.kind === "image");
    if (!str(brief.productImageAssetId) && photo) brief.productImageAssetId = photo.id;
    const does = str(brief.does);
    if (!str(brief.tagline) && does) brief.tagline = does[0]!.toUpperCase() + does.slice(1);
    if (!str(brief.script)) {
      // The lines of the shots in the cut: shots kept on a board out of it say nothing.
      const lines = [...project.shots].sort((a, b) => a.index - b.index).flatMap((s) => (s.onTimeline !== false && s.line?.trim() ? [s.line.trim()] : []));
      brief.script = (lines.length ? lines : scriptLines("product_ad", project.brief)).join(" ");
    }
  }
  const timeline = project.timeline ? { ...project.timeline, style: editorStyle(project.template, project.timeline.style) } : null;
  return { ...project, brief, timeline };
}

/**
 * The UI's caption settings in the editor's style (`TimelineStyleSchema` in packages/editor): `captions` on or off,
 * `captionLook` (clean: karaoke, the accent sweeps across the spoken word; boxed: chip, an accent block slides along
 * a plate; serif: film subtitles in the template's own face; lyrics: kinetic), `captionPos` (center, or bottom:
 * in the letterbox bar for the cinematic look, just above the lower edge otherwise) and `captionSize`. Everything
 * else passes through.
 */
export function editorStyle(template: TemplateId, style: Record<string, unknown>): Record<string, unknown> {
  const { captions, captionLook, captionPos, captionSize, ...rest } = style;
  const out: Record<string, unknown> = { ...rest };
  const caps: Record<string, unknown> = isRecord(captions) ? { ...captions } : {};
  if (typeof captions === "boolean") caps.enabled = captions;
  const look = { clean: "karaoke", boxed: "chip", serif: "subtitle", lyrics: "kinetic" }[String(captionLook)];
  if (look) caps.look = look;
  if (captionPos === "center") caps.position = "middle";
  else if (captionPos === "bottom") caps.position = template === "cinematic_shot" ? "bottom" : "lower";
  if (typeof captionSize === "number" && Number.isFinite(captionSize)) caps.size = Math.min(2, Math.max(0.5, captionSize));
  if (Object.keys(caps).length > 0) out.captions = caps;
  return out;
}
