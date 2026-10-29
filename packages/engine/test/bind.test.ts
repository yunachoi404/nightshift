import type { WorkflowRef } from "@nightshift/contract";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BindError, bindWorkflow, floorFrames, frameCount, frameRule, H3_FRAMES, kindFromFilename, LTX_FRAMES, sizeForAspect, type Graph } from "../src/comfy/bind.js";
import { defaultWorkflowsDir } from "../src/paths.js";

const l2r = JSON.parse(readFileSync(join(defaultWorkflowsDir(), "layout_to_render.api.json"), "utf8")) as Graph;

const ref: WorkflowRef = {
  workflow: "layout_to_render.api.json",
  inputs: {
    prompt: { node: "5508", field: "value" },
    seed: { node: "5516:4832", field: "noise_seed" },
    image: { node: "9009", field: "image" },
    video: { node: "5001", field: "file" },
    width: { node: "5548:5026", field: "resize_type.shorter_size" },
  },
  params: { width: 544, "4852.filename_prefix": "ohf/test", "5004:5602.weight_dtype": "fp8_e4m3fn", fps: 24 },
  outputNodes: ["4852"],
};

describe("bindWorkflow", () => {
  it("fills named inputs, applies params, and never touches the source graph", () => {
    const before = JSON.stringify(l2r);
    const b = bindWorkflow(l2r, ref, { prompt: "a rainy street", seed: 7 });
    expect(b.graph["5508"]!.inputs.value).toBe("a rainy street");
    expect(b.graph["5516:4832"]!.inputs.noise_seed).toBe(7);
    expect(b.graph["5548:5026"]!.inputs["resize_type.shorter_size"]).toBe(544); // param default for a named input
    expect(b.graph["4852"]!.inputs.filename_prefix).toBe("ohf/test"); // node.field param
    expect(b.graph["5004:5602"]!.inputs.weight_dtype).toBe("fp8_e4m3fn"); // node id with a colon
    expect(b.applied).toEqual({ width: 544, prompt: "a rainy street", seed: 7 });
    expect(JSON.stringify(l2r)).toBe(before);
  });

  it("explicit values beat params; values the workflow does not take are ignored", () => {
    const b = bindWorkflow(l2r, ref, { width: 768, durationSec: 4, lyrics: "la la" });
    expect(b.graph["5548:5026"]!.inputs["resize_type.shorter_size"]).toBe(768);
    expect(b.applied).toEqual({ width: 768 });
  });

  it("file inputs become file bindings for the SDK to upload", () => {
    const b = bindWorkflow(l2r, ref, { image: "/tmp/first.png", video: "/tmp/layout.mp4" });
    expect(b.files).toEqual([
      { name: "image", node: "9009", field: "image", path: "/tmp/first.png" },
      { name: "video", node: "5001", field: "file", path: "/tmp/layout.mp4" },
    ]);
  });

  it("null and undefined values leave the default alone", () => {
    const b = bindWorkflow(l2r, ref, { prompt: undefined, seed: null });
    expect(b.graph["5508"]!.inputs.value).toBe(l2r["5508"]!.inputs.value);
  });

  it("rejects a mapping to a node that is not in the graph, and a non-path file", () => {
    expect(() => bindWorkflow(l2r, { ...ref, inputs: { prompt: { node: "nope", field: "text" } } }, { prompt: "x" })).toThrow(BindError);
    expect(() => bindWorkflow(l2r, { ...ref, params: { "nope.text": 1 } }, {})).toThrow(/node nope/);
    expect(() => bindWorkflow(l2r, ref, { image: 42 })).toThrow(/file path/);
  });
});

describe("helpers", () => {
  it("frame counts are 8n+1 and respect maxFrames", () => {
    expect(frameCount(4, 24)).toBe(97);
    expect(frameCount(5, 24)).toBe(121);
    expect(frameCount(0.1, 24)).toBe(9);
    expect(frameCount(10, 24, 121)).toBe(121);
    expect(frameCount(10, 24, 100)).toBe(97);
    for (const f of [frameCount(3.3, 25), frameCount(7, 30)]) expect((f - 1) % 8).toBe(0);
    // Never shorter than the shot: 4.1 s at 24 fps is 98.4 frames, so 105, not 97.
    expect(frameCount(4.1, 24)).toBe(105);
    expect(frameCount(97 / 24, 24)).toBe(97);
  });

  it("MiniMax H3 takes 17k+5 frames, as its template computes them", () => {
    // The upstream template: max(5, round(s * 24)), rounded up to the next 17k+5.
    const template = (s: number) => {
      const n = Math.max(5, Math.round(s * 24));
      return n + ((5 - (n % 17)) % 17 + 17) % 17;
    };
    for (const s of [1, 2.5, 4, 4.04, 5]) expect(frameCount(s, 24, undefined, H3_FRAMES)).toBe(template(s));
    expect(frameCount(4.04, 24, 124, H3_FRAMES)).toBe(107); // a 97-frame LTX draft, remastered
    expect(frameCount(10, 24, 124, H3_FRAMES)).toBe(124);
    expect(frameCount(0.1, 24, undefined, H3_FRAMES)).toBe(22);
    expect(floorFrames(130, H3_FRAMES)).toBe(124);
    expect(floorFrames(100, LTX_FRAMES)).toBe(97);
  });

  it("each video workflow's grid and measured limit come from its model", () => {
    const rule = (name: string) => frameRule(JSON.parse(readFileSync(join(defaultWorkflowsDir(), name), "utf8")) as Graph);
    expect(rule("ltx25_draft.api.json")).toEqual({ grid: LTX_FRAMES, maxFrames: 97 });
    expect(rule("ltx25_same_take.api.json")).toEqual({ grid: LTX_FRAMES, maxFrames: 97 });
    expect(rule("h3_ref2va_4step.api.json")).toEqual({ grid: H3_FRAMES, maxFrames: 124 });
    expect(rule("h3_ref2va_final.api.json")).toEqual({ grid: H3_FRAMES, maxFrames: 124 });
    // Kandinsky 6 Lite is unmeasured: no limit until the model lab sets maxFrames.
    expect(rule("kandinsky6_lite_draft.api.json")).toEqual({ grid: LTX_FRAMES });
    expect(frameRule(undefined)).toEqual({ grid: LTX_FRAMES });
  });

  it("sizes per aspect", () => {
    expect(sizeForAspect(960, 544, "16:9")).toEqual({ width: 960, height: 544 });
    expect(sizeForAspect(1280, 720, "16:9")).toEqual({ width: 1280, height: 720 });
    expect(sizeForAspect(960, 544, "9:16")).toEqual({ width: 544, height: 960 });
    expect(sizeForAspect(960, 544, "1:1")).toEqual({ width: 736, height: 736 });
  });

  it("output kind from the file name (SaveVideo arrives typed image)", () => {
    expect(kindFromFilename("ohf/layout_to_render_00001_.mp4")).toBe("video");
    expect(kindFromFilename("echo_00003_.png")).toBe("image");
    expect(kindFromFilename("draft_00001_.latent")).toBe("latent");
    expect(kindFromFilename("song.FLAC")).toBe("audio");
    expect(kindFromFilename("shots.json")).toBe("text");
    expect(kindFromFilename("weights.safetensors")).toBeUndefined();
  });
});
