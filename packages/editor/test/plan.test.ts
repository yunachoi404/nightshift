import { describe, expect, it } from "vitest";
import type { BeatMap } from "../src/audio/beats.js";
import { estimateWords } from "../src/captions/group.js";
import { cinematicTitleLength, planTimeline, timelineDuration } from "../src/timeline/plan.js";
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

describe("music video", () => {
  const shots = [
    { kind: "video" as const, length: 4.04, durationSec: 3 },
    { kind: "video" as const, length: 4.5, durationSec: 2.5 },
    { kind: "video" as const, length: 4.5, durationSec: 2 },
    { kind: "image" as const, durationSec: 2 },
  ];

  it("cuts on beats, prefers downbeats and section changes, and ends on a bar line", () => {
    const { project, media } = fakeProject("music_video", shots, [audioAssetOf("song", "music", 40)], { durationSec: 30 });
    const beats = beatMap(120, 40, [8, 24]);
    const { timeline, durationSec } = planTimeline({ project, media, song: { assetId: "song", beats, lyrics: [] } });
    expect(durationSec).toBe(30);
    const cuts = timeline.clips.slice(1).map((c) => c.start);
    for (const cut of cuts) expect(beats.beats.some((b) => Math.abs(b - cut) < 1e-3)).toBe(true);
    const onDownbeat = cuts.filter((c) => beats.downbeats.some((d) => Math.abs(d - c) < 1e-3)).length;
    expect(onDownbeat / cuts.length).toBeGreaterThan(0.5);
    expect(cuts).toContain(8);
    expect(cuts).toContain(24);
    expect(timeline.clips.every((c) => c.gain === 0)).toBe(true);
    expect(timeline.audio[0]).toMatchObject({ role: "music", in: 0, out: 30 });
    expect(timeline.markers?.some((m) => m.kind === "downbeat")).toBe(true);
    expect(expectWellFormed(timeline, media, durationSec)).toEqual([]);
  });

  it("reuses shots with new in-points when the song outlasts them", () => {
    const { project, media } = fakeProject("music_video", shots.slice(0, 2), [audioAssetOf("song", "music", 40)]);
    const { timeline, durationSec } = planTimeline({ project, media, song: { assetId: "song", beats: beatMap(120, 40), lyrics: [] } });
    expect(durationSec).toBe(40);
    const firstShotUses = timeline.clips.filter((c) => c.assetId === "a0");
    expect(firstShotUses.length).toBeGreaterThan(3);
    expect(new Set(firstShotUses.map((c) => c.in)).size).toBeGreaterThan(1);
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
  const script = "Meet Lumen, the desk lamp that follows the sun. It warms up at dusk. One touch, and your room glows. Order yours today.";

  it("cuts on sentences, captions the voice, and ends on a call to action", () => {
    const { project, media } = fakeProject(
      "product_ad",
      [{ kind: "video", length: 3, durationSec: 3 }, { kind: "video", length: 4, durationSec: 3 }, { kind: "image", durationSec: 3 }],
      [audioAssetOf("voice", "voice", 9, script), audioAssetOf("music", "music", 60)],
      { productName: "Lumen", cta: "Order yours today" },
    );
    const words = estimateWords(script, { start: 0.1, end: 8.6 });
    const { timeline, durationSec } = planTimeline({ project, media, voice: { assetId: "voice", words }, song: { assetId: "music", beats: null, lyrics: [] } });
    // Where a word of the file is heard: its sentence's trim of the voice places it.
    const voiceTracks = timeline.audio.filter((a) => a.role === "voice");
    const heard = (w: (typeof words)[number]) => {
      const t = voiceTracks.findLast((a) => (a.in ?? 0) <= w.start)!;
      return t.start + w.start - (t.in ?? 0);
    };
    const sentenceStarts = [words[9]!, words[14]!, words[20]!].map((w) => heard(w) - 0.08);
    const cuts = timeline.clips.slice(1).map((c) => c.start);
    for (const s of sentenceStarts) expect(cuts.some((c) => Math.abs(c - s) < 1e-3)).toBe(true);
    const endCard = timeline.overlays!.find((o) => o.kind === "end_card")!;
    expect(endCard).toMatchObject({ text: "Lumen", cta: "Order yours today" });
    expect(endCard.end).toBeCloseTo(durationSec, 3);
    expect(endCard.start).toBeGreaterThan(heard(words.at(-1)!));
    expect(timeline.captions.length).toBeGreaterThan(3);
    expect(timeline.captions.every((c) => c.text.length <= 26 * 1.25)).toBe(true);
    expect(timeline.audio.find((a) => a.role === "music")!.out).toBeCloseTo(durationSec, 3);
    expect(durationSec).toBeCloseTo(15, 3);
    // No shot plays twice in a row.
    expect(timeline.clips.slice(1).every((c, i) => c.assetId !== timeline.clips[i]!.assetId)).toBe(true);
    expect(expectWellFormed(timeline, media, durationSec)).toEqual([]);
  });

  it("paces a short voiceover to the promised 15 s: a breath between sentences, then a longer end card", () => {
    const short = "Lumen. It follows the sun across your desk. No setup. No fuss. Lumen. Done.";
    const { project, media } = fakeProject("product_ad", [{ kind: "video", length: 3, durationSec: 3 }, { kind: "video", length: 4, durationSec: 3 }], [audioAssetOf("voice", "voice", 5.5, short)], { productName: "Lumen" });
    const words = estimateWords(short, { start: 0.05, end: 5.2 });
    const { timeline, durationSec } = planTimeline({ project, media, voice: { assetId: "voice", words } });
    expect(durationSec).toBeCloseTo(15, 3);
    // Six sentences, six trims of the one voice file, played in order, back to back in the file and apart in time.
    const tracks = timeline.audio.filter((a) => a.role === "voice");
    expect(tracks).toHaveLength(6);
    expect(tracks.every((t) => t.assetId === "voice")).toBe(true);
    for (let k = 1; k < tracks.length; k++) {
      expect(tracks[k]!.in).toBeCloseTo(tracks[k - 1]!.out!, 3);
      const gap = tracks[k]!.start - (tracks[k - 1]!.start + tracks[k - 1]!.out! - (tracks[k - 1]!.in ?? 0));
      expect(gap).toBeCloseTo(0.8, 3);
    }
    expect(tracks.at(-1)!.out).toBeUndefined();
    // Every caption word is heard at the time it is shown.
    const shown = timeline.captions.flatMap((c) => c.words ?? []);
    expect(shown).toHaveLength(words.length);
    shown.forEach((w, i) => {
      const t = tracks.findLast((a) => (a.in ?? 0) <= words[i]!.start)!;
      expect(w.start).toBeCloseTo(t.start + words[i]!.start - (t.in ?? 0), 2);
    });
    const endCard = timeline.overlays!.find((o) => o.kind === "end_card")!;
    expect(endCard.end - endCard.start).toBeGreaterThan(2.6);
    expect(endCard.end - endCard.start).toBeLessThanOrEqual(6);
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
