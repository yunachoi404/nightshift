/**
 * The reveal clip: which draft and final it pairs (and what it may call them), its frame-exact timing, and the
 * composition it writes. A render through HyperFrames runs at the end when Chrome and ffmpeg are here.
 */
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Asset, Project, Take } from "@nightshift/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "../src/media/process.js";
import { resolveTools } from "../src/media/tools.js";
import { buildRevealComposition, cropWindow, fitHeadline, layoutTagSlots, revealLayout, tagTextWidth, type RevealScene } from "../src/reveal/composition.js";
import { countFrames, exportReveal } from "../src/reveal/export.js";
import { canRevealSameTake, RevealError, revealOpening, revealPair, revealShot } from "../src/reveal/pair.js";
import { frameAt, planReveal } from "../src/reveal/plan.js";

const NOW = "2026-10-28T00:00:00.000Z";

function project(o: { finalKind?: Take["finalKind"]; parent?: string; shots?: number; still?: boolean; photo?: boolean } = {}): Project {
  const assets: Asset[] = [
    { id: "still", kind: "image", path: "still.png", createdAt: NOW },
    { id: "photo", kind: "image", path: "photo.jpg", role: "reference", createdAt: NOW },
    { id: "dv", kind: "video", path: "draft.mp4", width: 640, height: 384, durationSec: 4.04, createdAt: NOW },
    { id: "fv", kind: "video", path: "final.mp4", width: 1280, height: 768, durationSec: 4.04, createdAt: NOW },
    { id: "ov", kind: "video", path: "other.mp4", width: 640, height: 384, durationSec: 4.04, createdAt: NOW },
  ];
  const takes: Take[] = [
    { id: "d1", shotId: "s1", rung: "draft", seed: 1, videoAssetId: "dv", jobId: "j1", imageAssetId: "still" },
    { id: "d2", shotId: "s1", rung: "draft", seed: 2, videoAssetId: "ov", jobId: "j2" },
    { id: "f1", shotId: "s1", rung: "final", seed: 1, videoAssetId: "fv", jobId: "j3", ...(o.finalKind === undefined && !("finalKind" in o) ? { finalKind: "same_take" } : o.finalKind ? { finalKind: o.finalKind } : {}), ...(o.parent === undefined ? { parentTakeId: "d1" } : o.parent ? { parentTakeId: o.parent } : {}) },
  ];
  const shots = Array.from({ length: o.shots ?? 1 }, (_, i) => ({
    id: `s${i + 1}`,
    index: i,
    prompt: "A ferry leaves the pier",
    durationSec: 4,
    locked: false,
    ...(i === 0 ? { chosenDraftId: "d2", chosenFinalId: "f1", ...(o.still === false ? {} : { stillAssetId: "still" }) } : {}),
  }));
  return { id: "p", name: "Ferry", template: "cinematic_shot", aspect: "16:9", brief: o.photo ? { photoAssetId: "photo" } : {}, shots, takes, assets, timeline: null, createdAt: NOW, updatedAt: NOW };
}

