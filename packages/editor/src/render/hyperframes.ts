import { delimiter, dirname } from "node:path";
import { createRenderJob, executeRenderJob, resolveConfig, type ProducerLogger } from "@hyperframes/producer";

export interface RenderPictureOptions {
  /** Folder holding index.html and its media. */
  compDir: string;
  outPath: string;
  fps: 24 | 30 | 60;
  quality: "draft" | "standard" | "high";
  /** Chrome or chrome-headless-shell. null lets HyperFrames look for its own. */
  chrome: string | null;
  ffmpeg: string;
  workers?: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number, message: string) => void;
  /** Receives HyperFrames' log lines (warnings and errors only by default). */
  log?: (level: "error" | "warn" | "info" | "debug", message: string) => void;
}

/**
 * Renders a composition folder to a silent MP4 with HyperFrames (headless Chrome, frame by frame, then ffmpeg).
 * The frame size comes from the composition's data-width and data-height.
 */
export async function renderPicture(options: RenderPictureOptions): Promise<void> {
  // HyperFrames runs ffmpeg from PATH; apps launched from the Finder have a bare PATH.
  const ffmpegDir = dirname(options.ffmpeg);
  const path = process.env.PATH ?? "";
  if (!path.split(delimiter).includes(ffmpegDir)) process.env.PATH = [ffmpegDir, path].filter(Boolean).join(delimiter);

  const lines: string[] = [];
  const sink =
    options.log ??
    ((level: string, message: string) => {
      if (level === "error") console.error(`[hyperframes] ${message}`);
    });
  const keep = (level: "error" | "warn" | "info" | "debug") => (message: string) => {
    if (level === "error" || level === "warn") lines.push(message);
    if (lines.length > 50) lines.shift();
    sink(level, message);
  };
  const logger: ProducerLogger = {
    error: keep("error"),
    warn: keep("warn"),
    info: keep("info"),
    debug: keep("debug"),
    isLevelEnabled: (level) => level === "error" || level === "warn",
  };

  const job = createRenderJob({
    fps: options.fps,
    quality: options.quality,
    format: "mp4",
    entryFile: "index.html",
    logger,
    producerConfig: resolveConfig(options.chrome ? { chromePath: options.chrome } : {}),
    ...(options.workers ? { workers: options.workers } : {}),
  });
  const restoreConsole = quietConsole((line) => sink("debug", line));
  try {
    await executeRenderJob(
      job,
      options.compDir,
      options.outPath,
      (j, message) => options.onProgress?.(Math.min(1, Math.max(0, (j.progress ?? 0) / 100)), message),
      options.signal,
    );
  } catch (error) {
    const detail = job.errorDetails?.browserConsoleTail?.slice(-5).join("\n") ?? lines.slice(-5).join("\n");
    throw new Error(`HyperFrames render failed: ${(error as Error).message}${detail ? `\n${detail}` : ""}`, { cause: error });
  } finally {
    restoreConsole();
  }
  if (job.status !== "complete") throw new Error(`HyperFrames render ended as ${job.status}: ${job.error ?? lines.slice(-3).join("; ")}`);
}

// HyperFrames' capture code prints its progress with console.log. Route those lines to the log sink so the
// engine's own output stays clean; anything else still reaches the console. Safe with renders in parallel.
const HYPERFRAMES_LINE = /^\[(initSession|FrameCapture|Browser|BrowserManager|Render|Compiler|Parallel|Producer|HyperFrames|INFO|WARN|DEBUG)[:\]\s]/;
const METHODS = ["log", "info", "warn", "error", "debug"] as const;
let quietDepth = 0;
let originals: Partial<Record<(typeof METHODS)[number], (...args: unknown[]) => void>> = {};
const sinks = new Set<(line: string) => void>();

function quietConsole(sink: (line: string) => void): () => void {
  sinks.add(sink);
  if (quietDepth++ === 0) {
    originals = {};
    for (const method of METHODS) {
      const passthrough = console[method].bind(console);
      originals[method] = console[method];
      console[method] = (...args: unknown[]) => {
        const first = typeof args[0] === "string" ? args[0] : "";
        if (HYPERFRAMES_LINE.test(first)) for (const s of sinks) s(args.map(String).join(" "));
        else passthrough(...args);
      };
    }
  }
  return () => {
    sinks.delete(sink);
    if (--quietDepth === 0) for (const method of METHODS) if (originals[method]) console[method] = originals[method];
  };
}
