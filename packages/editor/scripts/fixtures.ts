/**
 * Fixture media for the sample renders and the integration tests: shots (the real model footage from outputs/demo and
 * the smoke renders when present, plus generated ones), a synthetic 120 BPM song with and without vocals, and
 * voiceovers. Voices come from macOS `say` when it exists; elsewhere the voice fixtures are skipped.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Asset, Project, Shot, Take, TemplateId } from "@nightshift/contract";
import { decodePcm, writeWav, type Pcm } from "../src/media/ffmpeg.js";
import { findOnPath, resolveTools } from "../src/media/tools.js";
import { run } from "../src/media/process.js";

export const SONG_BPM = 120;
export const SONG_BARS = 20;

export const LYRICS = [
  "Neon rain on the empty street",
  "I can hear the city breathe",
  "Hold the night until it breaks",
  "We stay up for the morning light",
];

export const AD_SCRIPT =
  "Meet Lumen, the desk lamp that follows the sun. It warms up at dusk, and wakes you gently at dawn. One touch, and your whole room glows. Order yours today.";

/** The ad for the real footage: the red cup from the first real project. */
export const CUP_SCRIPT = "Meet Ember, the cup that keeps the morning warm. It holds the heat for an hour, and sits right in your hand. One cup, every morning. Order yours today.";

export const CINE_SCRIPT = "The city never sleeps. It only waits for the morning.";

export const INTRO_SCRIPT = [
  "Hi, I'm Ava, and I make films at night.",
  "Every shot starts as a quick sketch while I work.",
  "When I go to sleep, my computer finishes them.",
  "In the morning, the film is waiting for me.",
].join("\n");

export interface Fixtures {
  dir: string;
  /** True when the real LTX smoke render was found and used. */
  realShots: boolean;
  /** True when the first real project's footage (outputs/demo) was found: LTX and H3 shots, a cafe, a red cup. */
  realFootage: boolean;
  hasVoice: boolean;
  files: Record<string, string>;
}

const tools = () => resolveTools();