describe("pairing", () => {
  it("pairs the final with the draft it was made from, not the draft the shot picked since", () => {
    const pair = revealPair(project());
    expect(pair.final.id).toBe("f1");
    expect(pair.draft.id).toBe("d1");
    expect(pair.draftAsset.id).toBe("dv");
    expect(pair.finalAsset.id).toBe("fv");
    expect(pair.kind).toBe("same_take");
    expect(pair.shotLabel).toBe("Shot 1");
  });
  it("opens on the shot's still, else the draft's start image, else the project's photo", () => {
    expect(revealPair(project()).source?.id).toBe("still");
    const noStill = project({ still: false });
    expect(revealPair(noStill).source?.id).toBe("still"); // the draft's own start image
    noStill.takes[0]!.imageAssetId = undefined;
    expect(revealPair(noStill).source).toBeUndefined();
    const photo = project({ still: false, photo: true });
    photo.takes[0]!.imageAssetId = undefined;
    expect(revealPair(photo).source?.id).toBe("photo");
  });
  it("opens on the truth about the first picture: a photo, a question, or a still", () => {
    // A storyboard still the app drew is a still, not the user's photo.
    expect(revealPair(project()).sourceKind).toBe("still");
    expect(revealPair(project()).opening).toBe("One still.");
    // A photo the user uploaded (the brief's photo, or any reference asset) is a photo.
    const photo = project({ still: false, photo: true });
    photo.takes[0]!.imageAssetId = undefined;
    expect(revealPair(photo).sourceKind).toBe("photo");
    expect(revealPair(photo).opening).toBe("One photo.");
    const uploadedStill = project();
    uploadedStill.brief = { photoAssetId: "still" };
    expect(revealPair(uploadedStill).opening).toBe("One photo.");
    // A What-if from a typed question opens on the question itself; a long one on "One question."
    const whatIf = project();
    whatIf.template = "what_if";
    whatIf.brief = { question: "What if you fell into Jupiter" };
    expect(revealPair(whatIf).sourceKind).toBe("question");
    expect(revealPair(whatIf).opening).toBe("What if you fell into Jupiter?");
    whatIf.brief = { question: "What if every lamp post in the city turned into a tree overnight?" };
    expect(revealPair(whatIf).opening).toBe("One question.");
    // A What-if from the user's own photo is still a photo.
    const whatIfPhoto = project();
    whatIfPhoto.template = "what_if";
    whatIfPhoto.brief = { question: "What if gravity stopped?", photoAssetId: "still" };
    expect(revealPair(whatIfPhoto).opening).toBe("One photo.");
    // No picture at all: the shot's name.
    const bare = project({ still: false });
    bare.takes[0]!.imageAssetId = undefined;
    expect(revealPair(bare).source).toBeUndefined();
    expect(revealPair(bare).sourceKind).toBeUndefined();
    expect(revealPair(bare).opening).toBe("Shot 1.");
    expect(revealOpening({ template: "cinematic_shot", brief: {} }, undefined, "Shot 3")).toEqual({ opening: "Shot 3." });
  });
  it("calls a remaster a remaster, never same take", () => {
    const pair = revealPair(project({ finalKind: "remaster" }));
    expect(pair.kind).toBe("remaster");
    expect(canRevealSameTake(project({ finalKind: "remaster" }), project().shots[0]!)).toBe(false);
    expect(canRevealSameTake(project(), project().shots[0]!)).toBe(true);
  });
  it("refuses a final of unknown kind, one without its draft, and one made from another shot's draft", () => {
    expect(() => revealPair(project({ finalKind: null as unknown as undefined }))).toThrow(RevealError);
    expect(() => revealPair(project({ parent: "" }))).toThrow(/does not point at the draft/);
    expect(() => revealPair(project({ parent: "missing" }))).toThrow(/does not point at the draft/);
    const foreign = project();
    foreign.takes[0]!.shotId = "s9";
    expect(() => revealPair(foreign)).toThrow(/another shot/);
  });
  it("picks the only shot by default and asks for one otherwise", () => {
    expect(revealShot(project()).id).toBe("s1");
    expect(() => revealShot(project({ shots: 2 }))).toThrow(/which shot/);
    expect(revealShot(project({ shots: 2 }), "s2").id).toBe("s2");
    expect(() => revealShot(project({ shots: 2 }), "s7")).toThrow(/No shot s7/);
    expect(() => revealPair(project({ shots: 2 }), "s2")).toThrow(/no final yet/);
  });
});

