/**
 * What the editor needs on top of a tier's models, as part of the install plan: a whisper model and the Silero VAD
 * model (word-timed captions), and a headless Chrome (rendering exports). They land in the editor's cache
 * (~/.cache/nightshift), where it looks for them, so every data folder shares one copy.
 *
 * ffmpeg and whisper.cpp itself are programs from the system's package manager: when they are missing the plan
 * says so in `notes` instead of downloading anything.
 */
import type { ModelFile, Recipe } from "@nightshift/contract";
import type { ToolReport, WhisperModelName } from "@nightshift/editor";
import type { EditorLib } from "../editorLib.js";

export const EDITOR_ITEM_PREFIX = "editor-";

const WHISPER_LICENSE = { name: "MIT (OpenAI Whisper weights, whisper.cpp conversion)", url: "https://github.com/openai/whisper/blob/main/LICENSE" };
const VAD_LICENSE = { name: "MIT (Silero VAD)", url: "https://github.com/snakers4/silero-vad/blob/master/LICENSE" };
const CHROME_LICENSE = { name: "BSD-3-Clause (Chromium)", url: "https://chromium.googlesource.com/chromium/src/+/main/LICENSE" };

/** Download sizes of Chrome for Testing's headless shell, in decimal GB (measured for 155.0.8059.79). */
const CHROME_GB: Record<string, number> = { darwin: 0.1, linux: 0.12, win32: 0.13 };

export interface EditorToolPlan {
  downloads: ModelFile[];
  present: string[];
  notes: string[];
}

export function isEditorItem(model: Pick<ModelFile, "id">): boolean {
  return model.id.startsWith(EDITOR_ITEM_PREFIX);
}

/**
 * The whisper model for a tier: large-v3-turbo (1.6 GB, the most accurate) unless the tier is for machines with
 * little memory, which get small.en (0.5 GB).
 */
export function whisperModelFor(recipe: Pick<Recipe, "match">): WhisperModelName {
  return recipe.match.minRamGb < 24 ? "small.en" : "large-v3-turbo";
}

/** `report` is what the editor found on this machine (its checkTools). */
export function planEditorTools(lib: EditorLib, recipe: Pick<Recipe, "match">, report: ToolReport, o: { platform?: NodeJS.Platform; arch?: string } = {}): EditorToolPlan {
  const WHISPER_DOWNLOADS = lib.WHISPER_DOWNLOADS;
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const downloads: ModelFile[] = [];
  const present: string[] = [];
  const notes: string[] = [];
  const whisperFile = (name: keyof EditorLib["WHISPER_DOWNLOADS"], label: string, license: ModelFile["license"]): ModelFile => {
    const item = WHISPER_DOWNLOADS[name];
    return { id: `${EDITOR_ITEM_PREFIX}whisper-${name}`, name: label, folder: "editor/whisper", filename: item.file, url: item.url, sha256: item.sha256, sizeGb: item.bytes / 1e9, license };
  };

  if (!report.ffmpeg) notes.push("ffmpeg is missing. Install it (brew install ffmpeg, or apt install ffmpeg) before you export.");

  const whisper = whisperModelFor(recipe);
  const model = whisperFile(whisper, `Whisper ${whisper}, captions model`, WHISPER_LICENSE);
  if (report.whisperModel) present.push(model.id);
  else downloads.push(model);
  const vad = whisperFile("vad", "Silero VAD, voice detection for captions", VAD_LICENSE);
  if (report.vadModel) present.push(vad.id);
  else downloads.push(vad);
  if (!report.whisper) {
    // Homebrew has whisper.cpp; Linux distributions mostly do not, so there it is built from source.
    const how = platform === "darwin" ? "Install it (brew install whisper-cpp)" : "Build it from github.com/ggml-org/whisper.cpp and put whisper-cli on the PATH";
    notes.push(`whisper.cpp is missing, so captions are timed from the text, not the voice. ${how} for word-timed captions.`);
  }

  const chrome: ModelFile = {
    id: `${EDITOR_ITEM_PREFIX}render-browser`,
    name: "Chrome headless shell, export renderer",
    folder: "editor/chrome-headless-shell",
    filename: "chrome-headless-shell",
    url: "https://googlechromelabs.github.io/chrome-for-testing/",
    sizeGb: CHROME_GB[platform] ?? 0.13,
    license: CHROME_LICENSE,
  };
  if (report.chrome) present.push(chrome.id);
  else if (platform === "linux" && arch === "arm64") notes.push("Exports need Chromium, which has no download for Linux on ARM. Run: npx playwright install chromium-headless-shell (or apt install chromium).");
  else downloads.push(chrome);
  return { downloads, present, notes };
}

/** Fetch one editor item. `onProgress` gets the bytes done so far. */
export async function installEditorItem(lib: EditorLib, item: ModelFile, o: { signal?: AbortSignal; onProgress?: (bytes: number) => void } = {}): Promise<void> {
  if (item.id === `${EDITOR_ITEM_PREFIX}render-browser`) {
    // @puppeteer/browsers takes no abort signal: a stop lands after this file.
    await lib.ensureRenderBrowser({ onProgress: (p) => o.onProgress?.(p.doneBytes) });
    return;
  }
  const name = (Object.keys(lib.WHISPER_DOWNLOADS) as (keyof EditorLib["WHISPER_DOWNLOADS"])[]).find((k) => item.id === `${EDITOR_ITEM_PREFIX}whisper-${k}`);
  if (!name) throw new Error(`Unknown editor download ${item.id}`);
  await lib.downloadWhisperFile(name, { ...(o.signal ? { signal: o.signal } : {}), onProgress: (p) => o.onProgress?.(p.doneBytes) });
}
