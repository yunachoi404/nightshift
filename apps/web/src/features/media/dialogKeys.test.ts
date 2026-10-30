import { describe, expect, it } from "vitest";
import { ownsArrowKeys, versionKey } from "./dialogKeys";

describe("versionKey", () => {
  it("moves one version at a time and stops at either end", () => {
    expect(versionKey("ArrowRight", 1, 4)).toEqual({ select: 2 });
    expect(versionKey("ArrowDown", 1, 4)).toEqual({ select: 2 });
    expect(versionKey("ArrowLeft", 1, 4)).toEqual({ select: 0 });
    expect(versionKey("ArrowUp", 1, 4)).toEqual({ select: 0 });
    expect(versionKey("ArrowLeft", 0, 4)).toEqual({ select: 0 });
    expect(versionKey("ArrowRight", 3, 4)).toEqual({ select: 3 });
  });

  it("jumps to the oldest and the newest", () => {
    expect(versionKey("Home", 2, 4)).toEqual({ select: 0 });
    expect(versionKey("End", 0, 4)).toEqual({ select: 3 });
  });

  it("starts from an end when nothing is selected", () => {
    expect(versionKey("ArrowRight", -1, 3)).toEqual({ select: 0 });
    expect(versionKey("ArrowLeft", -1, 3)).toEqual({ select: 2 });
    expect(versionKey("Enter", -1, 3)).toBeNull();
  });

  it("Enter restores the selected version; other keys do nothing; no versions, nothing to do", () => {
    expect(versionKey("Enter", 1, 4)).toBe("restore");
    expect(versionKey(" ", 1, 4)).toBeNull();
    expect(versionKey("a", 1, 4)).toBeNull();
    expect(versionKey("ArrowRight", 0, 0)).toBeNull();
  });
});

describe("ownsArrowKeys", () => {
  const make = (html: string) => {
    const host = document.createElement("div");
    host.innerHTML = html;
    return host.firstElementChild!;
  };

  it("text fields, selects, sliders and number fields keep their arrows", () => {
    expect(ownsArrowKeys(make("<textarea></textarea>"))).toBe(true);
    expect(ownsArrowKeys(make("<select><option>a</option></select>"))).toBe(true);
    expect(ownsArrowKeys(make('<input type="text">'))).toBe(true);
    expect(ownsArrowKeys(make('<input type="number">'))).toBe(true);
    expect(ownsArrowKeys(make('<input type="range">'))).toBe(true);
    expect(ownsArrowKeys(make("<input>"))).toBe(true);
  });

  it("a radio group's options keep their arrows, a plain button does not", () => {
    const group = make('<div role="radiogroup"><button role="radio">Freeze</button></div>');
    expect(ownsArrowKeys(group.querySelector("button"))).toBe(true);
    expect(ownsArrowKeys(make("<button>Another take</button>"))).toBe(false);
    expect(ownsArrowKeys(make('<input type="checkbox">'))).toBe(false);
    expect(ownsArrowKeys(null)).toBe(false);
  });
});