describe("timing", () => {
  const plan = planReveal({ fps: 24, draftFrames: 97, finalFrames: 97, hasSource: true, kind: "same_take" });
  it("lands every beat on the frame grid, in order, with no gaps", () => {
    const spans = [plan.source!, plan.draft, plan.freeze, plan.wipe, plan.hold, plan.detail!, plan.resume, plan.endCard];
    let cursor = 0;
    for (const s of spans) {
      expect(s.start).toBeCloseTo(cursor, 9);
      expect(Math.abs(s.start * 24 - Math.round(s.start * 24))).toBeLessThan(1e-9);
      expect(Math.abs(s.end * 24 - Math.round(s.end * 24))).toBeLessThan(1e-9);
      expect(s.end).toBeGreaterThan(s.start);
      cursor = s.end;
    }
    expect(plan.duration).toBeCloseTo(cursor, 9);
    expect(frameAt(plan, plan.duration)).toBe(262);
  });
  it("freezes the draft on frame F and resumes the final at the same frame", () => {
    expect(plan.freezeFrame).toBe(41);
    // The draft plays frames 0..F-1, so the frame after its last is F, the frozen one.
    expect(frameAt(plan, plan.draft.end) - frameAt(plan, plan.draft.start)).toBe(plan.freezeFrame);
    // The final plays F..N-1 from the resume.
    expect(frameAt(plan, plan.resume.end) - frameAt(plan, plan.resume.start)).toBe(97 - plan.freezeFrame);
    expect(plan.fadeOut).toBeCloseTo(8 / 24, 9);
  });
  it("runs 8 to 12 seconds for every clip length a recipe makes, short takes whole and long ones in a window", () => {
    for (const frames of [49, 65, 97, 121, 241, 361, 721]) {
      for (const hasSource of [true, false]) {
        for (const kind of ["same_take", "remaster"] as const) {
          const p = planReveal({ fps: 24, draftFrames: frames, finalFrames: frames, hasSource, kind });
          expect(p.duration, `${frames} frames`).toBeGreaterThanOrEqual(7.5);
          expect(p.duration, `${frames} frames`).toBeLessThanOrEqual(12);
          expect(p.freezeFrame).toBeGreaterThanOrEqual(8);
          expect(p.freezeFrame).toBeLessThanOrEqual(frames - 2);
          // The window always ends on the freeze and starts again from it, so the pairing stays exact.
          expect(p.draftFrom).toBeGreaterThanOrEqual(0);
          expect(p.draftFrom).toBeLessThan(p.freezeFrame);
          expect(frameAt(p, p.draft.end) - frameAt(p, p.draft.start)).toBe(p.freezeFrame - p.draftFrom);
          expect(p.resumeTo).toBeGreaterThan(p.freezeFrame);
          expect(p.resumeTo).toBeLessThanOrEqual(frames);
          expect(frameAt(p, p.resume.end) - frameAt(p, p.resume.start)).toBe(p.resumeTo - p.freezeFrame);
        }
      }
    }
    // A four-second take plays whole; a 15-second What-if film plays about 1.7 s before the freeze and 2.4 s after.
    const whole = planReveal({ fps: 24, draftFrames: 97, finalFrames: 97, hasSource: true, kind: "same_take" });
    expect(whole.draftFrom).toBe(0);
    expect(whole.resumeTo).toBe(97);
    const film = planReveal({ fps: 24, draftFrames: 361, finalFrames: 361, hasSource: true, kind: "same_take" });
    expect(film.freezeFrame).toBe(152);
    expect(film.draftFrom).toBe(152 - 41);
    expect(film.resumeTo).toBe(152 + 58);
    expect(film.duration).toBeLessThanOrEqual(11.2);
  });
  it("gives a remaster no close crop and keeps the freeze inside both clips when their lengths differ", () => {
    const p = planReveal({ fps: 24, draftFrames: 97, finalFrames: 107, hasSource: true, kind: "remaster" });
    expect(p.detail).toBeNull();
    expect(p.freezeFrame).toBeLessThan(97);
    const short = planReveal({ fps: 24, draftFrames: 97, finalFrames: 20, hasSource: false, kind: "remaster" });
    expect(short.freezeFrame).toBeLessThanOrEqual(18);
    expect(short.source).toBeNull();
  });
  it("refuses what it cannot time", () => {
    expect(() => planReveal({ fps: 0, draftFrames: 97, finalFrames: 97, hasSource: true, kind: "same_take" })).toThrow();
    expect(() => planReveal({ fps: 24, draftFrames: 1, finalFrames: 97, hasSource: true, kind: "same_take" })).toThrow();
  });
});

