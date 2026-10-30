/** The pure pieces between engine and editor: sizes from workflows, edit detection, brief and style translation. */
import type { Project, Timeline, WorkflowRef } from "@nightshift/contract";
import { resolveStyle } from "@nightshift/editor";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { graphDefault, sizeForAspect, sizeForRatio, sizeGrid, type Graph } from "../src/comfy/bind.js";
import { defaultWorkflowsDir } from "../src/paths.js";
import { editorProject, editorStyle } from "../src/projects/editor.js";
import { isDefaultCut, patchedTimeline, withRevision } from "../src/projects/timeline.js";

const NOW = "2026-10-19T00:00:00.000Z";
const load = (name: string) => JSON.parse(readFileSync(join(defaultWorkflowsDir(), name), "utf8")) as Graph;
const refOf = (name: string) => JSON.parse(readFileSync(join(defaultWorkflowsDir(), name.replace(".api.json", ".api.ref.json")), "utf8")) as WorkflowRef;

describe("sizes from the workflows", () => {
  it("reads a mapped field's own value, or the Primitive node wired to it", () => {
    const ltx = "ltx25_draft.api.json";
    expect([graphDefault(load(ltx), refOf(ltx), "width"), graphDefault(load(ltx), refOf(ltx), "height"), graphDefault(load(ltx), refOf(ltx), "fps")]).toEqual([640, 384, 24]);
    expect(graphDefault(load(ltx), refOf(ltx), "negative")).toBe("cartoon, video game, text, cuts, black frames");
    const krea = "krea2_turbo_bf16.api.json";
    expect([graphDefault(load(krea), refOf(krea), "width"), graphDefault(load(krea), refOf(krea), "height")]).toEqual([768, 768]);
    // Not an input of this workflow, or wired to a computed value: no default.
    expect(graphDefault(load(ltx), refOf(ltx), "latent")).toBeUndefined();
    expect(graphDefault(load(ltx), refOf(ltx), "image")).toBe("first_frame.png");
  });

  it("keeps the measured size for its orientation, swaps it for the other, squares it on the same grid", () => {
    expect(sizeGrid(640, 384)).toBe(64);
    expect(sizeGrid(608, 352)).toBe(32);
    expect(sizeGrid(1280, 720)).toBe(16);
    expect(sizeForAspect(640, 384, "16:9")).toEqual({ width: 640, height: 384 });
    expect(sizeForAspect(640, 384, "9:16")).toEqual({ width: 384, height: 640 });
    expect(sizeForAspect(640, 384, "1:1")).toEqual({ width: 512, height: 512 }); // 6.7% more pixels, the nearest square
    expect(sizeForAspect(608, 352, "1:1")).toEqual({ width: 448, height: 448 });
    expect(sizeForAspect(384, 640, "16:9")).toEqual({ width: 640, height: 384 }); // a portrait base swaps the other way
    expect(sizeForAspect(768, 768, "9:16")).toEqual({ width: 576, height: 1024 }); // a square base takes the aspect's shape
    for (const [w, h] of [[640, 384], [608, 352], [384, 256], [960, 544]] as const) {
      const sq = sizeForAspect(w, h, "1:1");
      expect(sq.width * sq.height).toBeLessThanOrEqual(w * h * 1.1);
    }
  });

  it("a still takes its draft's shape at its own pixel count", () => {
    expect(sizeForRatio(768, 768, 640 / 384)).toEqual({ width: 960, height: 576 });
    expect(sizeForRatio(768, 768, 384 / 640)).toEqual({ width: 576, height: 960 });
    expect(sizeForRatio(768, 768, 384 / 256)).toEqual({ width: 960, height: 640 });
  });
});