export async function makeFixtures(dir: string, smokeDir: string | undefined, force = false, demoDir?: string): Promise<Fixtures> {
  await mkdir(dir, { recursive: true });
  const t = tools();
  const files: Record<string, string> = {};
  const ff = (args: string[]) => run(t.ffmpeg, ["-v", "error", "-nostdin", "-y", ...args]);
  const make = async (name: string, build: (path: string) => Promise<unknown>) => {
    const path = join(dir, name);
    if (force || !existsSync(path)) await build(path);
    files[name] = name;
    return path;
  };

  // Shots. The LTX smoke render is the hero when it exists; a generated "sky with a sun" stands in otherwise.
  const smoke = smokeDir && existsSync(join(smokeDir, "layout_to_render_00001_.mp4")) ? smokeDir : undefined;
  if (smoke) {
    await make("shot_street.mp4", (p) => copyFile(join(smoke, "layout_to_render_00001_.mp4"), p));
    // The same shot with rain ambience, to test clip sound.
    await make("shot_street_rain.mp4", (p) =>
      ff(["-i", join(smoke, "layout_to_render_00001_.mp4"), "-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.25:r=48000", "-filter:a", "lowpass=f=3500,volume=0.6", "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-shortest", p]),
    );
    await make("shot_greybox.mp4", (p) => copyFile(join(smoke, "layout.mp4"), p));
    await make("still_street.png", (p) => ff(["-ss", "1.5", "-i", join(smoke, "layout_to_render_00001_.mp4"), "-frames:v", "1", p]));
  }
  // Real model footage: the first real project's LTX and H3 shots, and two clean plates cut from its 16:9 export
  // (the picture between the letterbox bars, after the title has gone and before the next dissolve).
  const demo = demoDir && existsSync(join(demoDir, "after_the_rain_16x9.mp4")) && existsSync(join(demoDir, "ltx_street_same_take.mp4")) ? demoDir : undefined;
  if (demo) {
    const film = join(demo, "after_the_rain_16x9.mp4");
    const plate = (from: string, seconds: string) => (p: string) =>
      ff(["-ss", from, "-t", seconds, "-i", film, "-vf", "crop=1920:802:0:139", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "14", "-pix_fmt", "yuv420p", p]);
    await make("real_cafe_cup.mp4", plate("4.5", "2.5"));
    await make("real_cafe_window.mp4", plate("7.4", "2.2"));
    await make("real_street_take.mp4", (p) => copyFile(join(demo, "ltx_street_same_take.mp4"), p));
    await make("real_street_remaster.mp4", (p) => copyFile(join(demo, "h3_bf16_street_remaster.mp4"), p));
    await make("real_crane_up.mp4", (p) => copyFile(join(demo, "ltx_crane_up.mp4"), p));
    await make("real_crash_zoom.mp4", (p) => copyFile(join(demo, "ltx_crash_zoom.mp4"), p));
    await make("still_cup.png", (p) => ff(["-ss", "1.2", "-i", join(dir, "real_cafe_cup.mp4"), "-frames:v", "1", p]));
  }
  await make("shot_sky.mp4", (p) =>
    ff([
      "-f", "lavfi", "-i", "gradients=s=960x544:c0=0x0b1a3a:c1=0xff7a3d:c2=0x6a2c70:nb_colors=3:speed=0.015:type=linear:r=24:d=4.5",
      "-f", "lavfi", "-i", "color=c=0xfff2c0:s=140x140:r=24:d=4.5",
      "-filter_complex",
      "[1]format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='255*clip(1-(hypot(X-70,Y-70)-50)/20,0,1)'[sun];[0][sun]overlay=x='180+30*t':y='300-20*t',scale=1920:1088,format=yuv420p",
      "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", p,
    ]),
  );
  await make("shot_fractal.mp4", (p) =>
    ff(["-f", "lavfi", "-i", "mandelbrot=s=960x544:rate=24:start_scale=2.5:end_scale=0.6:outer=normalized_iteration_count", "-t", "4.5", "-vf", "hue=h=40*t,scale=1920:1088,format=yuv420p", "-c:v", "libx264", "-crf", "16", p]),
  );
  await make("shot_cells.mp4", (p) =>
    ff(["-f", "lavfi", "-i", "life=s=480x272:mold=25:r=24:ratio=0.1:death_color=#0f2a40:life_color=#ff4d7e:mold_color=#3a1060", "-t", "4.5", "-vf", "scale=1920:1088:flags=neighbor,gblur=sigma=2,format=yuv420p", "-c:v", "libx264", "-crf", "18", p]),
  );
  await make("still_product.png", async (p) => {
    const look = smoke ? join(smoke, "..", "look", "look_00001_.png") : undefined;
    if (look && existsSync(look)) await copyFile(look, p);
    else await ff(["-f", "lavfi", "-i", "gradients=s=1024x1024:c0=0x2b2b2b:c1=0xf2d16b:type=radial:d=1", "-frames:v", "1", p]);
  });

  // The song: instrumental, then with spoken "vocals" on the bar lines.
  const songPath = await make("song_instrumental.wav", (p) => writeWav(p, synthSong()));
  const say = findOnPath("say");
  let hasVoice = false;
  if (say) {
    hasVoice = true;
    await make("voice_ad.wav", (p) => sayTo(p, AD_SCRIPT));
    await make("voice_ad_cup.wav", (p) => sayTo(p, CUP_SCRIPT));
    await make("voice_cine.wav", (p) => sayTo(p, CINE_SCRIPT, 150));
    await make("voice_intro.wav", (p) => sayTo(p, INTRO_SCRIPT.replace(/\n/g, " ")));
    await make("song_vocals.wav", async (p) => {
      const song = await decodePcm(t, songPath, { sampleRate: 44_100, channels: 2 });
      // Lines start on bars 5, 7, 13 and 15 (the verse and the chorus).
      const bars = [5, 7, 13, 15];
      for (let i = 0; i < LYRICS.length; i++) {
        const linePath = join(dir, `.lyric_${i}.wav`);
        await sayTo(linePath, LYRICS[i] as string, 165);
        const line = await decodePcm(t, linePath, { sampleRate: 44_100, channels: 2 });
        const at = (((bars[i] as number) - 1) * (4 * 60)) / SONG_BPM;
        addInto(song, line, at, 0.9);
        await rm(linePath, { force: true });
      }
      normalizePeak(song, 0.89);
      await writeWav(p, song);
    });
  }
  return { dir, realShots: Boolean(smoke), realFootage: Boolean(demo), hasVoice, files };
}

