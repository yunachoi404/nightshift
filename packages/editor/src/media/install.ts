/**
 * One-time downloads the editor needs, for the installer to call: whisper models for captions and the headless
 * Chrome HyperFrames renders with. Everything lands under ~/.cache/nightshift unless told otherwise, which is where
 * `resolveTools` looks.
 */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Browser, detectBrowserPlatform, install, resolveBuildId } from "@puppeteer/browsers";

export interface DownloadProgress {
  file: string;
  doneBytes: number;
  totalBytes: number;
}

/** whisper.cpp models (MIT, OpenAI Whisper weights under MIT) and the Silero VAD model (MIT). */
export const WHISPER_DOWNLOADS = {
  "large-v3-turbo": {
    file: "ggml-large-v3-turbo.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
    sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
    bytes: 1_624_555_275,
  },
  "small.en": {
    file: "ggml-small.en.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
    sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
    bytes: 487_614_201,
  },
  "base.en": {
    file: "ggml-base.en.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
    sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
    bytes: 147_964_211,
  },
  vad: {
    file: "ggml-silero-v6.2.0.bin",
    url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin",
    sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
    bytes: 885_098,
  },
} as const;

export type WhisperModelName = Exclude<keyof typeof WHISPER_DOWNLOADS, "vad">;

export function defaultCacheDir(): string {
  return join(homedir(), ".cache", "nightshift");
}

export interface WhisperDownloadOptions {
  /** Folder for the models. Default ~/.cache/nightshift/whisper (searched by resolveTools). */
  dir?: string;
  /** large-v3-turbo (1.6 GB, best), small.en (0.5 GB) or base.en (0.15 GB) for small machines. */
  model?: WhisperModelName;
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
}

/** Downloads a whisper model and the VAD model, checking their SHA-256. Files already present are kept. */
export async function downloadWhisperModels(options: WhisperDownloadOptions = {}): Promise<{ model: string; vad: string }> {
  const model = await downloadWhisperFile(options.model ?? "large-v3-turbo", options);
  const vad = await downloadWhisperFile("vad", options);
  return { model, vad };
}

/** Downloads one file of WHISPER_DOWNLOADS (a model, or "vad"), checking its SHA-256. Kept if already present. */
export async function downloadWhisperFile(name: keyof typeof WHISPER_DOWNLOADS, options: Omit<WhisperDownloadOptions, "model"> = {}): Promise<string> {
  const dir = options.dir ?? join(defaultCacheDir(), "whisper");
  await mkdir(dir, { recursive: true });
  return downloadChecked(WHISPER_DOWNLOADS[name], dir, options);
}

async function downloadChecked(item: { file: string; url: string; sha256: string; bytes: number }, dir: string, options: WhisperDownloadOptions): Promise<string> {
  const target = join(dir, item.file);
  if (existsSync(target) && (await stat(target)).size === item.bytes) return target;
  const partial = `${target}.partial`;
  const response = await fetch(item.url, { signal: options.signal ?? null });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${item.url}`);
  const hash = createHash("sha256");
  let done = 0;
  const body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>);
  body.on("data", (chunk: Buffer) => {
    hash.update(chunk);
    done += chunk.length;
    options.onProgress?.({ file: item.file, doneBytes: done, totalBytes: item.bytes });
  });
  try {
    await pipeline(body, createWriteStream(partial));
    const digest = hash.digest("hex");
    if (digest !== item.sha256) throw new Error(`${item.file} failed its checksum (got ${digest}).`);
    await rename(partial, target);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return target;
}

export interface BrowserInstallOptions {
  /** Default ~/.cache/nightshift (resolveTools looks in its chrome-headless-shell folder). */
  cacheDir?: string;
  onProgress?: (progress: DownloadProgress) => void;
}

/**
 * Installs Chrome headless shell for HyperFrames. Linux on ARM (DGX Spark) has no official build: use Playwright's
 * (`npx playwright install chromium-headless-shell`, Apache-2.0) or a distro Chromium; resolveTools finds both.
 */
export async function ensureRenderBrowser(options: BrowserInstallOptions = {}): Promise<string> {
  const platform = detectBrowserPlatform();
  if (!platform || (process.platform === "linux" && process.arch === "arm64")) {
    throw new Error("Chrome headless shell has no build for this platform. Run `npx playwright install chromium-headless-shell` or install Chromium from the system package manager.");
  }
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const buildId = await resolveBuildId(Browser.CHROMEHEADLESSSHELL, platform, "stable");
  const installed = await install({
    browser: Browser.CHROMEHEADLESSSHELL,
    buildId,
    cacheDir,
    downloadProgressCallback: (doneBytes, totalBytes) => options.onProgress?.({ file: "chrome-headless-shell", doneBytes, totalBytes }),
  });
  return installed.executablePath;
}
