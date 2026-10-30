/**
 * The Media canvas: boards sit at their frames, the controls add boards and zoom, a board renames inline, moves by its
 * title bar and goes to the timeline whole by its grip. Presses on cards are the cards', never a pan. The board edits
 * are mocked; their saving is the hook's (boardActions.ts) and its pure parts are tested in layout.test.ts.
 */
import type { Asset, Board, Project } from "@nightshift/contract";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canvas, DRAG_TYPE, type CanvasBoard } from "../items";
import type { BoardActions } from "./boardActions";
import { CanvasView } from "./CanvasView";

const actions = vi.hoisted(() => ({
  addBoard: vi.fn(async () => "board_new" as string | undefined),
  renameBoard: vi.fn(async () => undefined),
  deleteBoard: vi.fn(async () => undefined),
  moveBoard: vi.fn(async () => undefined),
  moveCardTo: vi.fn(async () => undefined),
}));
vi.mock("./boardActions", () => ({ useBoardActions: (): BoardActions => actions }));

// jsdom has no pointer events; React reads them as mouse events with a pointer id.
beforeAll(() => {
  if (!("PointerEvent" in window)) {
    class PointerEventShim extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    Object.defineProperty(window, "PointerEvent", { value: PointerEventShim, configurable: true });
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

const iso = () => new Date().toISOString();
const PID = "prj_canvas";

function project(boards: Board[]): Project {
  const still = (id: string): Asset => ({ id, kind: "image", path: `stills/${id}.png`, createdAt: iso() });
  return {
    id: PID,
    name: "Canvas",
    template: "cinematic_shot",
    aspect: "16:9",
    brief: {},
    shots: [
      { id: "shot_1", index: 0, prompt: "A ferry at dusk", durationSec: 4, stillAssetId: "ast_1", locked: false },
      { id: "shot_2", index: 1, prompt: "Gulls over the pier", durationSec: 4, stillAssetId: "ast_2", locked: false },
    ],
    takes: [],
    assets: [still("ast_1"), still("ast_2")],
    timeline: null,
    boards,
    createdAt: iso(),
    updatedAt: iso(),
  };
}

const BOARDS: Board[] = [
  { id: "board_a", name: "Opening", items: ["shot_1", "shot_2"], frame: { x: 100, y: 50, w: 500 } },
  { id: "board_b", name: "Mood", items: [] },
];

function setup(o: { boards?: Board[]; current?: string } = {}) {
  const p = project(o.boards ?? BOARDS);
  const onFocusBoard = vi.fn();
  const renderBoard = (b: CanvasBoard) => (
    <div data-testid={`body-${b.board.id}`}>
      {b.items.map((i) => (
        <button key={i.id} type="button" className="card">
          {i.label}
        </button>
      ))}
    </div>
  );
  const view = render(<CanvasView project={p} boards={canvas(p)} renderBoard={renderBoard} currentBoardId={o.current ?? "board_a"} onFocusBoard={onFocusBoard} />);
  const board = (name: string) => screen.getByRole("region", { name }) as HTMLElement;
  const canvasEl = document.querySelector(".cv") as HTMLElement;
  const layer = document.querySelector(".cv__layer") as HTMLElement;
  return { ...view, onFocusBoard, board, canvasEl, layer };
}

describe("the Media canvas", () => {
  it("puts each board at its frame, a board never placed in its slot in the row, with the caller's cards inside", () => {
    const { board } = setup();
    const opening = board("Opening");
    expect(opening.style.transform).toBe("translate(100px, 50px)");
    expect(opening.style.width).toBe("500px");
    const mood = board("Mood");
    expect(mood.style.transform).toBe("translate(800px, 0px)");
    expect(mood.style.width).toBe("720px");
    expect(within(screen.getByTestId("body-board_a")).getByText("A ferry at dusk")).toBeTruthy();
    expect(opening.classList.contains("cvb--current")).toBe(true);
    expect(mood.classList.contains("cvb--current")).toBe(false);
  });

  it("New board adds a board, then focuses it", async () => {
    const { onFocusBoard } = setup();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "New board" }));
    });
    expect(actions.addBoard).toHaveBeenCalledTimes(1);
    expect(onFocusBoard).toHaveBeenCalledWith("board_new");
  });

  it("a double click on the title renames inline: Enter saves, Escape cancels", async () => {
    const { board } = setup();
    fireEvent.doubleClick(within(board("Opening")).getByText("Opening"));
    const field = screen.getByRole("textbox", { name: "Board name" });
    fireEvent.change(field, { target: { value: "  Cold open  " } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(actions.renameBoard).toHaveBeenCalledWith("board_a", "Cold open");
    expect(screen.queryByRole("textbox", { name: "Board name" })).toBeNull();

    fireEvent.doubleClick(within(board("Mood")).getByText("Mood"));
    const again = screen.getByRole("textbox", { name: "Board name" });
    fireEvent.change(again, { target: { value: "Never saved" } });
    fireEvent.keyDown(again, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Board name" })).toBeNull();
    expect(actions.renameBoard).toHaveBeenCalledTimes(1);
    expect(within(board("Mood")).getByText("Mood")).toBeTruthy();
  });

  it("Rename in the board's menu opens the same field", async () => {
    const { board } = setup();
    fireEvent.click(within(board("Mood")).getByRole("button", { name: "More for Mood" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const field = screen.getByRole("textbox", { name: "Board name" });
    fireEvent.change(field, { target: { value: "Textures" } });
    await act(async () => {
      fireEvent.blur(field);
    });
    expect(actions.renameBoard).toHaveBeenCalledWith("board_b", "Textures");
  });

  it("only an empty board can be deleted; one with cards says to move them first", async () => {
    const { board } = setup();
    fireEvent.click(within(board("Opening")).getByRole("button", { name: "More for Opening" }));
    const blocked = screen.getByRole("menuitem", { name: /Delete board/ }) as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    expect(blocked.textContent).toContain("Move its cards first");
    fireEvent.click(within(board("Opening")).getByRole("button", { name: "More for Opening" }));

    fireEvent.click(within(board("Mood")).getByRole("button", { name: "More for Mood" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete board" }));
    });
    expect(actions.deleteBoard).toHaveBeenCalledWith("board_b");
  });

  it("dragging a board by its title bar moves it, scaled by the zoom, and saves its frame on release", async () => {
    // The save is still on its way.
    actions.moveBoard.mockReturnValueOnce(new Promise(() => undefined));
    const { board, canvasEl } = setup();
    // Zoom out to 50% first: 200 screen pixels are 400 canvas units.
    fireEvent.keyDown(canvasEl, { key: "-" });
    fireEvent.keyDown(canvasEl, { key: "-" });
    fireEvent.keyDown(canvasEl, { key: "-" });
    expect(screen.getByRole("button", { name: /Zoom 50 percent/ })).toBeTruthy();

    const bar = board("Opening").querySelector(".cvb__bar")!;
    fireEvent.pointerDown(bar, { button: 0, pointerId: 7, clientX: 300, clientY: 300 });
    fireEvent.pointerMove(bar, { pointerId: 7, clientX: 500, clientY: 350 });
    expect(board("Opening").style.transform).toBe("translate(500px, 150px)");
    await act(async () => {
      fireEvent.pointerUp(bar, { pointerId: 7, clientX: 500, clientY: 350 });
    });
    expect(actions.moveBoard).toHaveBeenCalledWith("board_a", { x: 500, y: 150, w: 500 });
    // It stays where it was dropped while the save goes out.
    expect(board("Opening").style.transform).toBe("translate(500px, 150px)");
  });

  it("the right edge resizes a board, never under 360 wide", async () => {
    const { board } = setup();
    const edge = board("Opening").querySelector(".cvb__resize")!;
    fireEvent.pointerDown(edge, { button: 0, pointerId: 5, clientX: 600, clientY: 200 });
    fireEvent.pointerMove(edge, { pointerId: 5, clientX: 700, clientY: 210 });
    expect(board("Opening").style.width).toBe("600px");
    fireEvent.pointerMove(edge, { pointerId: 5, clientX: 100, clientY: 210 });
    expect(board("Opening").style.width).toBe("360px");
    await act(async () => {
      fireEvent.pointerUp(edge, { pointerId: 5, clientX: 100, clientY: 210 });
    });
    expect(actions.moveBoard).toHaveBeenCalledWith("board_a", { x: 100, y: 50, w: 360 });
  });

  it("a click on the title bar without a drag moves nothing", () => {
    const { board } = setup();
    const bar = board("Opening").querySelector(".cvb__bar")!;
    fireEvent.pointerDown(bar, { button: 0, pointerId: 3, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(bar, { pointerId: 3, clientX: 11, clientY: 11 });
    fireEvent.pointerUp(bar, { pointerId: 3, clientX: 11, clientY: 11 });
    expect(actions.moveBoard).not.toHaveBeenCalled();
  });

  it("the grip drags the whole board out with its cards", () => {
    const { board } = setup();
    const data = new Map<string, string>();
    const dataTransfer = { setData: (k: string, v: string) => void data.set(k, v), setDragImage: vi.fn(), types: [] as string[], effectAllowed: "none" };
    const grip = within(board("Opening")).getByRole("img", { name: "Drag the board to the timeline" });
    expect(grip.getAttribute("draggable")).toBe("true");
    fireEvent.dragStart(grip, { dataTransfer });
    expect(JSON.parse(data.get(DRAG_TYPE)!)).toEqual({ items: ["shot_1", "shot_2"], fromBoard: "board_a" });
    expect(dataTransfer.setDragImage).toHaveBeenCalled();
    // An empty board has nothing to drag.
    expect(within(board("Mood")).getByRole("img", { name: "Drag the board to the timeline" }).getAttribute("draggable")).toBe("false");
  });

  it("a press on a board focuses it", () => {
    const { board, onFocusBoard } = setup();
    fireEvent.pointerDown(within(board("Mood")).getByTestId("body-board_b"), { button: 0 });
    expect(onFocusBoard).toHaveBeenCalledWith("board_b");
  });

  it("dragging the background pans; a press on a card does not", () => {
    const { canvasEl, layer } = setup();
    const before = layer.style.transform;
    fireEvent.pointerDown(screen.getByText("A ferry at dusk"), { button: 0, pointerId: 2, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(canvasEl, { pointerId: 2, clientX: 80, clientY: 40 });
    expect(layer.style.transform).toBe(before);

    fireEvent.pointerDown(canvasEl, { button: 0, pointerId: 4, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(canvasEl, { pointerId: 4, clientX: 80, clientY: 40 });
    fireEvent.pointerUp(canvasEl, { pointerId: 4, clientX: 80, clientY: 40 });
    const [, x, y] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(layer.style.transform) ?? [];
    const [, x0, y0] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(before) ?? [];
    expect(Number(x) - Number(x0)).toBe(80);
    expect(Number(y) - Number(y0)).toBe(40);
  });

  it("zooms with the controls and the keyboard, between 25% and 200%, and fits with Cmd 0", () => {
    const { canvasEl } = setup();
    const label = () => screen.getByRole("button", { name: /^Zoom \d+ percent/ }).textContent;
    expect(label()).toBe("100%");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(label()).toBe("125%");
    fireEvent.keyDown(canvasEl, { key: "+" });
    fireEvent.keyDown(canvasEl, { key: "=" });
    fireEvent.keyDown(canvasEl, { key: "+" });
    fireEvent.keyDown(canvasEl, { key: "+" });
    expect(label()).toBe("200%");
    expect((screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^Zoom \d+ percent/ }));
    expect(label()).toBe("100%");
    for (let i = 0; i < 8; i++) fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    expect(label()).toBe("25%");
    fireEvent.keyDown(canvasEl, { key: "0", metaKey: true });
    // jsdom lays nothing out, so the fit is the plain 100%.
    expect(label()).toBe("100%");
  });

  it("arrow keys pan when the canvas has the focus, not while typing", () => {
    const { canvasEl, layer, board } = setup();
    const before = layer.style.transform;
    fireEvent.keyDown(canvasEl, { key: "ArrowLeft" });
    expect(layer.style.transform).not.toBe(before);

    fireEvent.doubleClick(within(board("Mood")).getByText("Mood"));
    const moved = layer.style.transform;
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Board name" }), { key: "ArrowLeft" });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Board name" }), { key: "-" });
    expect(layer.style.transform).toBe(moved);
  });

  it("remembers the view of each project for the session", () => {
    const first = setup();
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    first.unmount();
    expect(JSON.parse(sessionStorage.getItem(`nightshift.canvas.${PID}`)!).zoom).toBe(0.8);
    setup();
    expect(screen.getByRole("button", { name: /^Zoom \d+ percent/ }).textContent).toBe("80%");
  });
});