async function sayTo(path: string, text: string, rate = 180): Promise<void> {
  const aiff = `${path}.aiff`;
  await run("say", ["-v", "Samantha", "-r", String(rate), "-o", aiff, text]);
  await run(tools().ffmpeg, ["-v", "error", "-nostdin", "-y", "-i", aiff, "-ac", "1", "-ar", "44100", path]);
  await rm(aiff, { force: true });
}

function addInto(target: Pcm, source: Pcm, atSec: number, gain: number): void {
  const offset = Math.round(atSec * target.sampleRate);
  for (let c = 0; c < target.channels.length; c++) {
    const out = target.channels[c] as Float32Array;
    const src = (source.channels[c] ?? source.channels[0]) as Float32Array;
    for (let i = 0; i < src.length && offset + i < out.length; i++) out[offset + i] = (out[offset + i] as number) + (src[i] as number) * gain;
  }
}

function normalizePeak(pcm: Pcm, peak: number): void {
  let max = 0;
  for (const ch of pcm.channels) for (const v of ch) max = Math.max(max, Math.abs(v));
  if (max === 0) return;
  for (const ch of pcm.channels) for (let i = 0; i < ch.length; i++) ch[i] = ((ch[i] as number) / max) * peak;
}

/**
 * A 40 s, 120 BPM track in A minor: intro (kick and pad), verse (hats and bass), chorus (snare and a brighter
 * pad). Beats land on exact sample positions, so tests can check the beat tracker against the truth.
 */
export function synthSong(sampleRate = 44_100): Pcm {
  const beat = 60 / SONG_BPM;
  const duration = SONG_BARS * 4 * beat;
  const n = Math.round(duration * sampleRate);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  let seed = 12345;
  const noise = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2147483648 - 1;
  };
  const add = (t0: number, length: number, fn: (t: number) => number, pan = 0) => {
    const from = Math.round(t0 * sampleRate);
    const count = Math.round(length * sampleRate);
    for (let i = 0; i < count && from + i < n; i++) {
      const v = fn(i / sampleRate);
      left[from + i] = (left[from + i] as number) + v * (1 - pan);
      right[from + i] = (right[from + i] as number) + v * (1 + pan);
    }
  };
  // Am, F, C, G
  const roots = [110, 87.31, 130.81, 98];
  const chords = [
    [220, 261.63, 329.63],
    [174.61, 220, 261.63],
    [261.63, 329.63, 392],
    [196, 246.94, 293.66],
  ];
  for (let bar = 0; bar < SONG_BARS; bar++) {
    const section = bar < 4 ? "intro" : bar < 12 ? "verse" : "chorus";
    const chordIndex = bar % 4;
    const barStart = bar * 4 * beat;
    const pad = chords[chordIndex] as number[];
    const bright = section === "chorus" ? 1 : 0;
    add(barStart, 4 * beat, (t) => {
      const env = Math.min(1, t / 0.4) * Math.min(1, (4 * beat - t) / 0.2);
      let v = 0;
      for (const f of pad) v += Math.sin(2 * Math.PI * f * t) + 0.3 * bright * Math.sin(2 * Math.PI * f * 2 * t);
      return 0.045 * env * v;
    });
    for (let b = 0; b < 4; b++) {
      const t0 = barStart + b * beat;
      const accent = b === 0 ? 1 : 0.7;
      add(t0, 0.35, (t) => accent * 0.85 * Math.sin(2 * Math.PI * (50 + 110 * Math.exp(-t * 35)) * t) * Math.exp(-t * 9));
      if (section !== "intro") {
        add(t0 + beat / 2, 0.05, (t) => 0.12 * noise() * Math.exp(-t * 90), 0.4);
        const root = roots[chordIndex] as number;
        add(t0, beat * 0.9, (t) => {
          const env = Math.exp(-t * 3);
          return 0.16 * env * (Math.sin(2 * Math.PI * root * t) + 0.4 * Math.sin(2 * Math.PI * root * 2 * t) + 0.2 * Math.sin(2 * Math.PI * root * 3 * t));
        });
      }
      if (section === "chorus" && (b === 1 || b === 3)) {
        add(t0, 0.2, (t) => (0.3 * noise() + 0.25 * Math.sin(2 * Math.PI * 190 * t)) * Math.exp(-t * 22), -0.1);
      }
    }
  }
  return { sampleRate, channels: [left, right] };
}

