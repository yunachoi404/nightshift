/** A picture fills a frame edge to edge only when its shape is close to the frame's; else it shows whole. */
import { describe, expect, it } from "vitest";
import { fitFor } from "./helpers";

describe("fitFor", () => {
  const wide = 16 / 9;
  it("fills a wide frame with a wide or nearly wide picture", () => {
    expect(fitFor({ width: 1920, height: 1080 }, wide)).toBe("cover");
    expect(fitFor({ width: 960, height: 576 }, wide)).toBe("cover");
    expect(fitFor({ width: 1024, height: 768 }, wide)).toBe("cover");
  });

  it("shows a tall or square picture whole, so its top is not cut off", () => {
    expect(fitFor({ width: 576, height: 960 }, wide)).toBe("contain");
    expect(fitFor({ width: 1024, height: 1024 }, wide)).toBe("contain");
  });

  it("fills the frame when the picture's size is unknown", () => {
    expect(fitFor({}, wide)).toBe("cover");
  });
});
