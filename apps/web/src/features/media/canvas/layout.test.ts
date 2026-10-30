import type { Board } from "@nightshift/contract";
import { beforeEach, describe, expect, it } from "vitest";
import { placeBoard, withNewBoard } from "./boardActions";
import { BOARD_GAP, BOARD_W, clampWidth, clampZoom, defaultFrames, fitView, loadView, nextBoardFrame, revealRect, saveView, stepZoom, zoomAt } from "./layout";

const board = (id: string, frame?: Board["frame"]): Board => ({ id, name: id, items: [], ...(frame ? { frame } : {}) });

describe("defaultFrames", () => {
  it("lays boards without a frame in a row from the left", () => {
    const frames = defaultFrames([board("a"), board("b"), board("c")]);
    expect([...frames.values()]).toEqual([
      { x: 0, y: 0, w: BOARD_W },
      { x: BOARD_W + BOARD_GAP, y: 0, w: BOARD_W },
      { x: 2 * (BOARD_W + BOARD_GAP), y: 0, w: BOARD_W },
    ]);
  });

  it("keeps a placed board's frame and its width, and leaves the others in their slots", () => {
    const frames = defaultFrames([board("a", { x: 40, y: 900, w: 500 }), board("b"), board("c", { x: -300, y: 20 })]);
    expect(frames.get("a")).toEqual({ x: 40, y: 900, w: 500 });
    expect(frames.get("b")).toEqual({ x: BOARD_W + BOARD_GAP, y: 0, w: BOARD_W });
    expect(frames.get("c")).toEqual({ x: -300, y: 20, w: BOARD_W });
  });

  it("keeps a stored width in bounds", () => {
    expect(defaultFrames([board("a", { x: 0, y: 0, w: 10 })]).get("a")!.w).toBe(360);
    expect(clampWidth(Number.NaN)).toBe(BOARD_W);
  });
});

describe("nextBoardFrame", () => {
  it("starts at the origin on an empty canvas", () => {
    expect(nextBoardFrame([])).toEqual({ x: 0, y: 0, w: BOARD_W });
  });

  it("goes to the right of the rightmost board, level with its top", () => {
    expect(nextBoardFrame([{ x: 0, y: 0, w: 720 }, { x: 1000, y: 300, w: 400 }, { x: 200, y: 900, w: 720 }])).toEqual({ x: 1400 + BOARD_GAP, y: 300, w: BOARD_W });
  });
});

describe("zoom", () => {
  it("clamps to 25% and 200%", () => {
    expect(clampZoom(0.1)).toBe(0.25);
    expect(clampZoom(3)).toBe(2);
    expect(clampZoom(0.8)).toBe(0.8);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it("steps through set levels and stops at the ends", () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.8);
    expect(stepZoom(0.9, 1)).toBe(1);
    expect(stepZoom(0.9, -1)).toBe(0.8);
    expect(stepZoom(2, 1)).toBe(2);
    expect(stepZoom(0.25, -1)).toBe(0.25);
  });

  it("holds the point under the pointer still", () => {
    const view = { x: 100, y: 50, zoom: 1 };
    const at = { x: 400, y: 300 };
    const next = zoomAt(view, 2, at);
    // The canvas point under `at` before and after.
    const before = { x: (at.x - view.x) / view.zoom, y: (at.y - view.y) / view.zoom };
    const after = { x: (at.x - next.x) / next.zoom, y: (at.y - next.y) / next.zoom };
    expect(after).toEqual(before);
    expect(zoomAt(view, 9, at).zoom).toBe(2);
  });
});

