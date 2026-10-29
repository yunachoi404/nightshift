import { accessSync, constants, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/**
 * Paths to the external programs the editor drives. Every field is optional: anything left out is looked up
 * in the environment, then on PATH, then in the usual install folders (Homebrew, apt, caches).
 */
export interface ToolOverrides {
  ffmpeg?: string;
  ffprobe?: string;
  /** whisper.cpp's CLI (`whisper-cli`). */
  whisper?: string;
  /** A ggml whisper model, e.g. `ggml-large-v3-turbo.bin`. */
  whisperModel?: string;
  /** whisper.cpp's voice activity tool (`whisper-vad-speech-segments`), used to find sung phrases. */
  whisperVad?: string;
  /** A Silero VAD model for whisper.cpp, e.g. `ggml-silero-v6.2.0.bin`. */
  vadModel?: string;
  /** Chrome or chrome-headless-shell for HyperFrames. */
  chrome?: string;
}

export interface ResolvedTools {
  ffmpeg: string;
  ffprobe: string;
  whisper: string | null;
  whisperModel: string | null;
  whisperVad: string | null;
  vadModel: string | null;
  chrome: string | null;
}

// Apps started from the macOS Finder get a bare PATH, so the usual install folders are always searched too.
const EXTRA_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin"];

export function findOnPath(name: string): string | null {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), ...EXTRA_BIN_DIRS].filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolveTools(overrides: ToolOverrides = {}): ResolvedTools {
  const env = process.env;
  const ffmpeg = overrides.ffmpeg ?? env.NIGHTSHIFT_FFMPEG ?? findOnPath("ffmpeg");
  const ffprobe = overrides.ffprobe ?? env.NIGHTSHIFT_FFPROBE ?? findOnPath("ffprobe");
  if (!ffmpeg || !ffprobe) {
    throw new Error("ffmpeg and ffprobe are required for the editor. Install them (brew install ffmpeg, apt install ffmpeg) or set NIGHTSHIFT_FFMPEG and NIGHTSHIFT_FFPROBE.");
  }
  const whisper = overrides.whisper ?? env.NIGHTSHIFT_WHISPER ?? findOnPath("whisper-cli") ?? findOnPath("whisper-cpp");
  const vadSibling = whisper ? join(dirname(whisper), "whisper-vad-speech-segments") : null;
  return {
    ffmpeg,
    ffprobe,
    whisper,
    whisperModel: overrides.whisperModel ?? env.NIGHTSHIFT_WHISPER_MODEL ?? findWhisperModel(),
    whisperVad: overrides.whisperVad ?? env.NIGHTSHIFT_WHISPER_VAD ?? (vadSibling && isExecutable(vadSibling) ? vadSibling : findOnPath("whisper-vad-speech-segments")),
    vadModel: overrides.vadModel ?? env.NIGHTSHIFT_VAD_MODEL ?? findModel(VAD_MODEL_PREFERENCE),
    chrome: overrides.chrome ?? env.PRODUCER_HEADLESS_SHELL_PATH ?? findChrome(),
  };
}

/** Model files in order of preference: the most accurate one we can find wins. */
const WHISPER_MODEL_PREFERENCE = [
  "ggml-large-v3-turbo.bin",
  "ggml-large-v3-turbo-q8_0.bin",
  "ggml-large-v3-turbo-q5_0.bin",
  "ggml-large-v3.bin",
  "ggml-medium.en.bin",
  "ggml-small.en.bin",
  "ggml-small.bin",
  "ggml-base.en.bin",
  "ggml-base.bin",
];

export function whisperModelDirs(): string[] {
  const home = homedir();
  return [
    process.env.NIGHTSHIFT_WHISPER_MODEL_DIR,
    join(home, ".cache", "nightshift", "whisper"),
    join(home, ".cache", "hyperframes", "whisper", "models"),
    join(home, ".cache", "whisper.cpp"),
    join(home, ".local", "share", "whisper.cpp"),
    "/opt/homebrew/share/whisper-cpp",
    "/usr/local/share/whisper-cpp",
  ].filter((dir): dir is string => Boolean(dir));
}

export const VAD_MODEL_PREFERENCE = ["ggml-silero-v6.2.0.bin", "ggml-silero-v5.1.2.bin"];

export function findWhisperModel(dirs: readonly string[] = whisperModelDirs()): string | null {
  return findModel(WHISPER_MODEL_PREFERENCE, dirs);
}

function findModel(names: readonly string[], dirs: readonly string[] = whisperModelDirs()): string | null {
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = join(dir, name);
      if (existsSync(candidate) && statSync(candidate).size > 100_000) return candidate;
    }
  }
  return null;
}

/** Folders that may hold chrome-headless-shell builds (HyperFrames' and Puppeteer's caches, and ours). */
export function chromeCacheDirs(): string[] {
  const home = homedir();
  return [
    join(home, ".cache", "nightshift", "chrome-headless-shell"),
    join(home, ".cache", "hyperframes", "chrome", "chrome-headless-shell"),
    join(home, ".cache", "puppeteer", "chrome-headless-shell"),
  ];
}

export function findChrome(): string | null {
  const binary = process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell";
  for (const cache of chromeCacheDirs()) {
    if (!existsSync(cache)) continue;
    // Layout: <cache>/<platform>-<version>/chrome-headless-shell-<platform>/chrome-headless-shell. Newest first.
    const builds = readdirSync(cache).sort().reverse();
    for (const build of builds) {
      const buildDir = join(cache, build);
      if (!statSync(buildDir).isDirectory()) continue;
      for (const inner of readdirSync(buildDir)) {
        const candidate = join(buildDir, inner, binary);
        if (isExecutable(candidate)) return candidate;
      }
    }
  }
  // Linux arm64 has no chrome-headless-shell build from Chrome. Playwright ships one (the DGX Spark has it cached);
  // a distro Chromium works too.
  const playwright = join(homedir(), ".cache", "ms-playwright");
  if (existsSync(playwright)) {
    const builds = readdirSync(playwright).sort().reverse();
    for (const [prefix, inner] of [["chromium_headless_shell-", "headless_shell"], ["chromium-", "chrome"]] as const) {
      for (const build of builds.filter((b) => b.startsWith(prefix))) {
        for (const dir of ["chrome-linux", "chrome-linux64", "chrome-linux-arm64"]) {
          const candidate = join(playwright, build, dir, inner);
          if (isExecutable(candidate)) return candidate;
        }
      }
    }
  }
  for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"]) {
    const found = findOnPath(name);
    if (found) return found;
  }
  const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (process.platform === "darwin" && isExecutable(macChrome)) return macChrome;
  return null;
}
