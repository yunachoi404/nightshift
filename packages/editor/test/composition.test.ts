import { describe, expect, it } from "vitest";
import {
  buildComposition,
  captionBand,
  cardSide,
  estimateLines,
  figureLike,
  intersects,
  layoutFor,
  objectPosition,
  placeCaptions,
  placeNameTag,
  placeTitle,
  SAFE_AREA,
  subjectBox,
  scrimFor,
  sideWidth,
  subjectBoxInFrame,
  subjectInFrame,
  subjectRect,
  type Scene,
  type SceneClip,
} from "../src/render/composition.js";
import { Tracks } from "../src/render/tracks.js";
import { defaultStyle } from "../src/style.js";

function scene(overrides: Partial<Scene> = {}): Scene {
  return {
    width: 1920,
    height: 1080,
    fps: 24,
    duration: 8,
    aspect: "16:9",
    style: defaultStyle("cinematic_shot"),
    clips: [
      { kind: "video", src: "media/c0.mp4", start: 0, end: 4.4, focus: { x: 0.5, y: 0.5 }, srcWidth: 1920, srcHeight: 1088 },
      { kind: "image", src: "media/s1.png", start: 3.6, end: 8, focus: { x: 0.5, y: 0.5 }, srcWidth: 1024, srcHeight: 1024 },
    ],
    overlays: [{ id: "title", kind: "title", start: 0.6, end: 3.5, text: "The <Quiet> Hours", subtext: "A film" }],
    captions: [{ start: 1, end: 2.5, text: "Hello there", words: [{ start: 1, end: 1.4, text: "Hello" }, { start: 1.5, end: 2.2, text: "there" }] }],
    markers: [],
    ...overrides,
  };
}

/** The real street footage as the finder sees it: a figure walking away in the middle, head at 37%, feet at 84%. */
const WALKER: SceneClip = {
  kind: "video",
  src: "media/c0.mp4",
  start: 0,
  end: 8,
  focus: { x: 0.5, y: 0.5 },
  subject: { x: 0.5, y: 0.54 },
  box: { left: 0.447, top: 0.37, right: 0.543, bottom: 0.84 },
  // A bright foggy sky over the figure, a dark wet road under it.
  rows: [0.78, 0.78, 0.76, 0.74, 0.72, 0.7, 0.6, 0.5, 0.4, 0.35, 0.3, 0.28, 0.25, 0.22, 0.2, 0.18],
  srcWidth: 1280,
  srcHeight: 768,
};

/** A cup that fills a phone frame: nothing can be clear of it. */
const CUP: SceneClip = { ...WALKER, subject: { x: 0.6, y: 0.4 }, box: { left: 0.04, top: 0, right: 0.81, bottom: 1 }, rows: WALKER.rows!.map(() => 0.25), srcWidth: 1920, srcHeight: 802 };

function portrait(style: Scene["style"], clips: SceneClip[], overrides: Partial<Scene> = {}): Scene {
  return scene({ width: 1080, height: 1920, aspect: "9:16", style, clips, ...overrides });
}

/** The renderer's own rounding, for matching inline pixel values. */
const px3 = (v: number) => String(Math.round(v * 1000) / 1000);

function tracksOf(html: string): [string, string, [number, string | number, string?][]][] {
  const json = html.match(/window\.__NIGHTSHIFT__ = (.*);<\/script>/)![1]!;
  return JSON.parse(json).tracks;
}

