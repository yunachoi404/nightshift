/**
 * End-to-end checks with the real tools: whisper.cpp on synthetic speech, and a small export through HyperFrames.
 * Each test skips itself when a tool it needs is missing (CI without Chrome, Linux without `say`).
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, Timeline } from "@nightshift/contract";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { soundSpans } from "../src/audio/activity.js";
import { alignCaptions } from "../src/captions/index.js";
import { decodePcm, probeMedia, writeWav } from "../src/media/ffmpeg.js";
import { run } from "../src/media/process.js";
import { findOnPath, resolveTools } from "../src/media/tools.js";
import { exportVideo } from "../src/render/export.js";

const tools = resolveTools();
const canSpeak = findOnPath("say") !== null;
const canRecognize = Boolean(tools.whisper && tools.whisperModel);
const canRender = Boolean(tools.chrome);

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ns-int-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

describe.skipIf(!canSpeak || !canRecognize)("captions from a voice", () => {
  const script = "Meet Lumen, the desk lamp that follows the sun. It warms up at dusk, and wakes you gently at dawn. Order yours today.";

  it("times every word of the script, on the speech", async () => {
    const aiff = join(dir, "voice.aiff");
    const wav = join(dir, "voice.wav");
    await run("say", ["-v", "Samantha", "-o", aiff, script]);
    await run(tools.ffmpeg, ["-v", "error", "-y", "-i", aiff, "-ac", "1", "-ar", "44100", wav]);
    const result = await alignCaptions({ audioPath: wav, text: script });
    expect(result.method).toBe("aligned");
    expect(result.words.map((w) => w.text).join(" ")).toBe(script);

    const sound = soundSpans(await decodePcm(tools, wav, { sampleRate: 16_000, channels: 1 }));
    // Every word starts where there is sound (within 60 ms) ...
    for (const w of result.words) expect(sound.some((s) => w.start >= s.start - 0.06 && w.start <= s.end)).toBe(true);
    // ... and each sentence starts right after a pause, within 120 ms of where the voice resumes.
    for (const i of [9, 20]) {
      const start = result.words[i]!.start;
      const resume = sound.map((s) => s.start).reduce((best, t) => (Math.abs(t - start) < Math.abs(best - start) ? t : best));
      expect(Math.abs(start - resume)).toBeLessThan(0.12);
    }
    expect(result.captions.length).toBeGreaterThanOrEqual(3);
  });
});

describe.skipIf(!canRender)("export", () => {
  it("renders a small timeline to an MP4 with picture, cards and sound", async () => {
    await run(tools.ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=3", "-pix_fmt", "yuv420p", join(dir, "a.mp4")]);
    await run(tools.ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x3050c0:s=640x360:r=24:d=3", "-pix_fmt", "yuv420p", join(dir, "b.mp4")]);
    const n = 48_000 * 4;
    const tone = Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 330 * i) / 48_000));
    await writeWav(join(dir, "music.wav"), { sampleRate: 48_000, channels: [tone, tone] });
    const now = "2026-10-19T00:00:00.000Z";
    const project: Project = {
      id: "p",
      name: "Export test",
      template: "product_ad",
      aspect: "16:9",
      brief: {},
      shots: [],
      takes: [],
      assets: [
        { id: "a", kind: "video", path: "a.mp4", createdAt: now },
        { id: "b", kind: "video", path: "b.mp4", createdAt: now },
        { id: "m", kind: "audio", path: "music.wav", role: "music", createdAt: now },
      ],
      timeline: null,
      createdAt: now,
      updatedAt: now,
    };
    const timeline: Timeline = {
      clips: [
        { shotId: "s1", assetId: "a", start: 0, in: 0, out: 2 },
        { shotId: "s2", assetId: "b", start: 2, in: 0.5, out: 2.5 },
      ],
      audio: [{ assetId: "m", role: "music", start: 0, gain: 1 }],
      captions: [{ start: 0.5, end: 1.8, text: "Hello there", words: [{ start: 0.5, end: 1, text: "Hello" }, { start: 1.1, end: 1.6, text: "there" }] }],
      overlays: [{ id: "end", kind: "end_card", start: 3, end: 4, text: "Lumen", cta: "Order now" }],
      style: { look: "product_ad" },
    };
    const stages = new Set<string>();
    const out = join(dir, "out.mp4");
    // HyperFrames' frame cache stays off even when its env var asks for one (see renderPicture).
    const frameCache = join(dir, "frame-cache");
    vi.stubEnv("HYPERFRAMES_EXTRACT_CACHE_DIR", frameCache);
    const result = await exportVideo(project, timeline, { projectDir: dir, outPath: out, aspect: "9:16", shortSide: 270, quality: "draft", onProgress: (p) => stages.add(p.stage) }).finally(() => vi.unstubAllEnvs());
    expect(existsSync(frameCache)).toBe(false);
    expect(result.warnings).toEqual([]);
    expect([result.width, result.height]).toEqual([270, 480]);
    expect(result.durationSec).toBeCloseTo(4, 1);
    expect([...stages]).toEqual(expect.arrayContaining(["prepare", "render", "mux", "done"]));
    const info = await probeMedia(tools, out);
    expect(info.hasAudio).toBe(true);
    expect(result.audio.lufs.master).toBeCloseTo(-14, 0);

    // The second clip is solid blue; the first is the colourful test card.
    const blue = await frameMean(out, 2.5);
    expect(blue[2]).toBeGreaterThan(blue[0] + 60);

    // Cancelling stops the export, leaves no MP4 behind and cleans up its work folder.
    const controller = new AbortController();
    const cancelled = join(dir, "cancelled.mp4");
    const running = exportVideo(project, timeline, {
      projectDir: dir,
      outPath: cancelled,
      shortSide: 540,
      signal: controller.signal,
      onProgress: (p) => p.stage === "render" && controller.abort(),
    });
    await expect(running).rejects.toThrow();
    expect(existsSync(cancelled)).toBe(false);
  }, 180_000);
});

async function frameMean(video: string, t: number): Promise<[number, number, number]> {
  const { stdout } = await run(tools.ffmpeg, ["-v", "error", "-ss", String(t), "-i", video, "-frames:v", "1", "-vf", "scale=16:16", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
  const sum = [0, 0, 0];
  for (let i = 0; i < stdout.length; i += 3) for (let c = 0; c < 3; c++) sum[c]! += stdout[i + c]!;
  const n = stdout.length / 3;
  return [sum[0]! / n, sum[1]! / n, sum[2]! / n];
}