/** Truth for the synthetic song: every beat time in seconds. */
export function songBeatTimes(): number[] {
  const beat = 60 / SONG_BPM;
  return Array.from({ length: SONG_BARS * 4 }, (_, i) => i * beat);
}

// ---------------------------------------------------------------- projects

const NOW = "2026-10-19T00:00:00.000Z";

function asset(id: string, kind: Asset["kind"], path: string, extra: Partial<Asset> = {}): Asset {
  return { id, kind, path, createdAt: NOW, ...extra };
}

interface ShotSpec {
  file: string;
  rung: "final" | "draft" | "still";
  durationSec: number;
}

function shotsFrom(specs: ShotSpec[]): { shots: Shot[]; takes: Take[]; assets: Asset[] } {
  const shots: Shot[] = [];
  const takes: Take[] = [];
  const assets: Asset[] = [];
  specs.forEach((spec, index) => {
    const shotId = `shot-${index + 1}`;
    const assetId = `a-${index + 1}`;
    const isStill = spec.rung === "still";
    assets.push(asset(assetId, isStill ? "image" : "video", spec.file));
    const shot: Shot = { id: shotId, index, prompt: `Shot ${index + 1}`, durationSec: spec.durationSec, locked: false, ...(isStill ? { stillAssetId: assetId } : {}) };
    if (!isStill) {
      const takeId = `take-${index + 1}`;
      takes.push({ id: takeId, shotId, rung: spec.rung === "final" ? "final" : "draft", seed: 42 + index, videoAssetId: assetId, jobId: `job-${index + 1}`, ...(spec.rung === "final" ? { finalKind: "same_take" as const } : {}) });
      if (spec.rung === "final") shot.chosenFinalId = takeId;
      else shot.chosenDraftId = takeId;
    }
    shots.push(shot);
  });
  return { shots, takes, assets };
}

