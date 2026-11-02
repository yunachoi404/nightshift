import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { quickMoves } from "@nightshift/contract";
import { DOLLY_ZOOM_BACK, DOLLY_ZOOM_CRACK_PX, DOLLY_ZOOM_GROWTH, cameraPose, cameraPoints, cameraFrame, cameraBasis, dollyZoomPoints, dollyZoomStretch } from "../src/comfy/camera.js";
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
  it("holds the whole plane of an off-centre subject during the dolly zoom and grows the background out from it", () => {
    const subject = { x: 0.6, y: -0.2, z: 2.4 };
    // Where a point lands, in focal units from the centre: what cameraFrame draws.
    const screen = (p: ReturnType<typeof cameraPose>, x: number, y: number, z: number) => [(x - p.x) * p.zoom / (z - p.z) + p.shiftX, (y - p.y) * p.zoom / (z - p.z) + p.shiftY];
    for (const t of [0, 0.3, 0.7, 1]) {
      const p = cameraPose("dolly_zoom", t, subject);
      // The camera faces ahead: no turn, only a lens shift.
      expect([p.targetX - p.x, p.targetY - p.y, p.targetZ - p.z]).toEqual([0, 0, 3]);
      for (const [x, y] of [[subject.x, subject.y], [-0.5, 0.4], [1.1, 0.9]] as const) {
        const [sx, sy] = screen(p, x, y, subject.z);
        expect(sx).toBeCloseTo(x / subject.z);
        expect(sy).toBeCloseTo(y / subject.z);
      }
    }
    // A distant wall more than doubles in size, about the subject's place in the frame.
    const end = cameraPose("dolly_zoom", 1, subject);
    const [ax] = screen(end, 0, 0, 12), [bx] = screen(end, 1, 0, 12);
    expect((bx! - ax!) / (1 / 12)).toBeGreaterThan(2);
    const [cx, cy] = screen(end, subject.x / subject.z * 12, subject.y / subject.z * 12, 12);
    expect(cx).toBeCloseTo(subject.x / subject.z);
    expect(cy).toBeCloseTo(subject.y / subject.z);
  });
  it("shapes the dolly zoom's scene: the foreground holds, the background stretches, edges snap", () => {
    // A 20x10 photo: a near box in the middle (the subject), a wall one step behind it, the floor in front nearer still.
    const width = 20, height = 10;
    const depth = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const d = x >= 8 && x < 12 && y >= 3 && y < 7 ? 200 : y >= 8 ? 240 : 60;
      depth.fill(d, (y * width + x) * 3, (y * width + x + 1) * 3);
    }
    // A pixel blended between the box and the wall.
    depth.fill(130, (5 * width + 12) * 3, (5 * width + 13) * 3);
    const points = cameraPoints(depth, depth, width, height);
    const shaped = dollyZoomPoints(points, width, height);
    const z = (p: typeof points, x: number, y: number) => p.xyz[(y * width + x) * 3 + 2]!;
    const hold = shaped.subject.z;
    expect(hold).toBeGreaterThan(points.subject.z);
    // The subject and the nearer floor sit on the hold plane; the wall is pushed back by the stretch.
    expect(z(shaped, 10, 5)).toBeCloseTo(hold, 5);
    expect(z(shaped, 10, 9)).toBeCloseTo(hold, 5);
    // The wall is the background's middle depth: stretched until it grows by DOLLY_ZOOM_GROWTH by the end.
    const b = DOLLY_ZOOM_BACK / hold, wall = z(shaped, 0, 0) / hold;
    expect((1 + b) / (1 + b / wall)).toBeCloseTo(DOLLY_ZOOM_GROWTH, 4);
    expect(wall).toBeGreaterThan(z(points, 0, 0) / hold);
    // The blended pixel joins the box, not the gap between.
    expect(z(shaped, 12, 5)).toBeCloseTo(hold, 5);
    // Every pixel keeps its place in the opening frame.
    for (let i = 0; i < width * height; i++) {
      expect(shaped.xyz[i * 3]! / shaped.xyz[i * 3 + 2]!).toBeCloseTo(points.xyz[i * 3]! / points.xyz[i * 3 + 2]!, 6);
      expect(shaped.xyz[i * 3 + 1]! / shaped.xyz[i * 3 + 2]!).toBeCloseTo(points.xyz[i * 3 + 1]! / points.xyz[i * 3 + 2]!, 6);
    }
    // The opening frame is the photo's layout. Only pixels at a depth edge take the shade of the side they join.
    const opening = cameraFrame(shaped, width, height, cameraPose("dolly_zoom", 0, shaped.subject), DOLLY_ZOOM_CRACK_PX);
    const source = cameraFrame(points, width, height, cameraPose("dolly_zoom", 0));
    const d = (x: number, y: number) => depth[(Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))) * 3];
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const flat = [-2, -1, 0, 1, 2].every((dy) => [-2, -1, 0, 1, 2].every((dx) => d(x + dx, y + dy) === d(x, y)));
      if (flat) expect(opening[(y * width + x) * 3]).toBe(source[(y * width + x) * 3]);
    }
    expect(opening[(5 * width + 12) * 3]).toBe(points.shade[5 * width + 10]);
  });
  it("stretches a shallow room more than a deep corridor, within bounds", () => {
    const scene = (ratio: number) => Float32Array.from({ length: 100 }, (_, i) => (i < 30 ? 2.5 : 3 * ratio));
    const shallow = dollyZoomStretch(scene(1.2), 3), deep = dollyZoomStretch(scene(3), 3);
    expect(shallow).toBeGreaterThan(deep);
    expect(deep).toBeGreaterThanOrEqual(1);
    expect(dollyZoomStretch(scene(1), 3.5)).toBe(1);
    expect(dollyZoomStretch(scene(1.00001), 3)).toBe(6);
  });
  it("makes a dolly zoom guide that holds the subject and the frame's edges while the background grows", () => {
    // A box near the camera on a floor, in front of a far wall with a bright square: frame zero, then the last frame.
    const width = 64, height = 48;
    const depth = new Uint8Array(width * height * 3), photo = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const box = x >= 26 && x < 38 && y >= 16 && y < 34, floor = y >= 40, mark = x >= 40 && x < 48 && y >= 8 && y < 14;
      depth.fill(box ? 220 : floor ? 240 : 40, (y * width + x) * 3, (y * width + x + 1) * 3);
      photo.fill(mark ? 255 : 0, (y * width + x) * 3, (y * width + x + 1) * 3);
    }
    const shaped = dollyZoomPoints(cameraPoints(depth, photo, width, height), width, height);
    const last = cameraFrame(shaped, width, height, cameraPose("dolly_zoom", 1, shaped.subject), DOLLY_ZOOM_CRACK_PX);
    const first = cameraFrame(shaped, width, height, cameraPose("dolly_zoom", 0, shaped.subject), DOLLY_ZOOM_CRACK_PX);
    const at = (f: Buffer, x: number, y: number) => f[(y * width + x) * 3]!;
    // The box and the floor are where they were; no grey border opens at the bottom or the sides.
    for (const [x, y] of [[30, 20], [35, 30], [0, 47], [63, 47], [32, 44]] as const) expect(at(last, x, y)).toBe(at(first, x, y));
    // The bright mark on the far wall is wider than it was.
    const wide = (f: Buffer) => Array.from({ length: width }, (_, x) => at(f, x, 10)).filter((v) => v === Math.max(...Array.from({ length: width }, (_, k) => at(f, k, 10)))).length;
    expect(wide(last)).toBeGreaterThan(wide(first) * 1.5);
  });
  it("names every move in the model prompt", () => {
    for (const move of quickMoves) expect(cameraPrompt("A clay bowl.", move.id)).toContain(`Camera movement: ${move.label}.`);
  });
  it("tells the video model what a dolly zoom looks like, never that the camera pulls back", () => {
    const prompt = cameraPrompt("A woman in a hotel corridor.", "dolly_zoom");
    expect(prompt).toContain("same size and place in the frame");
    expect(prompt).not.toMatch(/pull|back away/i);
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