describe("composition", () => {
  const scene = (width: number, height: number, srcWidth: number, srcHeight: number, kind: "same_take" | "remaster" = "same_take"): RevealScene => ({
    width,
    height,
    aspect: width > height ? "16:9" : "9:16",
    theme: "dark",
    plan: planReveal({ fps: 24, draftFrames: 97, finalFrames: 97, hasSource: true, kind }),
    media: { source: "media/source.png", draftHead: "media/draft-head.mp4", draftFrame: "media/draft-frame.png", finalFrame: "media/final-frame.png", finalPlay: "media/final-play.mp4", srcWidth, srcHeight },
    copy: { opening: "One photo.", draftSize: "640×384", finalSize: "1280×768", kind, freezeFrame: 41, frames: 97 },
    crop: { x: 0.4, y: 0.3, w: 0.2 },
  });
  it("stacks a wide picture's compare on a tall frame and splits it on a wide one, inside the safe areas", () => {
    const tall = revealLayout(scene(1080, 1920, 1280, 768));
    expect(tall.compare).toBe("stack");
    expect(tall.second).not.toBeNull();
    expect(tall.media.left).toBeGreaterThanOrEqual(48);
    expect(tall.media.left + tall.media.width).toBeLessThanOrEqual(1080 - 48);
    expect(tall.headline.bottom).toBeLessThan(tall.media.top);
    expect(tall.second!.top).toBeGreaterThan(tall.media.top + tall.media.height);
    expect(tall.second!.top + tall.second!.height).toBeLessThanOrEqual(0.8 * 1920 + 1);
    expect(tall.tags.top).toBeGreaterThan(tall.media.top + tall.media.height);
    const wide = revealLayout(scene(1920, 1080, 1280, 768));
    expect(wide.compare).toBe("split");
    expect(wide.second).toBeNull();
    expect(wide.media.width).toBeLessThanOrEqual(1920 - 96);
    expect(wide.media.top).toBeGreaterThan(wide.headline.bottom);
    expect(wide.tags.top + wide.tags.size * 1.7).toBeLessThanOrEqual(1080);
    const tallOnTall = revealLayout(scene(1080, 1920, 768, 1280));
    expect(tallOnTall.compare).toBe("split");
    expect(tallOnTall.media.top + tallOnTall.media.height).toBeLessThanOrEqual(0.8 * 1920 + 1);
    const tallOnWide = revealLayout(scene(1920, 1080, 768, 1280));
    expect(tallOnWide.compare).toBe("split");
    expect(tallOnWide.media.height).toBeLessThanOrEqual(1080 * 0.67 + 1);
  });
  it("keeps every tag inside the frame's safe width for portrait, landscape and square sources, in both shapes", () => {
    const tagW = (text: string, size: number, tone = false) => tagTextWidth(text, size) + 2 * 0.62 * size + (tone ? 0.9 * size : 0);
    for (const [W, H] of [[1080, 1920], [1920, 1080]] as const) {
      for (const [sw, sh] of [[768, 1280], [1280, 768], [1024, 1024]] as const) {
        const L = revealLayout(scene(W, H, sw, sh));
        const avail = W - L.gutter - L.tags.left;
        const widths = [tagW("Same take, 768×1280", L.tags.size, true), tagW("Frame 152 of 361", L.tags.size), tagW("Same moment, up close", L.tags.size)];
        const slots = layoutTagSlots(widths, avail, 12 * L.u, L.tags.size * 1.7 + 10 * L.u);
        for (const [i, at] of slots.entries()) {
          expect(L.tags.left + at.left + widths[i]!, `${W}x${H} from ${sw}x${sh}, tag ${i}`).toBeLessThanOrEqual(W - L.gutter + 0.5);
          expect(L.tags.top + at.top + L.tags.size * 1.7).toBeLessThanOrEqual(H);
        }
        // The page's own row never clips either: the tags' column runs to the safe edge and has room for two rows.
        const s = scene(W, H, sw, sh);
        s.plan = planReveal({ fps: 24, draftFrames: 361, finalFrames: 361, hasSource: true, kind: "same_take" });
        s.copy = { ...s.copy, draftSize: "384×640", finalSize: "768×1280", freezeFrame: 152, frames: 361 };
        const html = buildRevealComposition(s, "");
        expect(html).toContain("Frame 152 of 361");
      }
    }
    // A portrait source on a tall frame: the three tags do not fit beside the narrow card in one row, so they wrap.
    const L = revealLayout(scene(1080, 1920, 768, 1280));
    const widths = [tagW("Same take, 768×1280", L.tags.size, true), tagW("Frame 152 of 361", L.tags.size), tagW("Same moment, up close", L.tags.size)];
    const slots = layoutTagSlots(widths, 1080 - L.gutter - L.tags.left, 12 * L.u, 68);
    expect(slots.map((s) => s.row)).toEqual([0, 0, 1]);
    expect(layoutTagSlots([100, 100, 100], 1000, 10, 50).map((s) => s.row)).toEqual([0, 0, 0]);
    expect(layoutTagSlots([900, 900], 1000, 10, 50)).toEqual([{ left: 0, top: 0, row: 0 }, { left: 0, top: 50, row: 1 }]);
  });
  it("keeps the headline on one line and the crop window inside the picture", () => {
    expect(fitHeadline("Draft.", 92, 984)).toBe(92);
    expect(fitHeadline("Same take. Finished.", 92, 600)).toBeLessThan(92);
    const win = cropWindow({ x: 0.95, y: 0.9, w: 0.2 }, { left: 0, top: 0, width: 984, height: 590 }, { width: 490, height: 590 });
    expect(win.x + win.w).toBeLessThanOrEqual(1);
    expect(win.y + win.h).toBeLessThanOrEqual(1);
  });
  it("writes the real sizes, the frame tag and the claim for a same-take final", () => {
    const html = buildRevealComposition(scene(1080, 1920, 1280, 768), "");
    expect(html).toContain("Same take. Finished.");
    expect(html).toContain("Frame 41 of 97");
    expect(html).toContain("640×384");
    expect(html).toContain("1280×768");
    expect(buildRevealComposition(scene(1920, 1080, 1280, 768), "")).toContain("Same moment, up close");
    expect(html).toContain("Finished overnight.");
    // The tall frame stacks the two frames; the wide one wipes with a held split.
    expect(html).toContain('id="second"');
    const wide = buildRevealComposition(scene(1920, 1080, 1280, 768), "");
    expect(wide).not.toContain('id="second"');
    expect(wide).toContain("inset(0 58% 0 0)");
    expect(html).not.toContain("Remaster");
    // The video elements start on the frame grid with microsecond precision.
    const starts = [...html.matchAll(/data-start="([^"]+)"/g)].map((m) => Number(m[1]));
    for (const s of starts) expect(Math.abs(s * 24 - Math.round(s * 24))).toBeLessThan(1e-4);
  });
  it("never calls a remaster the same take", () => {
    const html = buildRevealComposition(scene(1080, 1920, 1280, 768, "remaster"), "");
    expect(html).toContain("Remaster.");
    expect(html).toContain("Can drift");
    expect(html).not.toContain("Same take");
    expect(html).not.toContain("Frame 41 of 97");
    expect(html).not.toContain("up close");
  });
});