export function sampleProject(template: TemplateId, fx: Fixtures): Project {
  const street = fx.realShots ? "shot_street.mp4" : "shot_sky.mp4";
  const base = (name: string, brief: Record<string, unknown>, specs: ShotSpec[], audio: Asset[]): Project => {
    const { shots, takes, assets } = shotsFrom(specs);
    return { id: `sample-${template}`, name, template, aspect: "16:9", brief, shots, takes, assets: [...assets, ...audio], timeline: null, createdAt: NOW, updatedAt: NOW };
  };
  const song = asset("music", "audio", "song_instrumental.wav", { role: "music" });
  if (template === "cinematic_shot") {
    const voice = fx.hasVoice ? [asset("voice", "audio", "voice_cine.wav", { role: "voice", text: CINE_SCRIPT })] : [];
    if (fx.realFootage) {
      return base(
        "After the Rain",
        { title: "After the Rain", subtitle: "A film by Nightshift" },
        [
          { file: "real_street_take.mp4", rung: "final", durationSec: 4 },
          { file: "real_cafe_cup.mp4", rung: "final", durationSec: 2.5 },
          { file: "real_cafe_window.mp4", rung: "final", durationSec: 2.2 },
        ],
        [song, ...voice],
      );
    }
    return base(
      "The Quiet Hours",
      { title: "The Quiet Hours", subtitle: "A film by Nightshift" },
      [
        { file: fx.realShots ? "shot_street_rain.mp4" : "shot_sky.mp4", rung: "final", durationSec: 4 },
        { file: fx.realShots ? "shot_greybox.mp4" : "shot_fractal.mp4", rung: "draft", durationSec: 4 },
        { file: fx.realShots ? "still_street.png" : "still_product.png", rung: "still", durationSec: 3.5 },
      ],
      [song, ...voice],
    );
  }
  if (template === "music_video") {
    const vocals = fx.hasVoice ? "song_vocals.wav" : "song_instrumental.wav";
    const track = asset("song", "audio", vocals, { role: "music", ...(fx.hasVoice ? { text: LYRICS.join("\n") } : {}) });
    if (fx.realFootage) {
      return base(
        "Neon Rain",
        { title: "Neon Rain", artist: "Nightshift Demo", durationSec: 30 },
        [
          { file: "real_street_remaster.mp4", rung: "final", durationSec: 3 },
          { file: "real_crane_up.mp4", rung: "draft", durationSec: 2.5 },
          { file: "real_cafe_cup.mp4", rung: "final", durationSec: 2.5 },
          { file: "real_crash_zoom.mp4", rung: "draft", durationSec: 2 },
          { file: "real_cafe_window.mp4", rung: "final", durationSec: 2.2 },
          { file: "real_street_take.mp4", rung: "final", durationSec: 3 },
        ],
        [track],
      );
    }
    return base(
      "Neon Rain",
      { title: "Neon Rain", artist: "Nightshift Demo", durationSec: 30 },
      [
        { file: street, rung: "final", durationSec: 3 },
        { file: "shot_sky.mp4", rung: "final", durationSec: 2.5 },
        { file: "shot_fractal.mp4", rung: "draft", durationSec: 2 },
        { file: "shot_cells.mp4", rung: "draft", durationSec: 2 },
        { file: fx.realShots ? "shot_greybox.mp4" : "shot_sky.mp4", rung: "draft", durationSec: 3 },
        { file: "still_product.png", rung: "still", durationSec: 2 },
      ],
      [track],
    );
  }
  if (template === "product_ad") {
    if (fx.realFootage) {
      return base(
        "Ember launch",
        { productName: "Ember", tagline: "Keeps the morning warm", cta: "Order yours today", script: CUP_SCRIPT, productImageAssetId: "product-photo" },
        [
          { file: "real_cafe_cup.mp4", rung: "final", durationSec: 2.5 },
          { file: "real_crash_zoom.mp4", rung: "draft", durationSec: 2 },
          { file: "real_cafe_window.mp4", rung: "final", durationSec: 2.2 },
          { file: "still_cup.png", rung: "still", durationSec: 3 },
        ],
        [asset("product-photo", "image", "still_cup.png"), song, ...(fx.hasVoice ? [asset("voice", "audio", "voice_ad_cup.wav", { role: "voice", text: CUP_SCRIPT })] : [])],
      );
    }
    return base(
      "Lumen launch",
      { productName: "Lumen", tagline: "Light that keeps time", cta: "Order yours today", script: AD_SCRIPT, productImageAssetId: "product-photo" },
      [
        { file: "shot_sky.mp4", rung: "final", durationSec: 3 },
        { file: street, rung: "final", durationSec: 3 },
        { file: "shot_fractal.mp4", rung: "draft", durationSec: 3 },
        { file: "still_product.png", rung: "still", durationSec: 3 },
      ],
      [asset("product-photo", "image", "still_product.png"), song, ...(fx.hasVoice ? [asset("voice", "audio", "voice_ad.wav", { role: "voice", text: AD_SCRIPT })] : [])],
    );
  }
  const introVoice = fx.hasVoice ? [asset("voice", "audio", "voice_intro.wav", { role: "voice", text: INTRO_SCRIPT })] : [];
  const introBrief = { script: INTRO_SCRIPT, title: "Films at night", subtitle: "A short introduction", speakerName: "Ava Chen", speakerTitle: "Filmmaker, Nightshift" };
  if (fx.realFootage) {
    return base(
      "Hello from Ava",
      introBrief,
      [
        { file: "real_street_take.mp4", rung: "final", durationSec: 4 },
        { file: "real_cafe_window.mp4", rung: "final", durationSec: 2.2 },
        { file: "real_crane_up.mp4", rung: "draft", durationSec: 4 },
        { file: "real_street_remaster.mp4", rung: "final", durationSec: 4 },
      ],
      [song, ...introVoice],
    );
  }
  return base(
    "Hello from Ava",
    introBrief,
    [
      { file: street, rung: "final", durationSec: 4 },
      { file: "shot_sky.mp4", rung: "final", durationSec: 4 },
      { file: fx.realShots ? "shot_greybox.mp4" : "shot_cells.mp4", rung: "draft", durationSec: 4 },
      { file: "shot_fractal.mp4", rung: "draft", durationSec: 4 },
    ],
    [song, ...introVoice],
  );
}
