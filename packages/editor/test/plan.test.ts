import { describe, expect, it } from "vitest";
import type { BeatMap } from "../src/audio/beats.js";
import { estimateWords } from "../src/captions/group.js";
import { AD_MIN_SHOT, cinematicTitleLength, planTimeline, timelineDuration } from "../src/timeline/plan.js";
import { round3 } from "../src/captions/words.js";
import { defaultStyle, resolveStyle } from "../src/style.js";
import { audioAssetOf, expectWellFormed, fakeProject } from "./helpers.js";

function beatMap(bpm: number, seconds: number, sections: number[] = []): BeatMap {
  const period = 60 / bpm;
  const beats = Array.from({ length: Math.floor(seconds / period) }, (_, i) => Math.round(i * period * 1000) / 1000);
  const bounds = [0, ...sections, seconds];
  return {
    durationSec: seconds,
    bpm,
    confidence: 0.9,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    meter: 4,
    sections: bounds.slice(0, -1).map((start, i) => ({ start, end: bounds[i + 1]!, label: "ABCD"[i] ?? "E" })),
  };
}

describe("cinematic shot", () => {
  it("dissolves between full shots and titles the film", () => {
    const { project, media } = fakeProject("cinematic_shot", [
      { kind: "video", length: 4.1, durationSec: 4 },
      { kind: "video", length: 5.1, durationSec: 5 },
      { kind: "image", durationSec: 3 },
    ], [], { title: "The Quiet Hours" });
    const { timeline, durationSec } = planTimeline({ project, media });
    expect(timeline.clips).toHaveLength(3);
    // Each shot keeps its full length; the second starts inside the first (a 0.5 s dissolve).
    expect(timeline.clips[1]!.start).toBeCloseTo(4 - 0.5, 3);
    expect(timeline.clips[1]!.out - timeline.clips[1]!.in).toBeCloseTo(5, 3);
    expect(durationSec).toBeCloseTo(4 + 5 + 3 - 1, 3);
    expect(timeline.overlays?.[0]).toMatchObject({ kind: "title", text: "The Quiet Hours" });
    expect(timeline.clips.every((c) => c.gain === 1)).toBe(true);
    expect(expectWellFormed(timeline, media, durationSec)).toEqual([]);
    expect(timeline.style.look).toBe("cinematic_shot");
  });

  it("a 5 s film from three 2 s drafts keeps its title to about a third of it", () => {
    // Kandinsky 6 Lite's drafts on the 8 GB tier: 49 frames at 24 fps. Before, "RAIN RIDER" covered 0.5 to 3.7 s.
    const draft = { kind: "video" as const, length: 49 / 24, durationSec: 2.04 };
    const { project, media } = fakeProject("cinematic_shot", [draft, draft, draft], [], { title: "Rain Rider" });
    const { timeline, durationSec } = planTimeline({ project, media });
    // The real export of this cut was 5.0 s.
    expect(durationSec).toBeCloseTo(5, 1);
    const title = timeline.overlays![0]!;
    expect(title.start).toBeCloseTo(0.1 * durationSec, 2);
    expect(title.end - title.start).toBeCloseTo(1.5, 2);
    expect(title.end).toBeLessThan(2.1);
  });

  it("titles scale with the film: at most 3.6 s, at least the 1.5 s a short title takes to read", () => {
    expect([2.04, 4, 5.12, 10.5, 12, 30].map((d) => Math.round(cinematicTitleLength(d) * 100) / 100)).toEqual([1.02, 1.5, 1.54, 3.15, 3.6, 3.6]);
  });

  it("still makes a title card with no shots", () => {
    const { project, media } = fakeProject("cinematic_shot", []);
    const { timeline, warnings } = planTimeline({ project, media });
    expect(timeline.clips).toEqual([]);
    expect(timelineDuration(timeline)).toBeGreaterThan(0);
    expect(warnings.join(" ")).toMatch(/no picture/);
  });
});

