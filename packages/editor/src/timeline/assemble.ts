import { isAbsolute, join } from "node:path";
import type { Asset, Project, TemplateId } from "@nightshift/contract";
import { analyzeBeats, type BeatMap } from "../audio/beats.js";
import { estimateWords } from "../captions/group.js";
import { alignCaptions } from "../captions/index.js";
import type { Word } from "../captions/words.js";
import { probeMedia, type MediaInfo } from "../media/ffmpeg.js";
import { mapLimit } from "../media/process.js";
import { resolveTools, type ToolOverrides } from "../media/tools.js";
import { planTimeline, type PlanResult, type SongTrack, type VoiceTrack } from "./plan.js";
import { audioAsset, shotSources } from "./sources.js";

export interface AssembleProgress {
  stage: "probe" | "beats" | "voice" | "lyrics" | "plan";
  /** 0..1 over the whole assembly. */
  progress: number;
  message: string;
}

export interface AssembleOptions {
  /** Folder that asset paths are relative to. */
  projectDir: string;
  /** Defaults to the project's template. */
  template?: TemplateId;
  /** Skip analysis already done: beats of the song, word times of the voice or the song. */
  beats?: BeatMap | null;
  voiceWords?: Word[];
  lyricWords?: Word[];
  /** Transcribe the song for captions (music video). Default true. */
  lyrics?: boolean;
  /**
   * Measure what was not passed in: the song's beats and the words' times (whisper). false skips both for a quick
   * re-cut: the voice's words are estimated from its text, the song has no beat grid and no lyrics. Default true.
   */
  analyze?: boolean;
  tools?: ToolOverrides;
  signal?: AbortSignal;
  onProgress?: (progress: AssembleProgress) => void;
}

export interface AssembleResult extends PlanResult {
  /** What was measured, so the engine can store it and pass it back next time. */
  analysis: {
    media: Record<string, MediaInfo>;
    beats: BeatMap | null;
    voiceWords: Word[] | null;
    lyricWords: Word[] | null;
    captionMethod: string | null;
  };
}

/**
 * Builds a project's timeline for a template: probes the media, finds the song's beats, times the voice's words,
 * then plans the cut. Keeps the style overrides of the project's current timeline.
 */
export async function assembleTimeline(project: Project, options: AssembleOptions): Promise<AssembleResult> {
  const template = options.template ?? project.template;
  const tools = resolveTools(options.tools);
  const report = (stage: AssembleProgress["stage"], progress: number, message: string) => options.onProgress?.({ stage, progress, message });
  const warnings: string[] = [];

  // Probe every asset the plan may use: shot pictures, the audio, the product photo.
  report("probe", 0, "Reading media");
  const wanted = new Map<string, Asset>();
  for (const { asset } of shotSources(project)) wanted.set(asset.id, asset);
  for (const asset of project.assets) if (asset.kind === "audio" || asset.kind === "image") wanted.set(asset.id, asset);
  const media: Record<string, MediaInfo> = {};
  await mapLimit([...wanted.values()], 4, async (asset) => {
    try {
      media[asset.id] = await probeMedia(tools, assetPath(options.projectDir, asset), { signal: options.signal });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      warnings.push(`Could not read ${asset.path}: ${(error as Error).message}`);
    }
  });

  const songAsset = audioAsset(project, "music", template, media);
  const voiceAsset = template === "music_video" ? undefined : audioAsset(project, "voice", template, media);
  const brief = project.brief as Record<string, unknown>;

  let beats: BeatMap | null = options.beats ?? null;
  let lyricWords: Word[] | null = options.lyricWords ?? null;
  let voiceWords: Word[] | null = options.voiceWords ?? null;
  let captionMethod: string | null = null;
  const analyze = options.analyze !== false;

  if (songAsset && media[songAsset.id] && template === "music_video" && analyze) {
    if (!beats) {
      report("beats", 0.15, "Finding the beat");
      beats = await analyzeBeats(assetPath(options.projectDir, songAsset), { tools: options.tools, signal: options.signal });
    }
    if (!lyricWords && options.lyrics !== false) {
      report("lyrics", 0.35, "Listening for lyrics");
      const aligned = await alignCaptions({
        audioPath: assetPath(options.projectDir, songAsset),
        ...(songAsset.text ? { text: songAsset.text } : {}),
        kind: "lyrics",
        tools: options.tools,
        signal: options.signal,
      });
      lyricWords = aligned.words;
      captionMethod = aligned.method;
      warnings.push(...aligned.warnings);
    }
  }

  const voiceText = voiceAsset?.text ?? (typeof brief.script === "string" ? brief.script : undefined);
  if (voiceAsset && media[voiceAsset.id] && !voiceWords && !analyze) {
    voiceWords = voiceText ? estimateWords(voiceText, { start: 0, end: media[voiceAsset.id]!.durationSec }) : [];
    captionMethod = "estimated";
  }
  if (voiceAsset && media[voiceAsset.id] && !voiceWords) {
    report("voice", 0.6, "Timing the voiceover");
    const text = voiceText;
    const aligned = await alignCaptions({
      audioPath: assetPath(options.projectDir, voiceAsset),
      ...(text ? { text } : {}),
      kind: "speech",
      tools: options.tools,
      signal: options.signal,
    });
    voiceWords = aligned.words;
    captionMethod = aligned.method;
    warnings.push(...aligned.warnings);
  }

  report("plan", 0.9, "Cutting the timeline");
  const voice: VoiceTrack | null = voiceAsset && voiceWords ? { assetId: voiceAsset.id, words: voiceWords } : null;
  const song: SongTrack | null = songAsset && media[songAsset.id] ? { assetId: songAsset.id, beats, lyrics: lyricWords ?? [] } : null;
  const plan = planTimeline({ project, template, media, voice, song, style: project.timeline?.style });
  report("plan", 1, "Timeline ready");
  return {
    ...plan,
    warnings: [...warnings, ...plan.warnings],
    analysis: { media, beats, voiceWords, lyricWords, captionMethod },
  };
}

export function assetPath(projectDir: string, asset: Pick<Asset, "path">): string {
  return isAbsolute(asset.path) ? asset.path : join(projectDir, asset.path);
}
