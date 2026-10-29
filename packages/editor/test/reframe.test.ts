import { describe, expect, it } from "vitest";
import { bestWindow, rowBrightness, saliencyMap, subjectExtent, subjectPoint, SUBJECT_WEIGHTS } from "../src/render/reframe.js";

function frame(w: number, h: number, paint: (x: number, y: number) => [number, number, number]): Uint8Array {
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      rgb.set([r, g, b], (y * w + x) * 3);
    }
  }
  return rgb;
}

const W = 160;
const H = 90;

/** A pale sky over a grey street, and a small red figure low and left of centre, shifted by `dx`. */
const street = (dx: number) => (x: number, y: number): [number, number, number] => {
  const figure = Math.abs(x - (56 + dx)) < 4 && y > 58 && y < 78;
  if (figure) return [210, 40, 30];
  return y < 40 ? [225, 228, 232] : [120, 118, 116];
};

describe("subjectPoint", () => {
  it("finds a small strong subject rather than a big bright sky", () => {
    const frames = [frame(W, H, street(0)), frame(W, H, street(1)), frame(W, H, street(2))];
    const map = saliencyMap(frames, W, H);
    const subject = subjectPoint(saliencyMap(frames, W, H, SUBJECT_WEIGHTS), W, H);
    expect(Math.abs(subject.x - 57 / 160)).toBeLessThan(0.08);
    expect(Math.abs(subject.y - 68 / 90)).toBeLessThan(0.1);
    // The crop window for a 9:16 frame leans the same way, with its usual pull towards the middle.
    expect(bestWindow(profileX(map, W, H), 50.6) / W).toBeLessThan(0.5);
  });

  it("falls back to the centre of an empty map", () => {
    expect(subjectPoint(new Float32Array(16 * 9), 16, 9)).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe("subjectExtent", () => {
  it("boxes the coloured figure around the subject point, per frame and over its move, with room for a head and legs", () => {
    const frames = [frame(W, H, street(0)), frame(W, H, street(1)), frame(W, H, street(2))];
    const { box, boxes } = subjectExtent(frames, W, H, { x: 57 / 160, y: 68 / 90 });
    // The red patch spans x 53..61 over the frames and y 59..77; the box adds 30% above, 45% below, and a pixel.
    expect(box.left).toBeCloseTo((53 - 1) / W, 5);
    expect(box.right).toBeCloseTo((62 + 1) / W, 5);
    expect(box.top).toBeCloseTo((59 - 0.3 * 19 - 1) / H, 5);
    expect(box.bottom).toBeCloseTo((78 + 0.45 * 19 + 1) / H, 5);
    expect(boxes).toHaveLength(3);
    expect(boxes[0]!.right).toBeCloseTo((60 + 1) / W, 5);
    expect(boxes[2]!.right).toBeCloseTo((62 + 1) / W, 5);
  });

  it("grows a grey subject by brightness and stops at a different grey", () => {
    const cup = frame(W, H, (x, y) => (x > 60 && x < 100 && y > 30 && y < 80 ? [200, 200, 205] : [90, 92, 95]));
    const { box } = subjectExtent([cup], W, H, { x: 0.5, y: 0.6 });
    expect(box.left).toBeCloseTo((61 - 1) / W, 5);
    expect(box.top).toBeCloseTo((31 - 0.3 * 49 - 1) / H, 5);
    expect(box.bottom).toBe(1);
  });

  it("skips frames where the point falls on the background and keeps a modest box around the point", () => {
    const flat = frame(W, H, () => [120, 118, 116]);
    const modest = { left: 0.42, top: 0.35, right: 0.58, bottom: 0.65 };
    expect(subjectExtent([flat], W, H, { x: 0.5, y: 0.5 })).toEqual({ box: modest, boxes: [modest] });
  });
});

describe("rowBrightness", () => {
  it("reads a bright sky over a dark street, and only inside the crop window when given", () => {
    const frames = [frame(W, H, street(0))];
    const rows = rowBrightness(frames, W, H, 9);
    expect(rows).toHaveLength(9);
    expect(rows[0]).toBeCloseTo((0.299 * 225 + 0.587 * 228 + 0.114 * 232) / 255, 3);
    expect(rows[8]).toBeCloseTo((0.299 * 120 + 0.587 * 118 + 0.114 * 116) / 255, 3);
    const dark = frame(W, H, (x, y) => (x < 80 ? [20, 20, 20] : y < 40 ? [225, 228, 232] : [120, 118, 116]));
    expect(rowBrightness([dark], W, H, 9, { left: 80, right: 160, top: 0, bottom: H })[0]).toBeCloseTo(rows[0]!, 3);
    expect(rowBrightness([dark], W, H, 9)[0]).toBeLessThan(rows[0]! / 1.5);
  });
});

function profileX(map: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[x] = (out[x] as number) + (map[y * w + x] as number);
  return out;
}
