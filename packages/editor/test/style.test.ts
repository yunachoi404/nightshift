import { describe, expect, it } from "vitest";
import { defaultStyle, resolveStyle, TimelineStyleSchema } from "../src/style.js";

describe("style", () => {
  it("has a valid default for every template", () => {
    for (const template of ["cinematic_shot", "music_video", "product_ad", "talking_intro"] as const) {
      expect(TimelineStyleSchema.safeParse(defaultStyle(template)).success).toBe(true);
    }
  });

  it("layers stored overrides on the template defaults", () => {
    const { style, warnings } = resolveStyle("product_ad", { palette: { accent: "#00ff88" }, captions: { size: 1.4 } });
    expect(warnings).toEqual([]);
    expect(style.palette.accent).toBe("#00ff88");
    expect(style.palette.background).toBe(defaultStyle("product_ad").palette.background);
    expect(style.captions.size).toBe(1.4);
    expect(style.captions.look).toBe("chip");
  });

  it("drops bad fields with a warning and keeps the rest", () => {
    const { style, warnings } = resolveStyle("cinematic_shot", { picture: { letterbox: 9, grain: 0.3 }, fonts: { display: "comic-sans" } });
    expect(style.picture.letterbox).toBe(2.39);
    expect(style.picture.grain).toBe(0.3);
    expect(style.fonts.display).toBe("cormorant-garamond");
    expect(warnings).toHaveLength(2);
  });

  it("lets a timeline borrow another template's look", () => {
    const { style } = resolveStyle("product_ad", { look: "cinematic_shot" });
    expect(style.look).toBe("cinematic_shot");
    expect(style.picture.letterbox).toBe(2.39);
  });

  it("ignores a stored style that is not an object", () => {
    expect(resolveStyle("music_video", undefined).style.look).toBe("music_video");
  });

  it.each(["camera_move", "vfx_effect"] as const)("opens %s on the image with no fade, grain or automatic captions", (template) => {
    const { style, warnings } = resolveStyle(template, { look: template });
    expect(warnings).toEqual([]);
    expect(style.transition).toMatchObject({ duration: 0, head: 0, tail: 0 });
    expect(style.picture).toMatchObject({ letterbox: null, vignette: 0, grain: 0, stillMotion: 0 });
    expect(style.captions.enabled).toBe(false);
  });
});
