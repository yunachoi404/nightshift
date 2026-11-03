/** Small pictures load the engine's posters, and a video shown small loads only once it plays. */
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Media, posterOf } from "./Media";

const CLIP = "/api/projects/prj_a/assets/ast_clip";

describe("posters", () => {
  it("are the asset's URL with a width; mock assets draw themselves", () => {
    expect(posterOf(CLIP, 320)).toBe(`${CLIP}?w=320`);
    expect(posterOf(`${CLIP}?v=2`, 160)).toBe(`${CLIP}?v=2&w=160`);
    const mock = "mock:image:seed:640x360";
    expect(posterOf(mock, 320)).toBe(mock);
  });

  it("of the browser demo's sample files are files beside them, since its static host cannot make one", () => {
    const base = import.meta.env.BASE_URL;
    expect(posterOf(`${base}demo/nocturne/final-1.mp4`, 640)).toBe(`${base}demo/nocturne/final-1.poster.jpg`);
    expect(posterOf(`${base}demo/nocturne/still-1.jpg`, 160)).toBe(`${base}demo/nocturne/still-1.jpg`);
  });

  it("stand in for a picture shown small", () => {
    const { container } = render(<Media src={CLIP} kind="image" thumb={160} />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(`${CLIP}?w=160`);
  });

  it("stand in for a video until it plays, and give way to it when they do not load", () => {
    const { container, rerender } = render(<Media src={CLIP} kind="video" thumb={640} />);
    expect(container.querySelector("video")).toBeNull();
    fireEvent.error(container.querySelector("img")!);
    rerender(<Media src={CLIP} kind="video" thumb={640} />);
    const video = container.querySelector("video")!;
    expect(video.getAttribute("src")).toBe(CLIP);
    // No poster to show before its first frame: the one that failed is not asked for again.
    expect(video.getAttribute("poster")).toBeNull();
  });

  it("are not used for a video resting on a later frame, which its poster does not show", () => {
    const { container } = render(<Media src={CLIP} kind="video" thumb={640} time={3.2} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("video")?.getAttribute("src")).toBe(CLIP);
  });
});
