/**
 * The geometry of the Media canvas, kept pure so it can be tested: where boards sit, how far the view zooms, and the
 * view that frames them all. Canvas units are the boards' own pixels at 100%. A view maps them to the screen:
 * screen = canvas * zoom + (x, y).
 */
import type { Board } from "@nightshift/contract";

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 2;
/** A board's width until it is resized, and the gap between boards laid out in a row. */
export const BOARD_W = 720;
export const BOARD_GAP = 80;
export const BOARD_MIN_W = 360;
export const BOARD_MAX_W = 2400;

/** Where a board sits, in canvas units. */
export interface Frame {
  x: number;
  y: number;
  w: number;
}

/** A board's frame with its height, as measured on screen. */
export interface Rect extends Frame {
  h: number;
}

/** The pan (screen pixels) and zoom of the canvas. */
export interface View {
  x: number;
  y: number;
  zoom: number;
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function clampWidth(w: number): number {
  if (!Number.isFinite(w)) return BOARD_W;
  return Math.round(Math.min(BOARD_MAX_W, Math.max(BOARD_MIN_W, w)));
}

/**
 * Every board's frame, by id. A board placed on the canvas keeps its frame. A board never placed takes its slot in a
 * row from the left, by its place in the list, so moving one board never shifts the others.
 */
export function defaultFrames(boards: ReadonlyArray<Pick<Board, "id" | "frame">>): Map<string, Frame> {
  return new Map(
    boards.map((b, i) => [b.id, b.frame ? { x: b.frame.x, y: b.frame.y, w: clampWidth(b.frame.w ?? BOARD_W) } : { x: i * (BOARD_W + BOARD_GAP), y: 0, w: BOARD_W }]),
  );
}

/** The frame for a new board: to the right of the rightmost board, level with its top. */
export function nextBoardFrame(frames: Iterable<Frame>): Frame {
  let right: Frame | undefined;
  for (const f of frames) if (!right || f.x + f.w > right.x + right.w) right = f;
  if (!right) return { x: 0, y: 0, w: BOARD_W };
  return { x: Math.round(right.x + right.w + BOARD_GAP), y: Math.round(right.y), w: BOARD_W };
}

/**
 * The view that shows every board with `pad` screen pixels around them, centred. It never zooms in past 100%, so a
 * small board shows at its real size.
 */
export function fitView(rects: ReadonlyArray<Rect>, viewport: { w: number; h: number }, pad = 48): View {
  if (!rects.length) return { x: pad, y: pad, zoom: 1 };
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const width = Math.max(...rects.map((r) => r.x + r.w)) - left;
  const height = Math.max(...rects.map((r) => r.y + Math.max(r.h, 1))) - top;
  const roomW = viewport.w - pad * 2;
  const roomH = viewport.h - pad * 2;
  if (roomW <= 0 || roomH <= 0) return { x: pad - left, y: pad - top, zoom: 1 };
  const zoom = clampZoom(Math.min(1, roomW / width, roomH / height));
  return { x: Math.round((viewport.w - width * zoom) / 2 - left * zoom), y: Math.round((viewport.h - height * zoom) / 2 - top * zoom), zoom };
}

/** The view zoomed to `zoom` with the screen point `at` (relative to the viewport) held still. */
export function zoomAt(view: View, zoom: number, at: { x: number; y: number }): View {
  const next = clampZoom(zoom);
  const k = next / view.zoom;
  return { x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k, zoom: next };
}

const STEPS = [0.25, 0.33, 0.5, 0.67, 0.8, 1, 1.25, 1.5, 1.75, 2];

/** The next zoom step in or out from `zoom`, as the + and - buttons go. */
export function stepZoom(zoom: number, dir: 1 | -1): number {
  const z = clampZoom(zoom);
  const next = dir > 0 ? STEPS.find((s) => s > z + 0.001) : STEPS.findLast((s) => s < z - 0.001);
  return next ?? z;
}

/** The view that brings `rect` into sight, moving as little as it can. Unchanged when it is in sight already. */
export function revealRect(view: View, rect: Rect, viewport: { w: number; h: number }, pad = 48): View {
  const left = rect.x * view.zoom + view.x;
  const top = rect.y * view.zoom + view.y;
  const right = left + rect.w * view.zoom;
  const bottom = top + Math.max(rect.h, 1) * view.zoom;
  let dx = 0;
  let dy = 0;
  if (right > viewport.w - pad) dx = viewport.w - pad - right;
  if (left + dx < pad) dx = pad - left;
  if (bottom > viewport.h - pad) dy = viewport.h - pad - bottom;
  if (top + dy < pad) dy = pad - top;
  return dx || dy ? { ...view, x: view.x + dx, y: view.y + dy } : view;
}

// ---------------------------------------------------------------- the view, per project, for this session

const viewKey = (projectId: string) => `nightshift.canvas.${projectId}`;

export function loadView(projectId: string): View | undefined {
  try {
    const raw = sessionStorage.getItem(viewKey(projectId));
    const v = raw ? (JSON.parse(raw) as Partial<View>) : undefined;
    if (!v || !Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.zoom)) return undefined;
    return { x: v.x!, y: v.y!, zoom: clampZoom(v.zoom!) };
  } catch {
    return undefined;
  }
}

export function saveView(projectId: string, view: View): void {
  try {
    sessionStorage.setItem(viewKey(projectId), JSON.stringify({ x: Math.round(view.x), y: Math.round(view.y), zoom: Math.round(view.zoom * 1000) / 1000 }));
  } catch {
    // Storage full or off: the view resets next time, nothing else.
  }
}
