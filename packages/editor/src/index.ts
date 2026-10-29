/**
 * @nightshift/editor: turns a project's shots, music, voice and captions into a finished video.
 * The engine calls these; nothing here serves HTTP. See README.md for the API and the style reference.
 */
export { assembleTimeline, assetPath, type AssembleOptions, type AssembleProgress, type AssembleResult } from "./timeline/assemble.js";
export { planTimeline, timelineDuration, type PlanInput, type PlanResult, type SongTrack, type TimelineAudio, type TimelineClip, type VoiceTrack } from "./timeline/plan.js";
export { readBrief, type EditorBrief } from "./timeline/brief.js";
export { shotSources, audioAsset, type ShotSource } from "./timeline/sources.js";
export { analyzeBeats, analyzeBeatsFromPcm, type AnalyzeBeatsOptions, type BeatMap } from "./audio/beats.js";
export { alignCaptions, type AlignCaptionsOptions, type AlignedCaptions } from "./captions/index.js";
export { alignText, type TextAlignment } from "./captions/align.js";
export { estimateWords, groupCaptions, shiftCaptions, splitSentences, type EstimateOptions, type GroupOptions } from "./captions/group.js";
export { transcribeWords, type TranscribeOptions } from "./captions/whisper.js";
export type { Word } from "./captions/words.js";
export { buildCompositionFolder, exportVideo, frameSize, FRAME_SIZES, type CompositionFolder, type CompositionFolderOptions, type ExportOptions, type ExportProgress, type ExportResult } from "./render/export.js";
export { buildComposition, type Composition, type Scene, type SceneClip } from "./render/composition.js";
export { mixAudio, type MixReport, type Stem } from "./audio/mix.js";
export { defaultStyle, resolveStyle, TimelineStyleSchema, FontIdSchema, type FontId, type ResolvedStyle, type TimelineStyle } from "./style.js";
export { probeMedia, type MediaInfo } from "./media/ffmpeg.js";
export { resolveTools, findWhisperModel, findChrome, type ResolvedTools, type ToolOverrides } from "./media/tools.js";
export { checkTools, type ToolReport } from "./media/check.js";
export { defaultCacheDir, downloadWhisperFile, downloadWhisperModels, ensureRenderBrowser, WHISPER_DOWNLOADS, type DownloadProgress, type WhisperModelName } from "./media/install.js";
export { exportReveal, buildRevealFolder, countFrames, pickCrop, type ExportRevealOptions, type RevealProgress, type RevealResult, type RevealFolder } from "./reveal/export.js";
export { revealPair, revealShot, canRevealSameTake, RevealError, type RevealPair } from "./reveal/pair.js";
export { planReveal, frameAt, BEATS as REVEAL_BEATS, type RevealPlan, type RevealPlanInput } from "./reveal/plan.js";
export { buildRevealComposition, revealLayout, fitHeadline, cropWindow, REVEAL_COMPOSITION_ID, type RevealScene, type RevealTheme, type RevealLayout } from "./reveal/composition.js";
