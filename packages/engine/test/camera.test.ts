import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { quickMoves } from "@nightshift/contract";
import { cameraPose, cameraPoints, cameraFrame, cameraBasis } from "../src/comfy/camera.js";
import { bindWorkflow } from "../src/comfy/bind.js";
import { defaultWorkflowsDir } from "../src/paths.js";
import { cameraPrompt } from "../src/projects/camera-move.js";

const moves = quickMoves.map((m) => m.id);
describe("camera paths", () => {
  it("starts every path at the source camera, with no lens jump", () => {
    for (const move of moves) expect(cameraPose(move, 0)).toEqual({ x: 0, y: 0, z: 0, targetX: 0, targetY: 0, targetZ: 3, zoom: 1, shiftX: 0, shiftY: 0 });
  });
  it("makes forward moves obvious, with the stronger push arriving sooner", () => {
    const scale = (move: string, t: number) => 3 / (3 - cameraPose(move, t).z);
    expect(scale("dolly_in", 1)).toBeGreaterThanOrEqual(1.8);
    expect(scale("push_in", 0.75)).toBeGreaterThan(2);
    expect(scale("push_in", 0.5)).toBeGreaterThan(scale("dolly_in", 0.5));
    expect(scale("pull_back", 1)).toBeLessThan(0.6);
  });
  it("aims the snappy optical zoom at the depth subject without a first-frame jump", () => {
    const subject = { x: 0.4, y: 0.3, z: 2.5 };
    expect(cameraPose("crash_zoom", 0, subject)).toEqual(cameraPose("crash_zoom", 0));
    const p = cameraPose("crash_zoom", 0.34, subject);
    expect(p.zoom).toBeCloseTo(2.8);
    expect(subject.x / subject.z * p.zoom + p.shiftX).toBeCloseTo(0);
    expect(subject.y / subject.z * p.zoom + p.shiftY).toBeCloseTo(0);
    expect(cameraPose("crash_zoom", 0.14, subject).zoom).toBe(1);
  });
  it("moves in the named direction", () => {
    expect(cameraPose("dolly_in", 1).z).toBeGreaterThan(0);
    expect(cameraPose("pull_back", 1).z).toBeLessThan(0);
    expect(cameraPose("crane_up", 1).y).toBeGreaterThan(0);
  });
  it("keeps the look-at basis orthonormal throughout every move", () => {
    const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, v, i) => sum + v * b[i]!, 0);
    for (const move of moves) for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const { forward, right, up } = cameraBasis(cameraPose(move, t));
      expect(dot(forward, up)).toBeCloseTo(0);
      expect(dot(right, up)).toBeCloseTo(0);
      expect(dot(forward, right)).toBeCloseTo(0);
      expect(dot(up, up)).toBeCloseTo(1);
    }
  });
  it("compensates dolly-zoom magnification at the focus plane", () => {
    for (const t of [0, 0.3, 0.7, 1]) {
      const p = cameraPose("dolly_zoom", t);
      expect(p.zoom / (3 - p.z)).toBeCloseTo(1 / 3);
    }
  });
  it("holds an off-centre subject during the dolly zoom and enlarges the distant background", () => {
    const subject = { x: 0.6, y: -0.2, z: 2.4 };
    for (const t of [0, 0.3, 0.7, 1]) {
      const p = cameraPose("dolly_zoom", t, subject);
      expect(p.zoom / (subject.z - p.z)).toBeCloseTo(1 / subject.z);
      expect((subject.x - p.x) * p.zoom / (subject.z - p.z)).toBeCloseTo(subject.x / subject.z);
      expect((subject.y - p.y) * p.zoom / (subject.z - p.z)).toBeCloseTo(subject.y / subject.z);
    }
    const p = cameraPose("dolly_zoom", 1, subject);
    expect(p.zoom * 12 / (12 - p.z)).toBeGreaterThan(2);
  });
  it("names every move in the model prompt", () => {
    for (const move of quickMoves) expect(cameraPrompt("A clay bowl.", move.id)).toContain(`Camera movement: ${move.label}.`);
  });
  it("focuses the centre subject rather than a larger background", () => {
    const depth = new Uint8Array(10 * 10 * 3).fill(20);
    for (let y = 4; y < 6; y++) for (let x = 4; x < 6; x++) depth.fill(200, (y * 10 + x) * 3, (y * 10 + x + 1) * 3);
    const points = cameraPoints(depth, depth, 10, 10);
    expect(points.xyz[(4 * 10 + 4) * 3 + 2]).toBeCloseTo(3);
    expect(points.xyz[2]).toBeGreaterThan(3);
  });
  it("finds an off-centre depth subject and ignores a landscape's near bottom edge", () => {
    const width = 100, height = 100;
    const depth = new Uint8Array(width * height * 3).fill(10);
    for (let y = 15; y < 65; y++) for (let x = 55; x < 80; x++) depth.fill(200, (y * width + x) * 3, (y * width + x + 1) * 3);
    const { subject } = cameraPoints(depth, depth, width, height);
    expect(subject.x).toBeGreaterThan(0);
    expect(subject.y).toBeGreaterThan(0);
    depth.fill(10);
    depth.fill(255, width * 80 * 3);
    expect(cameraPoints(depth, depth, width, height).subject).toEqual({ x: 0, y: 0, z: 3 });
  });
  it("aims at a product above a sloping table, rather than the nearer table", () => {
    const width = 100, height = 100;
    const depth = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const d = y < 45 ? 5 : 40 + (y - 45) * 4;
      depth.fill(x >= 43 && x < 57 && y >= 30 && y < 60 ? 130 : d, (y * width + x) * 3, (y * width + x + 1) * 3);
    }
    const points = cameraPoints(depth, depth, width, height);
    const screenY = (height - 1) / 2 - points.subject.y / points.subject.z * points.focal;
    expect(screenY).toBeGreaterThan(30);
    expect(screenY).toBeLessThan(55);
  });
  it("rejects unknown presets rather than silently giving the wrong move", () => {
    expect(() => cameraPose("misspelled", 0)).toThrow("Unknown camera move");
  });
  it("keeps an asymmetric photo upright and aligned at the opening frame", () => {
    const width = 13, height = 9;
    const depth = Uint8Array.from({ length: width * height * 3 }, (_, i) => 30 + Math.floor(i / 3) % 200);
    const photo = Uint8Array.from({ length: depth.length }, (_, i) => i % 256);
    const points = cameraPoints(depth, photo, width, height);
    const frame = cameraFrame(points, width, height, cameraPose("crane_up", 0));
    for (let i = 0; i < points.shade.length; i++) {
      expect(Array.from(frame.subarray(i * 3, i * 3 + 3))).toEqual(Array(3).fill(points.shade[i]));
    }
  });
  it("reprojects the source camera without gaps and binds both media inputs as files", () => {
    const dir = defaultWorkflowsDir();
    const g = JSON.parse(readFileSync(join(dir, "camera_layout.api.json"), "utf8"));
    const r = JSON.parse(readFileSync(join(dir, "camera_layout.api.ref.json"), "utf8"));
    const bound = bindWorkflow(g, r, { frames: 17, width: 384, height: 640, move: "dolly_in", image: "/photo.png" });
    expect(bound.applied.frames).toBe(17);
    expect(bound.files[0]!.path).toBe("/photo.png");
    const depth = new Uint8Array(8 * 8 * 3).fill(128);
    const points = cameraPoints(depth, depth, 8, 8);
    const frame = cameraFrame(points, 8, 8, cameraPose("dolly_in", 0));
    expect(new Set(frame).size).toBe(1);
    expect(frame[0]).toBeGreaterThan(95);
    const video = JSON.parse(readFileSync(join(dir, "camera_move_ltx.api.json"), "utf8"));
    const ref = JSON.parse(readFileSync(join(dir, "camera_move_ltx.api.ref.json"), "utf8"));
    expect(bindWorkflow(video, ref, { image: "/photo.png", layout: "/layout.mp4" }).files.map((f) => f.name)).toEqual(["image", "layout"]);
    // Core AddGuide uses negative indices for the last frame, which would force the shot back to its start.
    expect(video.reference.inputs.frame_idx).toBe(0);
  });
});