describe("buildComposition", () => {
  it("crops nearly matching shots even with saved whole-picture framing and cinematic bars", () => {
    const style = defaultStyle("cinematic_shot");
    style.picture.reframe = "fit_blur";
    const s = scene({ style, clips: [WALKER] });
    const html = buildComposition(s, "").html;
    expect(html).toContain('class="bar bar-top"');
    expect(html).toContain('object-fit:cover');
    expect(html).not.toContain('class="clip media blur"');
    expect(html).not.toContain('object-fit:contain');
    expect(style.picture.reframe).toBe("fit_blur");
  });

  it("keeps whole-picture framing for genuinely different shapes, per clip", () => {
    const style = defaultStyle("talking_intro");
    style.picture.reframe = "fit_blur";
    const html = buildComposition(portrait(style, [WALKER, { ...WALKER, kind: "image", srcWidth: 768, srcHeight: 1280 }]), "").html;
    expect(html).toContain('id="v0b" class="clip media blur"');
    expect(html).toContain('object-fit:contain');
    // 768x1280 is within 10% of 9:16, despite the nominal source format.
    expect(html).not.toContain('id="i1b"');
  });

  it("writes a HyperFrames page with timed video clips and no GSAP", () => {
    const { html, fonts } = buildComposition(scene(), "");
    expect(html).toContain('data-composition-id="nightshift"');
    expect(html).toContain('data-width="1920" data-height="1080" data-duration="8" data-no-timeline');
    expect(html).toMatch(/<video id="v0" class="clip media"[^>]*data-start="0" data-duration="4.4" data-media-start="0"/);
    expect(html).toContain('<img id="i1"');
    expect(html.toLowerCase()).not.toContain("gsap");
    expect(html).toContain("The &lt;Quiet&gt; Hours");
    expect(fonts).toEqual(expect.arrayContaining(["cormorant-garamond", "instrument-sans"]));
  });

  it("dissolves where clips overlap and holds the incoming clip until then", () => {
    const tracks = tracksOf(buildComposition(scene(), "").html);
    const incoming = tracks.find(([id, prop]) => id === "k1" && prop === "opacity")![2];
    expect(incoming[0]).toEqual([3600, 0, "linear"]);
    expect(incoming.find((k) => k[0] === 4400)?.[1]).toBe(1);
  });

  it("letterboxes landscape cinematic exports and puts subtitles in the bar", () => {
    const { html } = buildComposition(scene(), "");
    expect(html).toContain('class="bar bar-top"');
    expect(html).toContain("anchor-bar");
    const portraitHtml = buildComposition(scene({ width: 1080, height: 1920, aspect: "9:16" }), "").html;
    expect(portraitHtml).not.toContain('class="bar bar-top"');
  });

  it("raises words through a mask and sweeps the accent across the spoken word (karaoke)", () => {
    const { html } = buildComposition(scene({ style: defaultStyle("talking_intro") }), "");
    const tracks = tracksOf(html);
    // Each word rises into place as the line arrives, the second a beat after the first.
    const rise = (j: number) => tracks.find(([id, prop]) => id === `c0w${j}i` && prop === "translate")![2];
    expect(rise(0)[0]).toEqual([990, "0 1.2em", expect.any(String)]);
    expect(rise(1)[0]![0]).toBeGreaterThan(990);
    // The fill crosses "there" while it is said (1.5 to 2.2 s); "Hello" fades back as "there" starts.
    const fill = tracks.find(([id, prop]) => id === "c0w1f" && prop === "mask-position")![2];
    expect(fill).toEqual([[1500, "100% 0%", expect.any(String)], [2200, "0% 0%"]]);
    const fade = tracks.find(([id, prop]) => id === "c0w0f" && prop === "opacity")![2];
    expect(fade).toEqual([[1500, 1, expect.any(String)], [1700, 0]]);
    expect(html).not.toContain("text-decoration");
    // Hidden either side of its span, so stacked captions never show together.
    const shown = tracks.find(([id, prop]) => id === "c0" && prop === "visibility")![2];
    expect(shown.at(-1)![1]).toBe("hidden");
  });

  it("slides one accent block from word to word on a frosted plate (chip)", () => {
    const { html } = buildComposition(scene({ style: defaultStyle("product_ad") }), "");
    expect(html).toContain('class="caps caps-chip anchor-bottom band-lower"');
    expect(html).toContain('<span class="hl" id="c0h"');
    const tracks = tracksOf(html);
    // Measured in the page: the block's left edge travels from "Hello" to "there", arriving as it is said.
    const left = tracks.find(([id, prop]) => id === "c0h" && prop === "left")![2];
    expect(left.at(-2)).toEqual([1430, "calc({x:c0w0}px - 0.13em)", expect.any(String)]);
    expect(left.at(-1)).toEqual([1610, "calc({x:c0w1}px - 0.13em)"]);
    // The word under the block takes the text-on-accent colour while the block is on it.
    const color = tracks.find(([id, prop]) => id === "c0w1i" && prop === "color")![2];
    expect(color.at(-1)).toEqual([1610, "var(--accent-text)"]);
    // The plate opens from the middle.
    const plate = tracks.find(([id, prop]) => id === "c0l" && prop === "clip-path")![2];
    expect(plate[0]![1]).toBe("inset(0% 50% 0% 50% round 0.36em)");
  });

  it("lands lyric words as they are sung and anchors the block to a fixed line (kinetic)", () => {
    // The sample clip has no measured box, so a modest one around its middle stands in: the usual lyric line just
    // under the middle would cross it, and the block drops to the lowest line above the apps' controls.
    const { html } = buildComposition(scene({ width: 1080, height: 1920, aspect: "9:16", style: defaultStyle("music_video") }), "");
    expect(html).toContain('class="caps caps-kinetic anchor-bottom band-lower upper"');
    expect(html).toMatch(/caps-kinetic[^>]*style="bottom:422.4px;height:0;/);
    const tracks = tracksOf(html);
    const word = tracks.find(([id, prop]) => id === "c0w1i" && prop === "opacity")![2];
    expect(word[0]).toEqual([1480, 0, expect.any(String)]);
    // It lands large and soft, settles, and is lit in the accent until the next word.
    const scale = tracks.find(([id, prop]) => id === "c0w1i" && prop === "scale")![2];
    expect(scale.map(([, v]) => v)).toEqual(["1.22", "1"]);
    const color = tracks.find(([id, prop]) => id === "c0w0i" && prop === "color")![2];
    expect(color[0]).toEqual([980, "var(--accent)"]);
    expect(color.at(-1)![1]).toBe("var(--cap-text)");
  });

  it("keeps a corner title on the side away from the subject", () => {
    const left = scene({ style: defaultStyle("product_ad"), clips: [{ kind: "video", src: "media/c0.mp4", start: 0, end: 4, focus: { x: 0.5, y: 0.5 }, subject: { x: 0.2, y: 0.5 }, srcWidth: 1920, srcHeight: 1088 }] });
    expect(cardSide(left, 0.5)).toBe("right");
    expect(cardSide(scene(), 0.5)).toBe("left");
    const html = buildComposition(left, "").html;
    const safe = SAFE_AREA.landscape;
    expect(html).toContain(`class="title title-ad side-right" id="o0" style="top:${1080 * safe.top + 2 * 10.8}px;right:${1920 * safe.right}px;max-width:967.68px"`);
    // A portrait crop centred on that subject brings it to the middle of the frame, so the card may stay left.
    const cropped = { ...left, width: 1080, height: 1920, aspect: "9:16" as const, clips: [{ ...left.clips[0]!, focus: { x: 0.2, y: 0.5 } }] };
    expect(cardSide(cropped, 0.5)).toBe("left");
  });

  it("puts a centred title in the band with room, away from the subject", () => {
    const subjectLow = scene({ clips: [{ kind: "video", src: "media/c0.mp4", start: 0, end: 8, focus: { x: 0.5, y: 0.5 }, subject: { x: 0.5, y: 0.7 }, srcWidth: 1920, srcHeight: 1088 }] });
    expect(buildComposition(subjectLow, "").html).toContain('class="title title-cine band-upper"');
    expect(buildComposition(scene(), "").html).toContain('class="title title-cine band-lower"');
    // In the source the subject is at 70%; the 2.39 letterbox crops 1088 down to 803 rows around the middle.
    const inFrame = subjectInFrame(subjectLow.clips[0]!, 1920, 1920 / 2.39);
    expect(inFrame.x).toBeCloseTo(0.5, 5);
    expect(inFrame.y).toBeCloseTo((0.7 * 1088 - (1088 - 1920 / 2.39) / 2) / (1920 / 2.39), 3);
  });

  it("splits the end card into the photo and an accent panel, and fills the frame without one", () => {
    const card = { id: "end", kind: "end_card" as const, start: 5, end: 8, text: "Lumen", subtext: "Light that keeps time", cta: "Order yours today" };
    const withPhoto = buildComposition(scene({ style: defaultStyle("product_ad"), overlays: [{ ...card, imageSrc: "media/o0.png" }] }), "").html;
    expect(withPhoto).toContain('<div class="ec" id="o0"');
    expect(withPhoto).toContain('<img class="ec-img" id="o0i" src="media/o0.png"');
    expect(withPhoto).toContain(".landscape .ec-photo{left:0;top:0;bottom:0;width:56%}");
    expect(withPhoto).toContain('class="ec-cta" id="o0c"');
    const plain = buildComposition(scene({ style: defaultStyle("product_ad"), overlays: [card] }), "").html;
    expect(plain).toContain('<div class="ec ec-plain" id="o0"');
    expect(plain).not.toContain('<img class="ec-img"');
    // The panel slides in from the right on a landscape frame and from below elsewhere.
    expect(tracksOf(withPhoto).find(([id, prop]) => id === "o0p" && prop === "clip-path")![2][0]![1]).toBe("inset(0% 0% 0% 100%)");
    const portraitHtml = buildComposition(scene({ width: 1080, height: 1920, aspect: "9:16", style: defaultStyle("product_ad"), overlays: [card] }), "").html;
    expect(tracksOf(portraitHtml).find(([id, prop]) => id === "o0p" && prop === "clip-path")![2][0]![1]).toBe("inset(100% 0% 0% 0%)");
  });

  it("gives every shape a safe area and a type unit", () => {
    const style = defaultStyle("cinematic_shot");
    const landscape = layoutFor({ width: 1920, height: 1080, style });
    expect(landscape.shape).toBe("landscape");
    expect(landscape.letterbox).toBeCloseTo((1080 - 1920 / 2.39) / 2, 3);
    const portraitLayout = layoutFor({ width: 1080, height: 1920, style });
    expect(portraitLayout.shape).toBe("portrait");
    expect(portraitLayout.letterbox).toBe(0);
    expect(portraitLayout.safe.bottom).toBe(1920 * 0.22);
    expect(portraitLayout.t).toBeCloseTo(10.8 * 1.28, 5);
    expect(layoutFor({ width: 1080, height: 1080, style }).shape).toBe("square");
  });

  it("fits a real ad end card inside the portrait panel above the social controls", () => {
    const html = buildComposition(portrait(defaultStyle("product_ad"), [], {
      overlays: [{ id: "end", kind: "end_card", start: 5, end: 8, text: "Daybreak Mug", subtext: "Holds your morning coffee in a simple red enamel cup", cta: "Shop now", imageSrc: "media/product.jpg" }],
    }), "").html;
    const nameSize = Number(html.match(/class="ec-name"[^>]*font-size:([0-9.]+)px/)![1]);
    // The old 140 px title overflowed the panel horizontally and pushed the group above its top.
    expect(nameSize).toBeLessThan(100);
    expect(nameSize).toBeGreaterThan(40);
    expect(html).toContain("max-width:100%;flex-shrink:0;overflow-wrap:anywhere");
  });

  it("pulses on downbeats and flashes where sections change (music video)", () => {
    const style = defaultStyle("music_video");
    const html = buildComposition(
      scene({
        style,
        clips: [
          { kind: "video", src: "media/c0.mp4", start: 0, end: 4, focus: { x: 0.5, y: 0.5 }, srcWidth: 1920, srcHeight: 1088 },
          { kind: "video", src: "media/c1.mp4", start: 4, end: 8, focus: { x: 0.5, y: 0.5 }, srcWidth: 1920, srcHeight: 1088 },
        ],
        markers: [{ t: 2, kind: "downbeat" }, { t: 4, kind: "section" }, { t: 6, kind: "downbeat" }],
      }),
      "",
    ).html;
    const tracks = tracksOf(html);
    expect(tracks.find(([id]) => id === "p0")).toBeDefined();
    expect(tracks.find(([id]) => id === "flash")![2].some(([t, v]) => t === 4000 && v === 0.85)).toBe(true);
  });
});

describe("keep-out: the subject box", () => {
  it("maps the measured box through a portrait crop and stands a modest box in for a bare point", () => {
    // A 9:16 frame from the 1280x768 street shot shows a 432 px wide window of the source, centred on the focus.
    const box = subjectBoxInFrame(WALKER, 1080, 1920);
    expect(box.top).toBeCloseTo(0.37, 5);
    expect(box.bottom).toBeCloseTo(0.84, 5);
    expect(box.left).toBeCloseTo((WALKER.box!.left * 1280 - (640 - 216)) / 432, 4);
    expect(box.right).toBeCloseTo((WALKER.box!.right * 1280 - (640 - 216)) / 432, 4);
    const bare = subjectBoxInFrame({ focus: { x: 0.5, y: 0.5 }, subject: { x: 0.5, y: 0.7 }, srcWidth: 1920, srcHeight: 1088 }, 1920, 1080);
    expect(bare.top).toBeCloseTo((0.55 * 1088 - 4) / 1080, 4);
    expect(bare.bottom).toBeCloseTo((0.85 * 1088 - 4) / 1080, 4);
  });

  it("boxes a moving subject by the samples that fall in a moment, or the nearest one", () => {
    const small = { left: 0.45, top: 0.4, right: 0.55, bottom: 0.8 };
    const big = { left: 0, top: 0, right: 1, bottom: 1 };
    const clip: SceneClip = { ...WALKER, start: 8, end: 12, box: big, boxes: [small, small, small, big, big, big] };
    // Samples sit at 8.33, 9, 9.67, 10.33, 11, 11.67 s.
    expect(subjectBox(clip, 8.2, 9.5)).toEqual(small);
    expect(subjectBox(clip, 8.9, 10.5)).toEqual(big);
    expect(subjectBox(clip, 8.5)).toEqual(small);
    expect(subjectBox(clip, 11.9)).toEqual(big);
    expect(subjectBox(clip)).toEqual(big);
    const modest = subjectBox({ ...clip, boxes: undefined, box: undefined }, 9);
    expect([modest.left, modest.top, modest.right, modest.bottom].map((v) => Math.round(v * 1000) / 1000)).toEqual([0.42, 0.39, 0.58, 0.69]);
  });

  it("measures the free width beside the subject for a corner card", () => {
    const s = portrait(defaultStyle("talking_intro"), [WALKER]);
    const L = layoutFor(s);
    const rect = subjectRect(s, L, 1)!;
    // Between the left safe edge and the figure, less the gap; the whole safe width when nothing shows.
    expect(sideWidth(s, L, 1, "left")).toBeCloseTo(rect.left - 2 * L.u - L.safe.left, 5);
    expect(sideWidth(s, L, 1, "right")).toBeCloseTo(1080 - L.safe.right - rect.right - 2 * L.u, 5);
    expect(sideWidth(s, L, 20, "left")).toBe(1080 - L.safe.left - L.safe.right);
    expect(intersects({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 12, top: 0, right: 20, bottom: 10 })).toBe(false);
    expect(intersects({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 12, top: 0, right: 20, bottom: 10 }, 3)).toBe(true);
  });

  it("estimates how a line wraps and how dark a scrim must be", () => {
    expect(estimateLines("Hello there", 50, 1000, 0.5)).toBe(1);
    expect(estimateLines("and I make films at night", 64, 500, 0.52)).toBe(2);
    expect(estimateLines("one", 64, 10, 0.52)).toBe(1);
    expect(scrimFor(0.2)).toBe(0);
    expect(scrimFor(0.8)).toBe(0.45);
    expect(scrimFor(0.525)).toBeCloseTo(0.225, 5);
    expect(scrimFor(0.2, 0.3)).toBe(0.3);
    expect(scrimFor(undefined)).toBe(0);
  });
});

describe("keep-out: captions", () => {
  const metrics = (lineHeight: number, pad = 0) => ({ width: 842.4, lineHeight, pad, linesOf: () => 1 });

  it("keeps the usual line when it is clear of the subject", () => {
    const s = portrait(defaultStyle("talking_intro"), [{ ...WALKER, box: { left: 0.43, top: 0.2, right: 0.56, bottom: 0.55 } }]);
    const place = placeCaptions(s, layoutFor(s), metrics(78.8));
    expect(place).toMatchObject({ anchor: "bottom", band: "lower", clear: true });
    expect(place.offset).toBeCloseTo(1920 * 0.32, 6);
  });

  it("drops to the lowest line above the apps' controls when the usual line would cross the subject", () => {
    const s = portrait(defaultStyle("talking_intro"), [{ ...WALKER, box: { left: 0.43, top: 0.3, right: 0.56, bottom: 0.7 } }]);
    const place = placeCaptions(s, layoutFor(s), metrics(78.8));
    expect(place).toMatchObject({ anchor: "bottom", band: "lower", clear: true });
    expect(place.offset).toBeCloseTo(1920 * 0.22, 6);
  });

  it("goes just above the head, growing upwards, when a centred figure reaches the controls", () => {
    const s = portrait(defaultStyle("talking_intro"), [WALKER]);
    const L = layoutFor(s);
    const place = placeCaptions(s, L, metrics(78.8));
    expect(place.anchor).toBe("bottom");
    expect(place.band).toBe("upper");
    expect(place.clear).toBe(true);
    // The block's bottom sits a gap above the head, at 37% of the frame.
    expect(place.offset).toBeCloseTo(1920 - (0.37 * 1920 - 2 * L.u), 3);
    // The sky behind it is bright, so a scrim darkens behind the block.
    expect(place.scrim).toBeCloseTo(0.45, 6);
    const html = buildComposition(s, "").html;
    expect(html).toMatch(/caps-karaoke anchor-bottom band-upper[^>]*style="bottom:1231.2px;height:0;/);
    expect(html).toContain('<div class="band" id="cband"');
    // The band shows with the captions, not before.
    const band = tracksOf(html).find(([id, prop]) => id === "cband" && prop === "opacity")![2];
    expect(band[0]![0]).toBe(1000);
    expect(band[0]![1]).toBe(0);
  });

  it("takes two lines into account when it measures the room above the head", () => {
    const s = portrait(defaultStyle("talking_intro"), [WALKER]);
    const L = layoutFor(s);
    const place = placeCaptions(s, L, { ...metrics(78.8), linesOf: () => 2 });
    expect(place.band).toBe("upper");
    expect(place.rect.top).toBeCloseTo(0.37 * 1920 - 2 * L.u - 2 * 78.8, 3);
    // Too tall for the room above the head: nothing is clear and the old rule applies.
    const tall = placeCaptions(s, L, { ...metrics(78.8), linesOf: () => 6 });
    expect(tall.clear).toBe(false);
  });

  it("never goes above the title line: a low head only pulls the block down to the usual upper line", () => {
    const low = { ...WALKER, box: { left: 0.43, top: 0.6, right: 0.56, bottom: 1 } };
    const s = portrait(defaultStyle("talking_intro"), [low]);
    const place = placeCaptions(s, layoutFor(s), metrics(78.8));
    expect(place).toMatchObject({ anchor: "bottom", band: "upper", clear: true });
    expect(place.offset).toBeCloseTo(1920 - (1920 * 0.37 + 78.8), 6);
  });

  it("lets a subject that fills the frame fall back to the old rule, with a scrim, and keeps one line for the film", () => {
    const s = portrait(defaultStyle("music_video"), [
      { ...CUP, start: 0, end: 4 },
      { ...WALKER, start: 4, end: 8 },
    ], {
      captions: [
        { start: 1, end: 2, text: "Neon rain" },
        { start: 5, end: 6, text: "The city breathe" },
      ],
    });
    const L = layoutFor(s);
    const place = placeCaptions(s, L, metrics(112));
    // The cup cannot be cleared and does not vote; the walker sends the lyrics above the head. Covered time means a scrim.
    expect(place).toMatchObject({ anchor: "bottom", band: "upper", clear: true });
    expect(place.scrim).toBeGreaterThanOrEqual(0.3);
    const onlyCup = portrait(defaultStyle("music_video"), [CUP], { captions: [{ start: 1, end: 2, text: "Neon rain" }] });
    expect(placeCaptions(onlyCup, layoutFor(onlyCup), metrics(112))).toMatchObject({ anchor: "bottom", band: "lower", offset: 1920 * 0.4, clear: false });
    expect(captionBand(onlyCup)).toBe("lower");
  });

  it("lets a shot with a standing figure take the next clear line while the film keeps its own", () => {
    // A wall of lights (a wide box) for most of the film, the walker in one shot in the middle.
    const lights: SceneClip = { ...WALKER, box: { left: 0.05, top: 0.05, right: 0.75, bottom: 0.6 } };
    const captions = [
      { start: 0.5, end: 2, text: "It holds the heat" },
      { start: 4.2, end: 5.5, text: "keeps the morning warm." },
      { start: 6.5, end: 8, text: "for an hour, and sits" },
    ];
    const s = portrait(defaultStyle("product_ad"), [{ ...lights, start: 0, end: 4 }, { ...WALKER, start: 4, end: 6 }, { ...lights, start: 6, end: 10 }], { captions, duration: 10 });
    const L = layoutFor(s);
    const place = placeCaptions(s, L, { width: 842.4, lineHeight: 71, pad: 25, linesOf: () => 1 });
    // The lights' captions outvote the walker's, so the film keeps the usual line.
    expect(place).toMatchObject({ band: "lower", clear: true });
    expect(place.offset).toBeCloseTo(1920 * 0.32, 6);
    expect(place.lines.map((l) => l.band)).toEqual(["lower", "upper", "lower"]);
    expect(place.lines[1]!.offset).toBeCloseTo(1920 - (0.37 * 1920 - 2 * L.u), 6);
    const html = buildComposition(s, "").html;
    // The walker's caption sits on its own line, the others on the film's.
    expect(html).toMatch(/id="c1" style="visibility:hidden;bottom:[\d.]+px"/);
    expect(html).toContain('id="c0" style="visibility:hidden"');
    // A subject that is not a figure (the cup) never pulls a shot off the film's line.
    const cupped = portrait(defaultStyle("product_ad"), [{ ...lights, start: 0, end: 4 }, { ...CUP, start: 4, end: 6 }, { ...lights, start: 6, end: 10 }], { captions, duration: 10 });
    expect(placeCaptions(cupped, L, { width: 842.4, lineHeight: 71, pad: 25, linesOf: () => 1 }).lines.map((l) => l.band)).toEqual(["lower", "lower", "lower"]);
    // Each figure shot takes the line above its own head: a small walker and a figure that grows to fill the frame
    // get different lines, and the film's line stays where the lights put it.
    const grown: SceneClip = { ...WALKER, box: { left: 0.4, top: 0.2, right: 0.6, bottom: 1 } };
    const two = portrait(
      defaultStyle("product_ad"),
      [{ ...lights, start: 0, end: 4 }, { ...WALKER, start: 4, end: 6 }, { ...grown, start: 6, end: 8 }, { ...lights, start: 8, end: 10 }],
      { captions: [captions[0]!, captions[1]!, { start: 6.2, end: 7.5, text: "for an hour, and sits" }, { start: 8.5, end: 9.8, text: "right in your hand." }], duration: 10 },
    );
    const twoLines = placeCaptions(two, L, { width: 842.4, lineHeight: 71, pad: 25, linesOf: () => 1 }).lines;
    expect(twoLines.map((l) => l.band)).toEqual(["lower", "upper", "upper", "lower"]);
    expect(twoLines[1]!.offset).toBeCloseTo(1920 - (0.37 * 1920 - 2 * L.u), 6);
    expect(twoLines[2]!.offset).toBeCloseTo(1920 - (0.2 * 1920 - 2 * L.u), 6);
    expect(figureLike({ left: 370, right: 678, top: 710, bottom: 1612 }, L)).toBe(true);
    expect(figureLike({ left: 0, right: 1080, top: 96, bottom: 1152 }, L)).toBe(false);
    expect(figureLike({ left: 500, right: 580, top: 900, bottom: 1100 }, L)).toBe(false);
  });

  it("gives chip captions no scrim: the pill is theirs", () => {
    const s = portrait(defaultStyle("product_ad"), [WALKER]);
    const html = buildComposition(s, "").html;
    expect(html).toContain("caps-chip anchor-bottom band-upper");
    expect(html).not.toContain('id="cband"');
  });

  it("keeps letterboxed film subtitles in the bar whatever the subject does", () => {
    const film = scene({ clips: [{ ...WALKER, srcWidth: 1920, srcHeight: 1088 }] });
    expect(buildComposition(film, "").html).toContain("anchor-bar");
    expect(placeCaptions(film, layoutFor(film), metrics(47.7)).band).toBe("bar");
  });
});

describe("keep-out: titles", () => {
  it("stays on its usual line in the band above a centred figure, over a scrim for the bright sky", () => {
    const s = portrait(defaultStyle("cinematic_shot"), [WALKER], { overlays: [{ id: "t", kind: "title", start: 0.6, end: 3.5, text: "After the Rain", subtext: "A film by Nightshift" }] });
    const L = layoutFor(s);
    const place = placeTitle(s, L, { start: 0.6, end: 3.5 }, 150, { upper: 0.27 * 1920, lower: 0.56 * 1920 }, [], 0.18);
    expect(place).toMatchObject({ band: "upper", centre: 0.27 * 1920, clear: true });
    expect(place.scrim).toBeCloseTo(0.45, 6);
    const html = buildComposition(s, "").html;
    expect(html).toMatch(/class="title title-cine band-upper" id="o0" style="top:518.4px"><div class="band" id="o0g"/);
    // Weight 600 and a full-width band, not a thin 500 with a radial glow.
    expect(html).toContain(".title-cine .t1{font-weight:600");
    expect(html).toContain(".title-cine .band,.title-in .band{left:-64.8px;right:-129.6px;top:-70%;bottom:-70%}");
  });

  it("moves up its band to sit above captions that share it", () => {
    const s = portrait(defaultStyle("talking_intro"), [WALKER]);
    const L = layoutFor(s);
    const captions = { left: 100, right: 980, top: 560, bottom: 700 };
    const place = placeTitle(s, L, { start: 0.3, end: 3 }, 200, { upper: 0.27 * 1920, lower: 0.56 * 1920 }, [captions]);
    expect(place.band).toBe("upper");
    expect(place.centre + 100).toBeCloseTo(560 - 2 * L.u, 5);
  });

  it("prefers the larger clear band, and the lower one on a near tie", () => {
    const L = layoutFor(scene());
    const low = scene({ clips: [{ ...WALKER, srcWidth: 1920, srcHeight: 1088, box: { left: 0.4, top: 0.6, right: 0.6, bottom: 0.95 } }] });
    expect(placeTitle(low, L, { start: 0, end: 3 }, 100, { upper: 300, lower: 800 }).band).toBe("upper");
    const high = scene({ clips: [{ ...WALKER, srcWidth: 1920, srcHeight: 1088, box: { left: 0.4, top: 0.05, right: 0.6, bottom: 0.4 } }] });
    expect(placeTitle(high, L, { start: 0, end: 3 }, 100, { upper: 300, lower: 800 }).band).toBe("lower");
    expect(placeTitle(scene(), L, { start: 0, end: 3 }, 100, { upper: 300, lower: 800 }).band).toBe("lower");
  });

  it("takes the lower band over a scrim when neither band has room", () => {
    const s = portrait(defaultStyle("cinematic_shot"), [CUP]);
    const place = placeTitle(s, layoutFor(s), { start: 0, end: 3 }, 150, { upper: 500, lower: 1075 }, [], 0.18);
    expect(place).toMatchObject({ band: "lower", centre: 1075, clear: false });
    expect(place.scrim).toBeGreaterThanOrEqual(0.35);
    expect(buildComposition(s, "").html).toContain('class="title title-cine band-lower covered"');
  });
});

describe("keep-out: name tag and corner cards", () => {
  const tag = (o = {}) => ({ id: "speaker", kind: "lower_third" as const, start: 1, end: 5, text: "Ava Chen", subtext: "Filmmaker, Nightshift", ...o });
  const metrics = { width: 520, minWidth: 300, heightAt: (w: number) => (w < 520 ? 180 : 146), fade: 27.648 };

  it("keeps its usual spot and full width when the subject is off to one side", () => {
    const aside = { ...WALKER, subject: { x: 0.8, y: 0.54 }, box: { left: 0.73, top: 0.37, right: 0.86, bottom: 0.84 } };
    const s = portrait(defaultStyle("talking_intro"), [aside], { overlays: [tag()] });
    const L = layoutFor(s);
    const place = placeNameTag(s, L, { start: 1, end: 5 }, metrics);
    expect(place).toMatchObject({ side: "left", maxWidth: 520, clear: true });
    expect(place.bottom).toBeCloseTo(1920 * 0.23, 6);
    const html = buildComposition(s, "").html;
    expect(html).toContain(`class="lt side-left" id="o0" style="bottom:${1920 * 0.23}px;left:${1080 * SAFE_AREA.portrait.left}px;`);
    // Nothing of it, not even its backdrop, shows before it starts.
    const visible = tracksOf(html).find(([id, prop]) => id === "o0" && prop === "opacity")![2];
    expect(visible.slice(0, 2)).toEqual([[0, 0, "step-end"], [1000, 1]]);
  });

  it("narrows to the free side beside a centred figure, so the role wraps instead of crossing the coat", () => {
    const s = portrait(defaultStyle("talking_intro"), [WALKER], { overlays: [tag()] });
    const L = layoutFor(s);
    // The column beside the figure, plus the tag's transparent run-out, which may reach into the gap.
    const column = sideWidth(s, L, 1.2, "left") + metrics.fade;
    expect(column).toBeGreaterThan(300);
    expect(column).toBeLessThan(520);
    const place = placeNameTag(s, L, { start: 1, end: 5 }, metrics);
    expect(place).toMatchObject({ side: "left", clear: true });
    expect(place.bottom).toBeCloseTo(1920 * 0.23, 6);
    expect(place.maxWidth).toBeCloseTo(column, 6);
    const html = buildComposition(s, "").html;
    expect(html).toMatch(new RegExp(`class="lt side-left" id="o0" style="bottom:441.6px;left:64.8px;max-width:${px3(column)}px`));
    // The name shrinks a touch to stay on one line in that column, never below 86%.
    const name = Number(html.match(/class="lt-name" style="font-size:([0-9.]+)px/)![1]);
    expect(name).toBeLessThan(4.4 * L.t);
    expect(name).toBeGreaterThanOrEqual(4.4 * L.t * 0.86);
  });

  it("takes the band below the subject when no side is free, then the band above its head", () => {
    const wide = { ...WALKER, box: { left: 0.1, top: 0.3, right: 0.9, bottom: 0.6 } };
    const s = portrait(defaultStyle("talking_intro"), [wide], { overlays: [tag()] });
    const L = layoutFor(s);
    const below = placeNameTag(s, L, { start: 1, end: 5 }, metrics);
    expect(below).toMatchObject({ maxWidth: 520, clear: true });
    expect(below.bottom).toBeCloseTo(1920 * 0.23, 6);
    // Captions on the lower lines leave no room under it: the tag goes just above the head instead.
    const captions = { left: 100, right: 980, top: 1180, bottom: 1500 };
    const above = placeNameTag(s, L, { start: 1, end: 5 }, metrics, [captions]);
    expect(above.clear).toBe(true);
    expect(1920 - above.bottom).toBeCloseTo(0.3 * 1920 - 2 * L.u, 5);
  });

  it("keeps its spot over a stronger gradient when nothing is clear", () => {
    const s = portrait(defaultStyle("talking_intro"), [CUP], { overlays: [tag()] });
    const place = placeNameTag(s, layoutFor(s), { start: 1, end: 5 }, metrics);
    expect(place).toMatchObject({ clear: false, scrim: 0.62 });
    expect(place.bottom).toBeCloseTo(1920 * 0.23, 6);
    expect(buildComposition(s, "").html).toContain('class="lt side-left covered"');
  });

  it("stacks the song title beside a centred figure and fits the artist line to the same width", () => {
    const s = portrait(defaultStyle("music_video"), [WALKER], { overlays: [{ id: "song", kind: "title", start: 0, end: 3, text: "Neon Rain", subtext: "Nightshift Demo" }] });
    const L = layoutFor(s);
    const free = sideWidth(s, L, 0.3, "left");
    const html = buildComposition(s, "").html;
    expect(html).toMatch(new RegExp(`class="title title-mv side-left" id="o0" style="bottom:[0-9.]+px;left:64.8px;max-width:${px3(free)}px"`));
    // Each word of the title fits the column (shrinking a little, never under three quarters) and the artist line fits on one line.
    const title = Number(html.match(/class="t1" id="o0a" style="font-size:([0-9.]+)px/)![1]);
    expect(title).toBeLessThan(118.8);
    expect(title).toBeGreaterThanOrEqual(118.8 * 0.75);
    const artist = Number(html.match(/class="t2" id="o0b" style="font-size:([0-9.]+)px/)![1]);
    expect(artist).toBeLessThan(2.2 * L.t);
    expect(artist).toBeGreaterThanOrEqual(2.2 * L.t * 0.72);
  });

  it("keeps the product name in its corner over a scrim when the product fills the frame", () => {
    const s = portrait(defaultStyle("product_ad"), [CUP], { overlays: [{ id: "name", kind: "title", start: 0, end: 3, text: "Ember", subtext: "Keeps the morning warm" }] });
    const html = buildComposition(s, "").html;
    expect(html).toContain('class="title title-ad side-left covered"');
    expect(html).toContain('<div class="band" id="o0g"');
    const beside = portrait(defaultStyle("product_ad"), [{ ...WALKER, subject: { x: 0.2, y: 0.5 }, box: { left: 0.14, top: 0.1, right: 0.26, bottom: 0.9 } }], { overlays: [{ id: "name", kind: "title", start: 0, end: 3, text: "Ember" }] });
    expect(buildComposition(beside, "").html).toContain('class="title title-ad side-right" id="o0"');
  });
});

describe("objectPosition", () => {
  it("centres the crop on the focus point and clamps at the edges", () => {
    const clip = { srcWidth: 1920, srcHeight: 1080, focus: { x: 0.5, y: 0.5 } };
    expect(objectPosition(clip, 1080, 1920)).toBe("50% 50%");
    // A 607.5 px wide window of 1920: its left edge at 0.2 * 1920 - 303.75 = 80.25 of 1312.5 px of slack.
    expect(objectPosition({ ...clip, focus: { x: 0.2, y: 0.5 } }, 1080, 1920)).toBe("6.114% 50%");
    expect(objectPosition({ ...clip, focus: { x: 0, y: 0.5 } }, 1080, 1920)).toBe("0% 50%");
    expect(objectPosition({ ...clip, focus: { x: 1, y: 0.5 } }, 1080, 1920)).toBe("100% 50%");
  });
});

describe("Tracks", () => {
  it("sorts keyframes by time and keeps insertion order for equal times", () => {
    const t = new Tracks().add("a", "opacity", 2, 1).add("a", "opacity", 1, 0, "step-end").add("a", "opacity", 1, 1);
    expect(t.toJSON()).toEqual([["a", "opacity", [[1000, 0, "step-end"], [1000, 1], [2000, 1]]]]);
  });

  it("scales fades down to fit a short window", () => {
    const kf = new Tracks().window("a", 0, 1, 1, 1).toJSON()[0]![2];
    expect(kf.map((k) => k[0])).toEqual([0, 500, 500, 1000]);
  });
});