const tools = resolveTools();
const canRender = Boolean(tools.chrome) && existsSync(tools.ffmpeg);

describe.skipIf(!canRender)("a rendered reveal", { timeout: 180_000 }, () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ns-reveal-"));
    // A draft (small) and a final (twice the size) of the same synthetic take: a counter and moving bars, 49 frames.
    const take = (out: string, w: number, h: number) =>
      run(tools.ffmpeg, [
        "-v", "error", "-y",
        "-f", "lavfi", "-i", `testsrc2=size=${w}x${h}:rate=24:duration=${49 / 24}`,
        "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${49 / 24}`,
        "-frames:v", "49", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out,
      ]);
    await take(join(dir, "draft.mp4"), 320, 192);
    await take(join(dir, "final.mp4"), 640, 384);
    await run(tools.ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=steelblue:size=640x384", "-frames:v", "1", join(dir, "still.png")]);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("renders both shapes with the frozen and revealed frames on the same index", async () => {
    const p = project();
    p.assets = [
      { id: "still", kind: "image", path: "still.png", createdAt: NOW },
      { id: "dv", kind: "video", path: "draft.mp4", width: 320, height: 192, createdAt: NOW },
      { id: "fv", kind: "video", path: "final.mp4", width: 640, height: 384, createdAt: NOW },
      { id: "ov", kind: "video", path: "draft.mp4", createdAt: NOW },
    ];
    expect(await countFrames(tools, join(dir, "draft.mp4"))).toBe(49);
    const result = await exportReveal(p, { projectDir: dir, outPath: join(dir, "reveal.mp4"), aspect: "9:16", shortSide: 540, quality: "draft", workDir: join(dir, "work"), keepWorkDir: true });
    expect(result.width).toBe(540);
    expect(result.height).toBe(960);
    expect(result.durationSec).toBeGreaterThanOrEqual(7.5);
    expect(result.durationSec).toBeLessThanOrEqual(12);
    expect(result.freezeFrame).toBe(21);
    expect(result.warnings).toEqual([]);
    expect(Math.abs(result.plan.wipe.end - result.plan.wipe.start - 1.2)).toBeLessThan(1 / 24);
    // The frozen frames in the composition are frame 21 of each take, by index.
    const F = result.freezeFrame;
    const same = async (a: string, b: string) => {
      const { stderr } = await run(tools.ffmpeg, ["-v", "info", "-i", a, "-i", b, "-lavfi", "ssim", "-f", "null", "-"]);
      return Number(/All:([0-9.]+)/.exec(stderr)?.[1] ?? 0);
    };
    const frame = async (src: string, index: number, out: string) => {
      await run(tools.ffmpeg, ["-v", "error", "-y", "-i", src, "-vf", `select=eq(n\\,${index})`, "-fps_mode", "passthrough", "-frames:v", "1", out]);
      return out;
    };
    const media = join(dir, "work", "composition", "media");
    expect(await same(join(media, "draft-frame.png"), await frame(join(dir, "draft.mp4"), F, join(dir, "d21.png")))).toBeGreaterThan(0.98);
    expect(await same(join(media, "final-frame.png"), await frame(join(dir, "final.mp4"), F, join(dir, "f21.png")))).toBeGreaterThan(0.98);
    expect(await same(join(media, "draft-frame.png"), await frame(join(dir, "draft.mp4"), F + 3, join(dir, "d24.png")))).toBeLessThan(0.98);
    // The final's tail starts on frame F and the draft's head stops before it.
    expect(await countFrames(tools, join(media, "draft-head.mp4"))).toBe(F);
    const endFrames = Math.round((result.plan.endCard.end - result.plan.endCard.start) * 24);
    expect(await countFrames(tools, join(media, "final-play.mp4"))).toBe(49 - F + endFrames);
    expect(await same(await frame(join(media, "final-play.mp4"), 0, join(dir, "t0.png")), join(dir, "f21.png"))).toBeGreaterThan(0.98);
    expect(await same(await frame(join(media, "final-play.mp4"), 49 - F, join(dir, "e0.png")), await frame(join(dir, "final.mp4"), 0, join(dir, "f0.png")))).toBeGreaterThan(0.98);

    const wide = await exportReveal(p, { projectDir: dir, outPath: join(dir, "reveal-wide.mp4"), aspect: "16:9", shortSide: 540, quality: "draft" });
    expect(wide.width).toBe(960);
    expect(wide.height).toBe(540);
    expect(Math.abs(wide.durationSec - result.durationSec)).toBeLessThan(0.05);
  });

  it("plays a window around the freeze for a long take and still pairs the same frame", async () => {
    // A 15-second take at 24 fps: 361 frames, like a What-if film.
    const long = (out: string, w: number, h: number) =>
      run(tools.ffmpeg, ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=${w}x${h}:rate=24:duration=${361 / 24}`, "-frames:v", "361", "-c:v", "libx264", "-pix_fmt", "yuv420p", out]);
    await long(join(dir, "long-draft.mp4"), 192, 320);
    await long(join(dir, "long-final.mp4"), 384, 640);
    const p = project();
    p.template = "what_if";
    p.brief = { question: "What if you fell into Jupiter?" };
    p.assets = [
      { id: "still", kind: "image", path: "still.png", createdAt: NOW },
      { id: "dv", kind: "video", path: "long-draft.mp4", width: 192, height: 320, createdAt: NOW },
      { id: "fv", kind: "video", path: "long-final.mp4", width: 384, height: 640, createdAt: NOW },
      { id: "ov", kind: "video", path: "long-draft.mp4", createdAt: NOW },
    ];
    const result = await exportReveal(p, { projectDir: dir, outPath: join(dir, "reveal-long.mp4"), aspect: "9:16", shortSide: 540, quality: "draft", workDir: join(dir, "work-long"), keepWorkDir: true });
    expect(result.durationSec).toBeLessThanOrEqual(12);
    expect(result.freezeFrame).toBe(152);
    expect(result.warnings).toEqual([]);
    const { plan } = result;
    const media = join(dir, "work-long", "composition", "media");
    const frame = async (src: string, index: number, out: string) => {
      await run(tools.ffmpeg, ["-v", "error", "-y", "-i", src, "-vf", `select=eq(n\\,${index})`, "-fps_mode", "passthrough", "-frames:v", "1", out]);
      return out;
    };
    const same = async (a: string, b: string) => {
      const { stderr } = await run(tools.ffmpeg, ["-v", "info", "-i", a, "-i", b, "-lavfi", "ssim", "-f", "null", "-"]);
      return Number(/All:([0-9.]+)/.exec(stderr)?.[1] ?? 0);
    };
    // The draft's run-up starts at draftFrom and stops on the frame before the freeze; the final's run-on starts on the freeze.
    expect(await countFrames(tools, join(media, "draft-head.mp4"))).toBe(plan.freezeFrame - plan.draftFrom);
    expect(await same(await frame(join(media, "draft-head.mp4"), 0, join(dir, "lh0.png")), await frame(join(dir, "long-draft.mp4"), plan.draftFrom, join(dir, "ld-from.png")))).toBeGreaterThan(0.98);
    expect(await same(await frame(join(media, "draft-head.mp4"), 0, join(dir, "lh0.png")), await frame(join(dir, "long-draft.mp4"), 0, join(dir, "ld0.png")))).toBeLessThan(0.98);
    expect(await same(join(media, "draft-frame.png"), await frame(join(dir, "long-draft.mp4"), 152, join(dir, "ld152.png")))).toBeGreaterThan(0.98);
    expect(await same(join(media, "final-frame.png"), await frame(join(dir, "long-final.mp4"), 152, join(dir, "lf152.png")))).toBeGreaterThan(0.98);
    const endFrames = Math.round((plan.endCard.end - plan.endCard.start) * 24);
    expect(await countFrames(tools, join(media, "final-play.mp4"))).toBe(plan.resumeTo - plan.freezeFrame + endFrames);
    expect(await same(await frame(join(media, "final-play.mp4"), 0, join(dir, "lt0.png")), join(dir, "lf152.png"))).toBeGreaterThan(0.98);
    // The clip opens on the question, not on "One photo."
    const html = await import("node:fs/promises").then((fs) => fs.readFile(join(dir, "work-long", "composition", "index.html"), "utf8"));
    expect(html).toContain("What if you fell into Jupiter?");
    expect(html).not.toContain("One photo.");
  });
});
