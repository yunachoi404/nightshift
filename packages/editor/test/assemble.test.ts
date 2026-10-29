/**
 * assembleTimeline against real files (needs ffmpeg): the quick re-cut mode measures nothing.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project } from "@nightshift/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeWav } from "../src/media/ffmpeg.js";
import { run } from "../src/media/process.js";
import { resolveTools } from "../src/media/tools.js";
import { assembleTimeline } from "../src/timeline/assemble.js";

const tools = resolveTools();
const NOW = "2026-10-19T00:00:00.000Z";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ns-assemble-"));
  await run(tools.ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=24:d=4", "-pix_fmt", "yuv420p", join(dir, "a.mp4")]);
  // Two seconds of tone, a pause, two more: something a voice might look like.
  const rate = 16_000;
  const samples = Float32Array.from({ length: rate * 5 }, (_, i) => (i < rate * 2 || i > rate * 3 ? 0.3 * Math.sin((2 * Math.PI * 220 * i) / rate) : 0));
  await writeWav(join(dir, "voice.wav"), { sampleRate: rate, channels: [samples] });
});
afterAll(() => rm(dir, { recursive: true, force: true }));

function project(): Project {
  return {
    id: "p",
    name: "Lumen",
    template: "product_ad",
    aspect: "9:16",
    brief: { productName: "Lumen" },
    shots: [{ id: "s0", index: 0, prompt: "", durationSec: 3, locked: false, chosenFinalId: "t0" }],
    takes: [{ id: "t0", shotId: "s0", rung: "final", seed: 1, videoAssetId: "a", jobId: "j" }],
    assets: [
      { id: "a", kind: "video", path: "a.mp4", createdAt: NOW },
      { id: "v", kind: "audio", path: "voice.wav", role: "voice", text: "Meet Lumen. It follows the sun.", createdAt: NOW },
    ],
    timeline: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("assembleTimeline", () => {
  it("with analyze off, estimates the voice's words over its length and never runs whisper", async () => {
    // A whisper that cannot start would throw if it were called.
    const result = await assembleTimeline(project(), { projectDir: dir, analyze: false, tools: { whisper: join(dir, "no-whisper"), whisperModel: join(dir, "no-model.bin") } });
    expect(result.analysis.captionMethod).toBe("estimated");
    const words = result.analysis.voiceWords!;
    expect(words.map((w) => w.text).join(" ")).toBe("Meet Lumen. It follows the sun.");
    expect(words[0]!.start).toBe(0);
    expect(words.at(-1)!.end).toBeCloseTo(5, 1);
    expect(result.timeline.captions.length).toBeGreaterThan(0);
    // A short ad is paced towards its 15 s: the voice plays as one trim of its file per sentence, 0.8 s apart, and the
    // end card holds its longest, 6 s. Two sentences cannot fill more than that.
    const voice = result.timeline.audio;
    expect(voice.map((a) => a.role)).toEqual(["voice", "voice"]);
    expect(new Set(voice.map((a) => a.assetId)).size).toBe(1);
    expect(voice[1]!.in).toBeCloseTo(voice[0]!.out!, 3);
    const endCard = result.timeline.overlays!.find((o) => o.kind === "end_card")!;
    expect(endCard.end - endCard.start).toBeCloseTo(6, 3);
    expect(result.durationSec).toBeCloseTo(0.3 + words.at(-1)!.end + 0.8 + 0.35 + 6, 2);
  });

  it("uses word times it is given instead of measuring them", async () => {
    const voiceWords = [
      { text: "Meet", start: 0.2, end: 0.5 },
      { text: "Lumen.", start: 0.6, end: 1.1 },
    ];
    const result = await assembleTimeline(project(), { projectDir: dir, voiceWords, tools: { whisper: join(dir, "no-whisper"), whisperModel: join(dir, "no-model.bin") } });
    expect(result.analysis.voiceWords).toEqual(voiceWords);
    expect(result.timeline.captions[0]!.words!.map((w) => w.text)).toEqual(["Meet", "Lumen."]);
  });
});
