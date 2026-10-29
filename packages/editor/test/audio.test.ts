import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { soundSpans } from "../src/audio/activity.js";
import { analyzeBeatsFromPcm } from "../src/audio/beats.js";
import { duckEnvelope, measure, mixAudio } from "../src/audio/mix.js";
import { decodePcm, writeWav, type Pcm } from "../src/media/ffmpeg.js";
import { resolveTools } from "../src/media/tools.js";
import { defaultStyle } from "../src/style.js";
import { SONG_BPM, songBeatTimes, synthSong } from "../scripts/fixtures.js";

describe("beat analysis", () => {
  it("finds the synthetic song's tempo, beats and bars", () => {
    const map = analyzeBeatsFromPcm(synthSong(22_050));
    expect(map.bpm).toBeCloseTo(SONG_BPM, 0);
    const truth = songBeatTimes();
    const errors = map.beats.map((b) => Math.min(...truth.map((t) => Math.abs(t - b))));
    errors.sort((a, b) => a - b);
    expect(errors[Math.floor(errors.length * 0.9)]).toBeLessThan(0.03);
    expect(map.beats.length).toBeGreaterThan(truth.length * 0.9);
    expect(map.meter).toBe(4);
    // Downbeats on bar lines (every 2 s at 120 BPM).
    const offBar = map.downbeats.filter((d) => Math.abs(d / 2 - Math.round(d / 2)) > 0.03);
    expect(offBar.length / map.downbeats.length).toBeLessThan(0.2);
  });
});

describe("duckEnvelope", () => {
  it("dips under speech, starting before it and recovering after", () => {
    const env = duckEnvelope([{ start: 1, end: 2 }], 4, 0.25, 0.15, 0.45);
    const at = (t: number) => env[Math.round(t * 100)]!;
    expect(at(0.5)).toBe(1);
    expect(at(0.9)).toBeLessThan(1);
    expect(at(1.5)).toBeCloseTo(0.25, 5);
    expect(at(2.2)).toBeGreaterThan(0.25);
    expect(at(2.6)).toBe(1);
  });
});

function tone(seconds: number, freq: number, amp: number, bursts?: [number, number][], rate = 48_000): Pcm {
  const n = Math.round(seconds * rate);
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const on = !bursts || bursts.some(([a, b]) => t >= a && t < b);
    ch[i] = on ? amp * Math.sin(2 * Math.PI * freq * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) : 0;
  }
  return { sampleRate: rate, channels: [ch, Float32Array.from(ch)] };
}

describe("mixAudio", () => {
  const tools = resolveTools();
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ns-mix-"));
    await writeWav(join(dir, "music.wav"), tone(10, 220, 0.5));
    await writeWav(join(dir, "voice.wav"), tone(6, 600, 0.3, [[1, 3], [4, 5.5]]));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("levels the master to the target and ducks the music under the voice", async () => {
    const style = defaultStyle("product_ad").audio;
    const { pcm, report } = await mixAudio(
      tools,
      [
        { path: join(dir, "music.wav"), role: "music", start: 0, in: 0, gain: 1, sourceDuration: 10 },
        { path: join(dir, "voice.wav"), role: "voice", start: 1, in: 0, gain: 1, sourceDuration: 6 },
      ],
      8,
      style,
    );
    expect(pcm.channels[0]!.length).toBe(8 * 48_000);
    expect(report.lufs.master).toBeCloseTo(style.targetLufs, 0);
    expect(report.lufs.voice).toBeCloseTo(style.voiceLufs, 0);
    // Speech at 2-4 s and 5-6.5 s on the timeline.
    expect(report.ducked[0]!.start).toBeCloseTo(2, 1);
    expect(report.ducked[0]!.end).toBeCloseTo(4, 1);
    // The music is a steady 220 Hz tone and the voice sits at 600 Hz, so the 220 Hz level shows the ducking alone.
    const level = (from: number, to: number) => rms220(pcm, from, to);
    expect(20 * Math.log10(level(2.5, 3.5) / level(0.2, 0.8))).toBeCloseTo(style.duckDb, 0);
  });

  it("leaves a song alone at the music level when nothing speaks", async () => {
    const style = defaultStyle("music_video").audio;
    const { report } = await mixAudio(tools, [{ path: join(dir, "music.wav"), role: "music", start: 0, in: 2, gain: 1, sourceDuration: 10 }], 6, style);
    expect(report.lufs.music).toBeCloseTo(style.musicLufs, 0);
    expect(report.ducked).toEqual([]);
  });

  it("finds where a voice has sound", async () => {
    const voice = await decodePcm(tools, join(dir, "voice.wav"), { channels: 1, sampleRate: 16_000 });
    const spans = soundSpans(voice);
    expect(spans).toHaveLength(2);
    expect(spans[0]!.start).toBeCloseTo(1, 1);
    expect(spans[1]!.end).toBeCloseTo(5.5, 1);
    expect(measure(voice)).not.toBeNull();
  });
});

/** RMS of the 220 Hz component (Goertzel) over [from, to) seconds. */
function rms220(pcm: Pcm, from: number, to: number): number {
  const ch = pcm.channels[0]!;
  const a = Math.round(from * pcm.sampleRate);
  const b = Math.round(to * pcm.sampleRate);
  const w = (2 * Math.PI * 220) / pcm.sampleRate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = a; i < b; i++) {
    const s = ch[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return Math.sqrt(power) / (b - a);
}

describe("liftEnvelope", () => {
  it("raises the bed in long gaps and after the last phrase, not in short pauses", async () => {
    const { liftEnvelope } = await import("../src/audio/mix.js");
    const env = liftEnvelope([{ start: 0, end: 2 }, { start: 2.8, end: 4 }, { start: 8, end: 9 }], 12, 2);
    const at = (t: number) => env[Math.round(t * 100)]!;
    expect(at(2.4)).toBe(1); // a short pause
    expect(at(6)).toBeCloseTo(2, 5); // a long gap
    expect(at(7.6)).toBe(1); // back down before speech
    expect(at(11)).toBeCloseTo(2, 5); // the tail
  });
});