describe("fitView", () => {
  it("centres every board in the viewport, with room around them", () => {
    const view = fitView(
      [
        { x: 0, y: 0, w: 720, h: 400 },
        { x: 800, y: 0, w: 720, h: 600 },
      ],
      { w: 1000, h: 800 },
      50,
    );
    expect(view.zoom).toBeCloseTo(900 / 1520);
    // Left and right margins match; the content's top sits at its vertical centre.
    expect(view.x).toBe(Math.round((1000 - 1520 * view.zoom) / 2));
    expect(view.y).toBe(Math.round((800 - 600 * view.zoom) / 2));
  });

  it("never zooms past 100% for a small board, nor out past 25% for a huge canvas", () => {
    expect(fitView([{ x: 100, y: 100, w: 400, h: 200 }], { w: 1200, h: 900 }).zoom).toBe(1);
    expect(fitView([{ x: 0, y: 0, w: 40_000, h: 300 }], { w: 1200, h: 900 }).zoom).toBe(0.25);
  });

  it("frames boards placed away from the origin", () => {
    const view = fitView([{ x: -2000, y: 500, w: 720, h: 300 }], { w: 1000, h: 700 }, 40);
    expect(view.zoom).toBe(1);
    expect(-2000 * view.zoom + view.x).toBe(140);
    expect(500 * view.zoom + view.y).toBe(200);
  });

  it("copes with no boards and a viewport not laid out yet", () => {
    expect(fitView([], { w: 800, h: 600 })).toEqual({ x: 48, y: 48, zoom: 1 });
    expect(fitView([{ x: 10, y: 20, w: 720, h: 300 }], { w: 0, h: 0 }, 48)).toEqual({ x: 38, y: 28, zoom: 1 });
  });
});

describe("revealRect", () => {
  const viewport = { w: 1000, h: 800 };
  it("leaves the view alone when the board is in sight", () => {
    const view = { x: 0, y: 0, zoom: 1 };
    expect(revealRect(view, { x: 100, y: 100, w: 400, h: 300 }, viewport)).toBe(view);
  });

  it("pans just enough to bring a board in from the right", () => {
    const next = revealRect({ x: 0, y: 0, zoom: 0.5 }, { x: 2000, y: 0, w: 720, h: 320 }, viewport, 48);
    expect(next.zoom).toBe(0.5);
    expect((2000 + 720) * 0.5 + next.x).toBe(1000 - 48);
  });
});

describe("the saved view", () => {
  beforeEach(() => sessionStorage.clear());

  it("is kept per project for the session", () => {
    saveView("prj_a", { x: 12.4, y: -80, zoom: 0.5 });
    expect(loadView("prj_a")).toEqual({ x: 12, y: -80, zoom: 0.5 });
    expect(loadView("prj_b")).toBeUndefined();
  });

  it("ignores a broken entry", () => {
    sessionStorage.setItem("nightshift.canvas.prj_a", "{nope");
    expect(loadView("prj_a")).toBeUndefined();
    sessionStorage.setItem("nightshift.canvas.prj_a", JSON.stringify({ x: 1, y: 2, zoom: 40 }));
    expect(loadView("prj_a")).toEqual({ x: 1, y: 2, zoom: 2 });
  });
});

describe("board edits", () => {
  it("placing one board pins the others where they show, so nothing jumps", () => {
    const boards = placeBoard([board("a"), board("b"), board("c")], "a", { x: 50.6, y: 1200, w: 600 });
    expect(boards.map((b) => b.frame)).toEqual([
      { x: 51, y: 1200, w: 600 },
      { x: BOARD_W + BOARD_GAP, y: 0, w: BOARD_W },
      { x: 2 * (BOARD_W + BOARD_GAP), y: 0, w: BOARD_W },
    ]);
  });

  it("a placed board keeps its width when the move has none", () => {
    const boards = placeBoard([board("a", { x: 0, y: 0, w: 500 })], "a", { x: 10, y: 10 });
    expect(boards[0]!.frame).toEqual({ x: 10, y: 10, w: 500 });
  });

  it("a new board goes to the right of the rightmost, with the next free name", () => {
    const boards = withNewBoard([board("a", { x: 0, y: 200, w: 900 }), board("b", { x: -1000, y: 0, w: 720 })], "c");
    expect(boards.at(-1)).toEqual({ id: "c", name: "Board 3", items: [], frame: { x: 900 + BOARD_GAP, y: 200, w: BOARD_W } });
    expect(withNewBoard([board("a")], "b", "  Scene two  ").at(-1)!.name).toBe("Scene two");
    expect(withNewBoard([{ ...board("x"), name: "Board 1" }, { ...board("y"), name: "Board 3" }], "z").at(-1)!.name).toBe("Board 4");
  });
});
