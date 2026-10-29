/** The mock's burned-in shot tags stay whole in every export aspect: inside the part each centre crop keeps. */
import { describe, expect, it } from "vitest";
import { cropSafeArea, shotTag, tagFits, tagPosition } from "../src/media/png.js";

const ASPECTS = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1 } as const;

/** The window an export keeps when it crops a frame to `aspect` around its centre. */
function centreCrop(width: number, height: number, aspect: number) {
  if (width / height > aspect) {
    const w = height * aspect;
    return { x: (width - w) / 2, y: 0, width: w, height };
  }
  const h = width / aspect;
  return { x: 0, y: (height - h) / 2, width, height: h };
}

const inside = (r: { x: number; y: number; width: number; height: number }, c: { x: number; y: number; width: number; height: number }) =>
  r.x >= c.x - 1e-6 && r.y >= c.y - 1e-6 && r.x + r.width <= c.x + c.width + 1e-6 && r.y + r.height <= c.y + c.height + 1e-6;

describe("mock shot tags", () => {
  // Draft and final sizes of the real recipes in every project aspect, and Kandinsky's small draft.
  const frames = [
    [640, 384], [384, 640], [512, 512],
    [1280, 768], [768, 1280], [1024, 1024],
    [608, 352], [384, 256], [1920, 1080],
  ] as const;
  const labels = ["Draft · seed 2147483646", "Final · same take", "Final · remaster"];

  for (const [width, height] of frames) {
    it(`${width}x${height}: every tag is inside the 16:9, 9:16 and 1:1 centre crops`, () => {
      const safe = cropSafeArea(width, height);
      for (const crop of Object.values(ASPECTS)) expect(inside(safe, centreCrop(width, height, crop))).toBe(true);
      // A draft's tag drops the word "seed" where the whole label does not fit, as the mock runner does.
      for (const full of labels) {
        const label = tagFits(width, height, full) ? full : full.replace("seed ", "");
        const tag = shotTag(width, height, label);
        const at = tagPosition(width, height, tag.width);
        const rect = { ...at, width: tag.width, height: tag.height };
        for (const [name, crop] of Object.entries(ASPECTS)) expect(inside(rect, centreCrop(width, height, crop)), `${label} in ${name}`).toBe(true);
      }
    });
  }

  it("a final's tag, scaled up from its draft's to cover it, stays inside too", () => {
    // As the mock final does it: the draft's tag where it landed after scaling, covered by a slightly larger one.
    const [dw, dh, fw, fh] = [640, 384, 1280, 768];
    const old = shotTag(dw, dh, labels[0]!);
    const at = tagPosition(dw, dh, old.width);
    const [sx, sy] = [fw / dw, fh / dh];
    const tag = shotTag(fw, fh, "Final · same take", { width: Math.ceil(old.width * sx) + 4, height: Math.ceil(old.height * sy) + 4 });
    const x = Math.max(0, Math.round((at.x + old.width / 2) * sx - tag.width / 2));
    const y = Math.max(0, Math.floor(at.y * sy) - 2);
    expect(inside({ x, y, width: tag.width, height: tag.height }, centreCrop(fw, fh, 9 / 16))).toBe(true);
  });
});