function project(extra: Partial<Project> = {}): Project {
  return {
    id: "p",
    name: "Lumen ad",
    template: "product_ad",
    aspect: "9:16",
    brief: { productName: "Lumen", does: "follows the sun", tone: "warm", referenceAssetId: "photo" },
    shots: [
      { id: "s0", index: 0, prompt: "", durationSec: 3, locked: false, stillAssetId: "a0", line: "This is Lumen." },
      { id: "s1", index: 1, prompt: "", durationSec: 2, locked: false, chosenDraftId: "t1", line: "It follows the sun." },
    ],
    takes: [{ id: "t1", shotId: "s1", rung: "draft", seed: 1, videoAssetId: "v1", jobId: "j" }],
    assets: [
      { id: "a0", kind: "image", path: "assets/a0.png", createdAt: NOW },
      { id: "v1", kind: "video", path: "assets/v1.mp4", createdAt: NOW },
      { id: "photo", kind: "image", path: "assets/photo.png", role: "reference", createdAt: NOW },
    ],
    timeline: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

const plainClips: Timeline["clips"] = [
  { shotId: "s0", assetId: "a0", start: 0, in: 0, out: 3 },
  { shotId: "s1", assetId: "v1", start: 3, in: 0, out: 2 },
];
const cut: Timeline = { clips: [{ shotId: "s0", assetId: "a0", start: 0, in: 0, out: 2.4 }, { shotId: "s1", assetId: "v1", start: 2.4, in: 0, out: 2.6 }], audio: [], captions: [], style: { look: "product_ad" } };

describe("what counts as a hand edit", () => {
  it("the plain shot cut, an unchanged cut, and style changes are not edits", () => {
    const p = project({ timeline: cut });
    expect(isDefaultCut(p, plainClips)).toBe(true);
    expect(patchedTimeline(p, { ...cut, clips: plainClips }).edited).toBeUndefined();
    expect(patchedTimeline(p, cut).edited).toBeUndefined();
    expect(patchedTimeline(p, { ...cut, style: { captionLook: "boxed" } }).edited).toBeUndefined();
  });

  it("trims, reorders, other pictures, gains, and caption or overlay changes are", () => {
    const p = project({ timeline: cut });
    expect(patchedTimeline(p, { ...cut, clips: [{ ...plainClips[0]!, out: 1 }, plainClips[1]!] }).edited).toBe(true);
    expect(patchedTimeline(p, { ...cut, clips: [plainClips[1]!, plainClips[0]!] }).edited).toBe(true);
    expect(patchedTimeline(p, { ...cut, clips: [{ ...plainClips[0]!, assetId: "photo" }, plainClips[1]!] }).edited).toBe(true);
    expect(patchedTimeline(p, { ...cut, clips: [plainClips[0]!, { ...plainClips[1]!, gain: 0.5 }] }).edited).toBe(true);
    expect(patchedTimeline(p, { ...cut, captions: [{ start: 0, end: 1, text: "Hi" }] }).edited).toBe(true);
    expect(patchedTimeline(p, { ...cut, overlays: [] }).edited).toBeUndefined(); // [] and absent are the same
  });

  it("an edit stays an edit until it is handed back", () => {
    const p = project({ timeline: { ...cut, edited: true } });
    expect(patchedTimeline(p, { ...cut, clips: plainClips }).edited).toBe(true);
    expect(patchedTimeline(p, { ...cut, edited: false }).edited).toBeUndefined();
  });
});

describe("a PATCH that crosses an engine re-cut", () => {
  // The UI read revision 1. The engine cut again (a new draft for s0) and stored revision 2 before the PATCH arrived.
  const v1: Timeline = { ...cut, revision: 1 };
  const v2: Timeline = { ...cut, clips: [{ ...cut.clips[0]!, assetId: "v0", out: 2.5 }, { ...cut.clips[1]!, start: 2.5 }], revision: 2 };
  const recut = () => project({ timeline: v2, assets: [...project().assets, { id: "v0", kind: "video", path: "assets/v0.mp4", createdAt: NOW }] });
  const known = [v2, v1];

  it("is judged against the cut it was read from: unchanged there means no hand edit, and the newer cut stays", () => {
    const out = patchedTimeline(recut(), { ...v1, style: { look: "product_ad", captionLook: "boxed" } }, known);
    expect(out.edited).toBeUndefined();
    expect(out.clips).toEqual(v2.clips);
    expect(out.style).toEqual({ look: "product_ad", captionLook: "boxed" });
    // Before revisions, the same PATCH was read against the stored cut and froze the old one as a hand edit.
    expect(patchedTimeline(recut(), { ...cut, style: { captionLook: "boxed" } }, [v2]).edited).toBe(true);
  });

  it("without a revision it is matched against the cuts the engine remembers", () => {
    const { revision: _, ...noRevision } = v1;
    const out = patchedTimeline(recut(), { ...noRevision, style: { captionLook: "boxed" } }, known);
    expect(out.edited).toBeUndefined();
    expect(out.clips).toEqual(v2.clips);
  });

  it("the plain cut mirrored from an old copy is no edit either", () => {
    expect(patchedTimeline(recut(), { ...v1, clips: plainClips }, known)).toMatchObject({ clips: v2.clips });
  });

  it("a real hand edit on an old copy is still an edit, and wins", () => {
    const trimmed = [{ ...v1.clips[0]!, out: 1 }, v1.clips[1]!];
    const out = patchedTimeline(recut(), { ...v1, clips: trimmed }, known);
    expect(out).toMatchObject({ edited: true, clips: trimmed });
  });

  it("an old copy's edited flag is an echo, not a request: a timeline handed back since stays the engine's", () => {
    // Revision 1 was edited; it was handed back (2) and cut again (3). A PATCH read at 1 carries edited: true.
    const e1: Timeline = { ...cut, clips: [{ ...cut.clips[0]!, out: 1 }, cut.clips[1]!], edited: true, revision: 1 };
    const v3: Timeline = { ...v2, revision: 3 };
    const p = project({ timeline: v3, assets: recut().assets });
    const out = patchedTimeline(p, { ...e1, style: { captionLook: "serif" } }, [v3, { ...cut, revision: 2 }, e1]);
    expect(out.edited).toBeUndefined();
    expect(out.clips).toEqual(v3.clips);
    // Read at the current revision, an explicit edited: true still marks it.
    expect(patchedTimeline(p, { ...v3, edited: true }, [v3]).edited).toBe(true);
  });

  it("revisions count stored changes and never go back", () => {
    expect(withRevision(null, cut)?.revision).toBe(1);
    expect(withRevision(v2, { ...v2, revision: 99 })?.revision).toBe(2); // unchanged: the engine's number stays
    expect(withRevision(v2, { ...v2, style: { look: "x" } })?.revision).toBe(3);
    expect(withRevision(null, cut, 7)?.revision).toBe(8); // after a timeline set to null
    expect(withRevision(v2, null)).toBeNull();
  });
});

describe("the project as the editor reads it", () => {
  it("product ad: the uploaded photo is the end card's, what it does is the tagline, the shot lines are the script", () => {
    const view = editorProject(project());
    expect(view.brief).toMatchObject({ productImageAssetId: "photo", tagline: "Follows the sun", script: "This is Lumen. It follows the sun." });
    expect(editorProject(project({ brief: { productName: "Lumen", tagline: "Light that moves", script: "Own words." } })).brief).toMatchObject({ tagline: "Light that moves", script: "Own words." });
  });

  it("music video: the form's length is how long the cut runs", () => {
    expect(editorProject(project({ template: "music_video", brief: { length: "60" } })).brief.durationSec).toBe(60);
  });

  it("the UI's caption settings become the editor's style, and nothing invalid reaches it", () => {
    expect(editorStyle("product_ad", { captions: false, captionLook: "serif", captionPos: "center", captionSize: 1.4, look: "product_ad" })).toEqual({
      look: "product_ad",
      captions: { enabled: false, look: "subtitle", position: "middle", size: 1.4 },
    });
    expect(editorStyle("music_video", { captionLook: "boxed", captionPos: "bottom" }).captions).toEqual({ look: "chip", position: "lower" });
    expect(editorStyle("talking_intro", { captionLook: "lyrics" }).captions).toEqual({ look: "kinetic" });
    expect(editorStyle("product_ad", { captionLook: "clean" }).captions).toEqual({ look: "karaoke" });
    for (const template of ["cinematic_shot", "music_video", "product_ad", "talking_intro"] as const) {
      const { warnings } = resolveStyle(template, editorStyle(template, { captions: true, captionLook: "clean", captionPos: "bottom", captionSize: 9 }));
      expect(warnings).toEqual([]);
      expect(resolveStyle(template, editorStyle(template, { captionLook: "lyrics" })).warnings).toEqual([]);
    }
  });
});