describe.each(["camera_move", "vfx_effect"] as const)("%s quick shot", (template) => {
  it("keeps the whole shot and its ambience without inventing a project title", () => {
    const { project, media } = fakeProject(template, [{ kind: "video", length: 4.1, durationSec: 4 }]);
    const { timeline, durationSec, warnings } = planTimeline({ project, media });
    expect(durationSec).toBe(4);
    expect(timeline.clips).toHaveLength(1);
    expect(timeline.clips[0]).toMatchObject({ start: 0, in: 0, out: 4, gain: 1 });
    expect(timeline.overlays).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("micro drama", () => {
  it("cuts hard between its shots, plays their own sound, subtitles each line over its shot, and has no title card", () => {
    const { project, media } = fakeProject("micro_drama", [
      { kind: "video", length: 3.04, durationSec: 3 },
      { kind: "video", length: 3.54, durationSec: 3.5 },
      { kind: "video", length: 4.04, durationSec: 4 },
    ]);
    project.shots[1]!.line = "You knew the whole time.";
    project.shots[2]!.line = "Tonight, I take it back.";
    const { timeline, durationSec } = planTimeline({ project, media });
    // Each shot starts where the one before it ends, its usable length (a frame short of the file) in full.
    timeline.clips.forEach((c, i) => expect(c.start).toBeCloseTo(i ? timeline.clips[i - 1]!.start + timeline.clips[i - 1]!.out - timeline.clips[i - 1]!.in : 0, 3));
    expect(timeline.clips.map((c) => Math.round(c.start * 10) / 10)).toEqual([0, 3, 6.5]);
    expect(timeline.clips.every((c) => c.gain === 1)).toBe(true);
    expect(durationSec).toBeCloseTo(10.5, 1);
    expect(timeline.overlays).toEqual([]);
    expect(timeline.captions.map((c) => c.text)).toEqual(["You knew the whole time.", "Tonight, I take it back."]);
    // Each line stays inside the shot that says it.
    expect(timeline.captions[0]!.start).toBeGreaterThanOrEqual(timeline.clips[1]!.start);
    expect(timeline.captions[0]!.end).toBeLessThanOrEqual(timeline.clips[2]!.start);
    expect(timeline.captions[1]!.start).toBeGreaterThanOrEqual(timeline.clips[2]!.start);
    expect(expectWellFormed(timeline, media, durationSec)).toEqual([]);
    // Drawn by the cinematic compositor with the drama's subtitles and the shots' sound up front.
    const style = resolveStyle("micro_drama", timeline.style).style;
    expect([style.look, style.picture.letterbox, style.transition.duration, style.captions.look, style.captions.position, style.captions.pinned]).toEqual(["cinematic_shot", null, 0, "subtitle", "bottom", true]);
    expect(style.audio.clipLufs).toBeGreaterThan(defaultStyle("cinematic_shot").audio.clipLufs);
  });
});

describe("music video", () => {
  const shots = [
    { kind: "video" as const, length: 4.04, durationSec: 3 },
    { kind: "video" as const, length: 4.5, durationSec: 2.5 },
    { kind: "video" as const, length: 4.5, durationSec: 2 },
    { kind: "image" as const, durationSec: 2 },
  ];

  it("cuts on beats, prefers section changes, and ends on a bar line after the last shot", () => {
    const { project, media } = fakeProject("music_video", shots, [audioAssetOf("song", "music", 40)], { durationSec: 30 });
    const beats = beatMap(120, 40, [5, 24]);
    const { timeline, durationSec } = planTimeline({ project, media, song: { assetId: "song", beats, lyrics: [] } });
    // Four shots of 3, 2.5, 2 and 2 s: 9.5 s, each once. The song does not bring them back.
    expect(timeline.clips.map((c) => c.shotId)).toEqual(["s0", "s1", "s2", "s3"]);
    const cuts = timeline.clips.slice(1).map((c) => c.start);
    for (const cut of cuts) expect(beats.beats.some((b) => Math.abs(b - cut) < 1e-3)).toBe(true);
    // The cut at 5.5 moves to the new section at 5.
    expect(cuts).toEqual([3, 5, 7.5]);
    expect(beats.downbeats).toContain(durationSec);
    expect(durationSec).toBeCloseTo(10, 3);
    expect(timeline.clips.every((c) => c.gain === 0)).toBe(true);
    expect(timeline.audio[0]).toMatchObject({ role: "music", in: 0, out: durationSec });
    expect(timeline.markers?.some((m) => m.kind === "downbeat")).toBe(true);
    expect(expectWellFormed(timeline, media, durationSec)).toEqual([]);
  });

  // Chrome Sunset, Nov 2: ten shots the writer planned at 1.5 bars of 110 bpm (3.27 s), drafts of 3.38 s, a 30 s song.
  const chrome = Array.from({ length: 10 }, () => ({ kind: "video" as const, length: 3.38, durationSec: 3.27 }));

  it.each([
    ["heard at 120 bpm", 120],
    ["at 108 bpm, slower than the genre", 108],
    ["at 110 bpm, the genre's", 110],
  ])("plays every planned shot once, in order, for its planned length on the beat: a song %s", (_, bpm) => {
    const { project, media } = fakeProject("music_video", chrome, [audioAssetOf("song", "music", 30)], { durationSec: 30 });
    const beats = beatMap(bpm, 30);
    const { timeline, durationSec } = planTimeline({ project, media, song: { assetId: "song", beats, lyrics: [] } });
    // Before, the cut gave most shots one bar: at 120 bpm it dropped the finale, at 108 it played shots 1 and 2 again.
    expect(timeline.clips.map((c) => c.shotId)).toEqual(chrome.map((_, i) => `s${i}`));
    expect(durationSec).toBeCloseTo(30, 3);
    const period = 60 / bpm;
    const lengths = timeline.clips.map((c) => c.out - c.in);
    // 32.7 s of shots share the 30 s song: about 3 s each, a beat either way at most.
    for (const length of lengths.slice(0, -1)) expect(Math.abs(length - 3)).toBeLessThanOrEqual(period * 0.6);
    // On the beat, or a few milliseconds before it where a video ends just short of it: about a frame at most.
    for (const cut of timeline.clips.slice(1).map((c) => c.start)) expect(beats.beats.some((b) => b - cut > -1e-3 && b - cut <= 0.05 + 1e-6)).toBe(true);
    expect(timeline.audio[0]).toMatchObject({ in: 0, out: 30 });
    expect(expectWellFormed(timeline, media, durationSec)).toEqual([]);
  });

  it("reaches a beat that falls in the video's last frame, so short drafts do not pull every cut a beat early", () => {
    // The mock engine's 3.38 s drafts on its 89 bpm song: five beats are 3.37 s, just past the usable 3.33 s.
    const drafts = Array.from({ length: 10 }, () => ({ kind: "video" as const, length: 3.38, durationSec: 3.27 }));
    const { project, media } = fakeProject("music_video", drafts, [audioAssetOf("song", "music", 30)], { durationSec: 30 });
    const { timeline, durationSec } = planTimeline({ project, media, song: { assetId: "song", beats: beatMap(89, 30), lyrics: [] } });
    expect(timeline.clips).toHaveLength(10);
    expect(durationSec).toBeGreaterThan(29);
  });

  it("keeps a clip's length the user set, longer or shorter, and the other shots make room", () => {
    const { project, media } = fakeProject("music_video", chrome, [audioAssetOf("song", "music", 30)], { durationSec: 30 });
    project.shots[2]!.cutSec = 3.3;
    project.shots[5]!.cutSec = 1.6;
    const { timeline, durationSec } = planTimeline({ project, media, song: { assetId: "song", beats: beatMap(108, 30), lyrics: [] } });
    expect(timeline.clips.map((c) => c.shotId)).toEqual(chrome.map((_, i) => `s${i}`));
    const length = (shotId: string) => timeline.clips.filter((c) => c.shotId === shotId).map((c) => round3(c.out - c.in));
    expect(length("s2")).toEqual([3.3]);
    expect(length("s5")).toEqual([1.6]);
    expect(durationSec).toBeCloseTo(30, 3);
    expect(expectWellFormed(timeline, media, durationSec)).toEqual([]);
  });

  it("plays shots added by hand too: all of them once, a bar each at least, in the song's length", () => {
    const thirteen = [...chrome, ...Array.from({ length: 3 }, () => ({ kind: "image" as const, durationSec: 3.27 }))];
    const { project, media } = fakeProject("music_video", thirteen, [audioAssetOf("song", "music", 30)], { durationSec: 30 });
    const { timeline, durationSec } = planTimeline({ project, media, song: { assetId: "song", beats: beatMap(108, 30), lyrics: [] } });
    expect(timeline.clips.map((c) => c.shotId)).toEqual(thirteen.map((_, i) => `s${i}`));
    expect(durationSec).toBeCloseTo(30, 3);
    const bar = (4 * 60) / 108;
    for (const c of timeline.clips) expect(c.out - c.in).toBeGreaterThan(bar - 60 / 108 / 2);
    expect(expectWellFormed(timeline, media, durationSec)).toEqual([]);
  });

  it("takes more of the song before it plays shots shorter than a bar", () => {
    const many = Array.from({ length: 12 }, () => ({ kind: "image" as const, durationSec: 4 }));
    const { project, media } = fakeProject("music_video", many, [audioAssetOf("song", "music", 40)], { durationSec: 20 });
    const { timeline, durationSec } = planTimeline({ project, media, song: { assetId: "song", beats: beatMap(120, 40), lyrics: [] } });
    // 48 s of shots, 20 s asked for: at a bar (2 s) each they need 24 s of the song.
    expect(timeline.clips).toHaveLength(12);
    expect(durationSec).toBeCloseTo(24, 1);
    expect(expectWellFormed(timeline, media, durationSec)).toEqual([]);
  });

  it("never drops a shot: more than the song holds play on past its end, and say so", () => {
    const many = Array.from({ length: 20 }, () => ({ kind: "image" as const, durationSec: 3 }));
    const { project, media } = fakeProject("music_video", many, [audioAssetOf("song", "music", 10)]);
    const { timeline, durationSec, warnings } = planTimeline({ project, media, song: { assetId: "song", beats: beatMap(120, 10), lyrics: [] } });
    expect(timeline.clips).toHaveLength(20);
    expect(durationSec).toBeGreaterThan(10);
    expect(warnings.join(" ")).toMatch(/past the song's end/);
    expect(timeline.audio[0]).toMatchObject({ in: 0, out: 10 });
    expect(expectWellFormed(timeline, media, durationSec)).toEqual([]);
  });

  it("starts the cut inside the song and shifts lyrics and beats with it", () => {
    const { project, media } = fakeProject("music_video", shots, [audioAssetOf("song", "music", 40)], { songStartSec: 10, durationSec: 12 });
    const lyrics = [{ text: "neon", start: 12, end: 12.5 }, { text: "rain", start: 12.5, end: 13 }];
    const { timeline } = planTimeline({ project, media, song: { assetId: "song", beats: beatMap(120, 40), lyrics } });
    expect(timeline.audio[0]).toMatchObject({ in: 10 });
    expect(timeline.captions[0]!.start).toBeCloseTo(2, 3);
    expect(timeline.markers!.every((m) => m.t < 12.5)).toBe(true);
  });

  it("falls back to shot lengths without a steady beat", () => {
    const { project, media } = fakeProject("music_video", shots, [audioAssetOf("song", "music", 12)]);
    const { timeline, warnings, durationSec } = planTimeline({ project, media, song: { assetId: "song", beats: null, lyrics: [] } });
    expect(warnings.join(" ")).toMatch(/no steady beat/);
    expect(expectWellFormed(timeline, media, durationSec)).toEqual([]);
  });
});

describe("product ad", () => {
  // The Lumi ad of the Nov 1 dogfood night: five 4 s drafts in story order (a lamp in a dark bedroom, a sleeper in
  // sunrise light, an alarm clock in the bin, a stretch, the lamp on peach) and an 11.4 s voiceover in seven sentences.
  const lumiScript = "Breaking up with your alarm clock? Same. Lumi wakes you with a slow sunrise, right on your nightstand. No screaming. No snooze rage. Just light, and a better morning. Lumi sunrise lamp.";
  // As whisper aligned it, in the voice file's own time.
  const lumiWords = ([
    ["Breaking", 0, 0.45], ["up", 0.45, 0.49], ["with", 0.56, 0.78], ["your", 0.78, 1], ["alarm", 1, 1.28], ["clock?", 1.28, 1.72],
    ["Same.", 1.72, 2.13], ["Lumi", 2.55, 2.63], ["wakes", 2.63, 2.7], ["you", 2.7, 2.89], ["with", 2.89, 3.13], ["a", 3.18, 3.22],
    ["slow", 3.22, 3.45], ["sunrise,", 3.45, 4], ["right", 4.01, 4.32], ["on", 4.32, 4.44], ["your", 4.44, 4.69], ["nightstand.", 4.69, 5.55],
    ["No", 5.74, 5.78], ["screaming.", 5.78, 6.53], ["No", 6.71, 6.76], ["snooze", 6.76, 7.14], ["rage.", 7.14, 7.63], ["Just", 7.81, 7.91],
    ["light,", 7.91, 8.36], ["and", 8.55, 8.62], ["a", 8.62, 8.69], ["better", 8.78, 9.12], ["morning.", 9.12, 9.83], ["Lumi", 9.83, 10.11],
    ["sunrise", 10.11, 10.61], ["lamp.", 10.61, 11.16],
  ] as const).map(([text, start, end]) => ({ text, start, end }));
  const draft = { kind: "video" as const, length: 4.04, durationSec: 4 };
  const lumi = () => fakeProject("product_ad", [draft, draft, draft, draft, draft], [audioAssetOf("voice", "voice", 11.36, lumiScript), audioAssetOf("music", "music", 15)], { productName: "Lumi sunrise lamp" });
  /** How long each clip is seen: the last one until the end card comes in over it. */
  const seen = (timeline: { clips: { start: number; in: number; out: number }[]; overlays?: { kind: string; start: number }[] }) => {
    const card = timeline.overlays?.find((o) => o.kind === "end_card");
    return timeline.clips.map((c, i) => (i === timeline.clips.length - 1 && card ? card.start - c.start : c.out - c.in));
  };
  /** True when `t` falls inside a word the voice says (the voice starts 0.3 s into the ad). */
  const insideWord = (words: { start: number; end: number }[], t: number) => words.some((w) => t > w.start + 0.3 + 1e-6 && t < w.end + 0.3 - 1e-6);

  it("plays each shot once in story order, cuts before sentences, and ends on the end card", () => {
    const { project, media } = lumi();
    const { timeline, durationSec } = planTimeline({ project, media, voice: { assetId: "voice", words: lumiWords }, song: { assetId: "music", beats: null, lyrics: [] } });
    expect(timeline.clips.map((c) => c.shotId)).toEqual(["s0", "s1", "s2", "s3", "s4"]);
    // Before "Lumi wakes", "No screaming.", "Just light," and "Lumi sunrise lamp.": the dogfood cut had nine clips
    // of 0.86 to 3.5 s, the shots twice over, and the peach end-card shot at 6.3 s.
    expect(timeline.clips.slice(1).map((c) => c.start)).toEqual([2.77, 5.96, 8.03, 10.13]);
    for (const t of seen(timeline)) expect(t).toBeGreaterThanOrEqual(AD_MIN_SHOT);
    // The card comes in after the last word and holds to the promised 15 s, over the last shot, which says the name.
    const card = timeline.overlays!.find((o) => o.kind === "end_card")!;
    expect(card).toMatchObject({ start: round3(0.3 + 11.16 + 0.35), end: 15, text: "Lumi sunrise lamp" });
    expect(durationSec).toBe(15);
    const last = timeline.clips.at(-1)!;
    expect(last.start + last.out - last.in).toBeCloseTo(15, 3);
    // One take of the voice, the captions on its words, and the music under the whole ad.
    expect(timeline.audio.filter((a) => a.role === "voice")).toEqual([{ assetId: "voice", role: "voice", start: 0.3, gain: 1 }]);
    expect(timeline.captions.flatMap((c) => c.words ?? []).map((w) => w.start)).toEqual(lumiWords.map((w) => round3(w.start + 0.3)));
    expect(timeline.captions.every((c) => c.text.length <= 26 * 1.25)).toBe(true);
    expect(timeline.audio.find((a) => a.role === "music")!.out).toBeCloseTo(durationSec, 3);
    expect(timeline.clips.every((c) => c.gain === 0)).toBe(true);
    expect(expectWellFormed(timeline, media, durationSec)).toEqual([]);
  });

  it("gives every shot its own stretch when there are more shots than sentences, cutting between words", () => {
    const script = "Meet Lumen, the desk lamp that follows the sun from dawn to dusk. One touch, and your whole room glows warm.";
    const { project, media } = fakeProject("product_ad", Array.from({ length: 6 }, () => draft), [audioAssetOf("voice", "voice", 12, script)], { productName: "Lumen" });
    const words = estimateWords(script, { start: 0.1, end: 11.8 });
    const { timeline, durationSec } = planTimeline({ project, media, voice: { assetId: "voice", words } });
    expect(timeline.clips.map((c) => c.shotId)).toEqual(["s0", "s1", "s2", "s3", "s4", "s5"]);
    for (const t of seen(timeline)) expect(t).toBeGreaterThanOrEqual(AD_MIN_SHOT);
    for (const c of timeline.clips.slice(1)) expect(insideWord(words, c.start)).toBe(false);
    // The second sentence opens on a shot of its own.
    const second = words.findIndex((w) => w.text === "One");
    expect(timeline.clips.some((c) => Math.abs(c.start - (words[second]!.start + 0.3 - 0.08)) < 1e-3)).toBe(true);
    expect(expectWellFormed(timeline, media, durationSec)).toEqual([]);
  });

  it("never plays a shot for less than the minimum: more shots than the voice has room for make a longer ad", () => {
    const script = "Lumen. Light that keeps time.";
    const stills = Array.from({ length: 10 }, () => ({ kind: "image" as const, durationSec: 3 }));
    const { project, media } = fakeProject("product_ad", stills, [audioAssetOf("voice", "voice", 2.5, script)], { productName: "Lumen" });
    const { timeline, durationSec } = planTimeline({ project, media, voice: { assetId: "voice", words: estimateWords(script, { start: 0.1, end: 2.2 }) } });
    expect(timeline.clips.map((c) => c.shotId)).toEqual(stills.map((_, i) => `s${i}`));
    for (const t of seen(timeline)) expect(t).toBeGreaterThanOrEqual(AD_MIN_SHOT - 1e-9);
    const card = timeline.overlays!.find((o) => o.kind === "end_card")!;
    expect(card.start).toBeCloseTo(10 * AD_MIN_SHOT, 3);
    expect(durationSec).toBeCloseTo(10 * AD_MIN_SHOT + 2.6, 3);
    expect(expectWellFormed(timeline, media, durationSec)).toEqual([]);
  });

  it("plays the shots at their own lengths before there is a voice or a script", () => {
    const shots = [2, 3, 4].map((durationSec) => ({ kind: "image" as const, durationSec }));
    const { project, media } = fakeProject("product_ad", shots, [], { productName: "Lumen" });
    const { timeline, durationSec, warnings } = planTimeline({ project, media });
    expect(warnings).toEqual([]);
    expect(timeline.clips.map((c) => c.start)).toEqual([0, 2, 5]);
    expect(timeline.overlays!.find((o) => o.kind === "end_card")).toMatchObject({ start: 9, end: 11.6 });
    expect(timeline.captions).toEqual([]);
    expect(durationSec).toBeCloseTo(11.6, 3);
  });

  it("gives a shot the length the user set, to the nearest breath, and the others share the rest", () => {
    const { project, media } = lumi();
    project.shots[1]!.cutSec = 4;
    const { timeline, durationSec } = planTimeline({ project, media, voice: { assetId: "voice", words: lumiWords } });
    expect(timeline.clips.map((c) => c.shotId)).toEqual(["s0", "s1", "s2", "s3", "s4"]);
    const second = timeline.clips[1]!;
    // A 4.04 s draft plays at most its usable 3.99 s.
    expect(second.out - second.in).toBeGreaterThan(3.6);
    expect(second.out - second.in).toBeLessThanOrEqual(3.99);
    for (const t of seen(timeline)) expect(t).toBeGreaterThanOrEqual(AD_MIN_SHOT);
    for (const c of timeline.clips.slice(1)) expect(insideWord(lumiWords, c.start)).toBe(false);
    expect(expectWellFormed(timeline, media, durationSec)).toEqual([]);
  });

  it("plays the shots a second time only when their videos are too short for the voice, the last shot still last", () => {
    const script = Array.from({ length: 4 }, (_, i) => `Sentence ${i + 1} says a little more about the lamp.`).join(" ");
    const short = { kind: "video" as const, length: 2.04, durationSec: 2 };
    const { project, media } = fakeProject("product_ad", [short, short, short], [audioAssetOf("voice", "voice", 10, script)], { productName: "Lumen" });
    const { timeline, durationSec, warnings } = planTimeline({ project, media, voice: { assetId: "voice", words: estimateWords(script, { start: 0.1, end: 9.8 }) } });
    expect(warnings.join(" ")).toMatch(/play twice/);
    const order = timeline.clips.map((c) => c.shotId);
    expect(order.at(-1)).toBe("s2");
    expect(order.filter((id) => id === "s2")).toHaveLength(1);
    // Story order, again from the top: s0, s1, s0, s1, ... then the last shot.
    order.slice(0, -1).forEach((id, i) => expect(id).toBe(`s${i % 2}`));
    expect(expectWellFormed(timeline, media, durationSec)).toEqual([]);
  });

  it("keeps the end card where the voice puts it when every clip is shorter than a shot's shortest, so repeats only fill the picture", () => {
    // Two 1 s drafts under a 7 s voice once made a 3-minute ad: each repeat pushed the card back by as much as it added.
    const script = "Breaking up with your alarm clock? Same. Lumi wakes you with a slow sunrise. Just light.";
    const tiny = { kind: "video" as const, length: 0.99, durationSec: 1 };
    const { project, media } = fakeProject("product_ad", [tiny, tiny], [audioAssetOf("voice", "voice", 7, script)], { productName: "Lumi" });
    const { timeline, durationSec, warnings } = planTimeline({ project, media, voice: { assetId: "voice", words: estimateWords(script, { start: 0.1, end: 6.9 }) } });
    expect(warnings.join(" ")).toMatch(/play twice/);
    const card = timeline.overlays!.find((o) => o.kind === "end_card")!;
    expect(card.start).toBeCloseTo(0.3 + 6.9 + 0.35, 3);
    expect(durationSec).toBeLessThanOrEqual(15.01);
    expect(timeline.clips.length).toBeLessThan(12);
    expect(timeline.clips.at(-1)!.shotId).toBe("s1");
  });

  it("plays a short voiceover in one take, the end card holding longer", () => {
    const short = "Lumen. It follows the sun across your desk. No setup. No fuss. Lumen. Done.";
    const { project, media } = fakeProject("product_ad", [{ kind: "video", length: 3, durationSec: 3 }, { kind: "video", length: 4, durationSec: 3 }], [audioAssetOf("voice", "voice", 5.5, short)], { productName: "Lumen" });
    const words = estimateWords(short, { start: 0.05, end: 5.2 });
    const { timeline, durationSec } = planTimeline({ project, media, voice: { assetId: "voice", words } });
    expect(timeline.audio).toEqual([{ assetId: "voice", role: "voice", start: 0.3, gain: 1 }]);
    const card = timeline.overlays!.find((o) => o.kind === "end_card")!;
    expect(card.start).toBeCloseTo(0.3 + 5.2 + 0.35, 3);
    expect(card.end - card.start).toBeCloseTo(6, 3);
    expect(durationSec).toBeCloseTo(5.85 + 6, 3);
    expect(timeline.captions.flatMap((c) => c.words ?? []).map((w) => w.start)).toEqual(words.map((w) => round3(w.start + 0.3)));
    expect(expectWellFormed(timeline, media, durationSec)).toEqual([]);
  });

  it("leaves a voiceover longer than the promise as it is, and takes another length from the brief", () => {
    const long = Array.from({ length: 8 }, (_, i) => `Sentence number ${i + 1} says a little more about the lamp and how it works.`).join(" ");
    const shots = [{ kind: "video" as const, length: 4, durationSec: 3 }, { kind: "image" as const, durationSec: 3 }];
    const a = fakeProject("product_ad", shots, [audioAssetOf("voice", "voice", 30, long)], { productName: "Lumen" });
    const words = estimateWords(long, { start: 0.1, end: 29.5 });
    const plan = planTimeline({ project: a.project, media: a.media, voice: { assetId: "voice", words } });
    expect(plan.timeline.audio).toEqual([{ assetId: "voice", role: "voice", start: 0.3, gain: 1 }]);
    expect(plan.durationSec).toBeCloseTo(0.3 + 29.5 + 0.35 + 2.6, 3);

    const short = "Lumen. Done.";
    const b = fakeProject("product_ad", shots, [audioAssetOf("voice", "voice", 1.5, short)], { productName: "Lumen", durationSec: 6 });
    const brief = planTimeline({ project: b.project, media: b.media, voice: { assetId: "voice", words: estimateWords(short, { start: 0, end: 1.4 }) } });
    expect(brief.durationSec).toBeCloseTo(6, 3);
  });

  it("estimates timing from the script before the voice exists", () => {
    const script = "Meet Lumen, the desk lamp that follows the sun. It warms up at dusk. One touch, and your room glows. Order yours today.";
    const { project, media } = fakeProject("product_ad", [{ kind: "image", durationSec: 3 }], [], { script, productName: "Lumen" });
    const { timeline, warnings } = planTimeline({ project, media });
    expect(warnings.join(" ")).toMatch(/estimated/);
    expect(timeline.captions.length).toBeGreaterThan(0);
  });
});

describe("talking intro", () => {
  const script = "Hi, I'm Ava, and I make films at night.\nEvery shot starts as a quick sketch.\nWhen I sleep, my computer finishes them.";

  it("gives each script line its own visual, with a lower third and dissolves", () => {
    const { project, media } = fakeProject(
      "talking_intro",
      [{ kind: "video", length: 4, durationSec: 4 }, { kind: "video", length: 4, durationSec: 4 }, { kind: "video", length: 4, durationSec: 4 }],
      [audioAssetOf("voice", "voice", 9, script)],
      { speakerName: "Ava Chen", speakerTitle: "Filmmaker" },
    );
    const words = estimateWords(script, { start: 0.2, end: 8.8 });
    const { timeline, durationSec } = planTimeline({ project, media, voice: { assetId: "voice", words } });
    // Line k opens with shot k.
    const lineFirstWords = [0, 9, 16].map((i) => words[i]!.start + 0.4);
    lineFirstWords.forEach((t, k) => {
      const onScreen = timeline.clips.filter((c) => c.start <= t + 0.05 && t + 0.05 < c.start + c.out - c.in);
      expect(onScreen.map((c) => c.shotId)).toContain(`s${k}`);
    });
    expect(timeline.overlays!.find((o) => o.kind === "lower_third")).toMatchObject({ text: "Ava Chen", subtext: "Filmmaker" });
    // Dissolves: consecutive clips overlap.
    const overlaps = timeline.clips.slice(1).filter((c, i) => c.start < timeline.clips[i]!.start + timeline.clips[i]!.out - timeline.clips[i]!.in - 0.01);
    expect(overlaps.length).toBeGreaterThan(0);
    expect(expectWellFormed(timeline, media, durationSec)).toEqual([]);
  });

  it("splits a line longer than its shot at a word gap", () => {
    const long = "This one line goes on and on for quite a while, much longer than any single shot can cover on its own.";
    const { project, media } = fakeProject("talking_intro", [{ kind: "video", length: 3, durationSec: 3 }, { kind: "video", length: 3, durationSec: 3 }], [audioAssetOf("voice", "voice", 8, long)]);
    const words = estimateWords(long, { start: 0, end: 7.5 });
    const { timeline, durationSec } = planTimeline({ project, media, voice: { assetId: "voice", words } });
    expect(timeline.clips.length).toBeGreaterThanOrEqual(3);
    expect(expectWellFormed(timeline, media, durationSec)).toEqual([]);
  });
});
