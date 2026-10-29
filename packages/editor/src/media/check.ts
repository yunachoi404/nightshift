import { resolveTools, type ToolOverrides } from "./tools.js";

export interface ToolReport {
  ok: boolean;
  ffmpeg: string | null;
  ffprobe: string | null;
  whisper: string | null;
  whisperModel: string | null;
  whisperVad: string | null;
  vadModel: string | null;
  chrome: string | null;
  /** What is missing and what it costs, in plain words for the UI. */
  notes: string[];
}

/** What the editor can do on this machine. Export needs ffmpeg and Chrome; captions from audio need whisper. */
export function checkTools(overrides: ToolOverrides = {}): ToolReport {
  let tools;
  try {
    tools = resolveTools(overrides);
  } catch (error) {
    return { ok: false, ffmpeg: null, ffprobe: null, whisper: null, whisperModel: null, whisperVad: null, vadModel: null, chrome: null, notes: [(error as Error).message] };
  }
  const notes: string[] = [];
  if (!tools.chrome) notes.push("No Chrome for rendering. Run ensureRenderBrowser(), or install Chromium on Linux ARM.");
  if (!tools.whisper) notes.push("whisper.cpp is missing: captions will be timed from the text, not the voice.");
  else if (!tools.whisperModel) notes.push("No whisper model: run downloadWhisperModels().");
  if (tools.whisper && (!tools.whisperVad || !tools.vadModel)) notes.push("No VAD model: song lyrics are transcribed in one pass and can drift.");
  return { ok: Boolean(tools.chrome), ...tools, notes };
}
