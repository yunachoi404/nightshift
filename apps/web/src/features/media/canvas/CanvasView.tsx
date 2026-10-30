/**
 * The Media canvas, shown when a project has more than one board. Boards sit freely on it: pan by dragging the empty
 * background, two-finger scrolling or Space and drag; zoom with Cmd or Ctrl and the wheel, a pinch, or the controls at
 * the bottom right. A board moves by its title bar and goes to the Editor's timeline whole by its grip. Its cards are
 * the caller's (`renderBoard`), so drags that start on a card are never taken for a pan.
 */
import type { Project } from "@nightshift/contract";
import { GripVertical, Maximize, Minus, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Button, Input, Menu, MenuItem, cx } from "@/ui/primitives";
import { isCanvasDrag, setDrag, type CanvasBoard } from "../items";
import { useBoardActions, type BoardActions } from "./boardActions";
import { clampWidth, defaultFrames, fitView, loadView, nextBoardFrame, revealRect, saveView, stepZoom, zoomAt, type Frame, type Rect, type View } from "./layout";
import "./canvas.css";

export interface CanvasViewProps {
  project: Project;
  boards: CanvasBoard[];
  renderBoard: (b: CanvasBoard) => ReactNode;
  currentBoardId?: string;
  onFocusBoard?: (boardId: string) => void;
}

/** How far an arrow key pans, in screen pixels (four times that with Shift). */
const ARROW_STEP = 64;
/** Near an edge of the canvas, a card dragged over it pans it this far per dragover. */
const EDGE = 56;
const EDGE_STEP = 14;
/** A board's height before it is measured. */
const GUESS_H = 320;

export function CanvasView({ project, boards, renderBoard, currentBoardId, onFocusBoard }: CanvasViewProps) {
  const actions = useBoardActions(project);
  const viewportRef = useRef<HTMLDivElement>(null);
  const boardEls = useRef(new Map<string, HTMLElement>());
  const [view, setView] = useState<View>(() => loadView(project.id) ?? { x: 48, y: 48, zoom: 1 });
  const viewRef = useRef(view);
  const [animate, setAnimate] = useState(false);
  const [panning, setPanning] = useState(false);
  const [space, setSpace] = useState(false);
  const [adding, setAdding] = useState(false);
  const pan = useRef<{ id: number; sx: number; sy: number; vx: number; vy: number } | null>(null);
  const hover = useRef(false);
  /** Frames moved here and not saved yet, so a board stays where it was dropped while the save goes out. */
  const [placed, setPlaced] = useState<Record<string, Frame>>({});

  const frames = useMemo(() => {
    const out = defaultFrames(boards.map((b) => b.board));
    for (const [id, f] of Object.entries(placed)) if (out.has(id)) out.set(id, f);
    return out;
  }, [boards, placed]);
  const framesRef = useRef(frames);
  framesRef.current = frames;

  const apply = useCallback((next: View, smooth = false) => {
    viewRef.current = next;
    setAnimate(smooth);
    setView(next);
  }, []);

  const size = () => ({ w: viewportRef.current?.clientWidth ?? 0, h: viewportRef.current?.clientHeight ?? 0 });
  const rect = (id: string): Rect | undefined => {
    const f = framesRef.current.get(id);
    return f && { ...f, h: boardEls.current.get(id)?.offsetHeight || GUESS_H };
  };
  const fitAll = useCallback(() => [...framesRef.current.keys()].flatMap((id) => rect(id) ?? []), []);

  // The view this project had in this session, else all its boards in sight. Saved again when the canvas goes.
  useLayoutEffect(() => {
    const id = project.id;
    apply(loadView(id) ?? fitView(fitAll(), size()));
    return () => saveView(id, viewRef.current);
  }, [project.id, apply, fitAll]);
  useEffect(() => {
    const t = window.setTimeout(() => saveView(project.id, view), 250);
    return () => window.clearTimeout(t);
  }, [project.id, view]);

  const fit = useCallback(() => apply(fitView(fitAll(), size()), true), [apply, fitAll]);
  const zoomTo = useCallback(
    (zoom: number) => {
      const { w, h } = size();
      apply(zoomAt(viewRef.current, zoom, { x: w / 2, y: h / 2 }), true);
    },
    [apply],
  );

  // Wheel: Cmd or Ctrl (and a trackpad pinch, which comes as Ctrl) zooms at the pointer; anything else pans. React's
  // wheel listener is passive, so this one is the element's own.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest("dialog")) return;
      const zoom = e.ctrlKey || e.metaKey;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      let dx = e.deltaX * unit;
      let dy = e.deltaY * unit;
      if (e.shiftKey && !dx) [dx, dy] = [dy, 0];
      if (!zoom && target && scrollsWithin(target, el, dx, dy)) return;
      e.preventDefault();
      const v = viewRef.current;
      if (zoom) {
        const r = el.getBoundingClientRect();
        const d = Math.max(-60, Math.min(60, dy));
        apply(zoomAt(v, v.zoom * Math.exp(-d * 0.01), { x: e.clientX - r.left, y: e.clientY - r.top }));
      } else {
        apply({ ...v, x: v.x - dx, y: v.y - dy });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [apply]);

  // Space held over the canvas turns any drag into a pan.
  useEffect(() => {
    const isSpace = (e: globalThis.KeyboardEvent) => e.code === "Space" || e.key === " ";
    const down = (e: globalThis.KeyboardEvent) => {
      if (!isSpace(e)) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t && (typing(t) || t.closest("button, a, [role=button], [role=menuitem], dialog"))) return;
      const el = viewportRef.current;
      if (!el || !(hover.current || el.contains(document.activeElement))) return;
      e.preventDefault();
      setSpace(true);
    };
    const up = (e: globalThis.KeyboardEvent) => {
      if (isSpace(e)) setSpace(false);
    };
    const off = () => setSpace(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", off);
    };
  }, []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const background = e.target === e.currentTarget || (e.target as Element).classList?.contains("cv__layer");
    if (!(e.button === 1 || (e.button === 0 && (background || space)))) return;
    if (e.button === 1) e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
    capture(e);
    pan.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
    setPanning(true);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    if (!p || p.id !== e.pointerId) return;
    apply({ ...viewRef.current, x: p.vx + e.clientX - p.sx, y: p.vy + e.clientY - p.sy });
  };
  const endPan = (e: PointerEvent<HTMLDivElement>) => {
    if (pan.current?.id !== e.pointerId) return;
    pan.current = null;
    setPanning(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (typing(t) || t.closest("dialog")) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "0") {
      e.preventDefault();
      fit();
    } else if (!e.altKey && (e.key === "+" || e.key === "=")) {
      e.preventDefault();
      zoomTo(stepZoom(viewRef.current.zoom, 1));
    } else if (!e.altKey && (e.key === "-" || e.key === "_")) {
      e.preventDefault();
      zoomTo(stepZoom(viewRef.current.zoom, -1));
    } else if (t === e.currentTarget && !mod && e.key.startsWith("Arrow")) {
      const step = e.shiftKey ? ARROW_STEP * 4 : ARROW_STEP;
      const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      const [dx, dy] = moves[e.key] ?? [0, 0];
      if (!dx && !dy) return;
      e.preventDefault();
      const v = viewRef.current;
      apply({ ...v, x: v.x + dx, y: v.y + dy }, true);
    }
  };

  // A card dragged near an edge pans the canvas, so it can reach a board out of sight. The drop is the board's.
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!isCanvasDrag(e)) return;
    const r = e.currentTarget.getBoundingClientRect();
    const dx = e.clientX < r.left + EDGE ? 1 : e.clientX > r.right - EDGE ? -1 : 0;
    const dy = e.clientY < r.top + EDGE ? 1 : e.clientY > r.bottom - EDGE ? -1 : 0;
    if (!dx && !dy) return;
    const v = viewRef.current;
    apply({ ...v, x: v.x + dx * EDGE_STEP, y: v.y + dy * EDGE_STEP });
  };

  const place = useCallback(
    (boardId: string, frame: Frame) => {
      setPlaced((p) => ({ ...p, [boardId]: frame }));
      void actions.moveBoard(boardId, frame).finally(() =>
        setPlaced((p) => {
          if (p[boardId] !== frame) return p;
          const { [boardId]: _, ...rest } = p;
          return rest;
        }),
      );
    },
    [actions],
  );

  const addBoard = async () => {
    setAdding(true);
    const frame = nextBoardFrame(framesRef.current.values());
    const id = await actions.addBoard().finally(() => setAdding(false));
    if (!id) return;
    onFocusBoard?.(id);
    apply(revealRect(viewRef.current, { ...frame, h: GUESS_H }, size()), true);
  };

  const register = useCallback((id: string, el: HTMLElement | null) => {
    if (el) boardEls.current.set(id, el);
    else boardEls.current.delete(id);
  }, []);

  const step = gridStep(view.zoom);
  const multi = boards.length > 1;
  return (
    <div
      ref={viewportRef}
      className={cx("cv", animate && "cv--animate", space && "cv--space", panning && "cv--panning")}
      style={
        {
          "--cv-zoom": view.zoom,
          backgroundSize: `${step}px ${step}px`,
          backgroundPosition: `${view.x - step / 2}px ${view.y - step / 2}px`,
        } as CSSProperties
      }
      tabIndex={0}
      role="region"
      aria-roledescription="canvas"
      aria-label="Boards. Drag the background or use the arrow keys to pan."
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onPointerEnter={() => (hover.current = true)}
      onPointerLeave={() => (hover.current = false)}
      onKeyDown={onKeyDown}
      onDragOver={onDragOver}
    >
      <div className="cv__layer" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
        {boards.map((b) => (
          <BoardFrame
            key={b.board.id}
            cb={b}
            frame={frames.get(b.board.id)!}
            current={b.board.id === currentBoardId}
            canDelete={multi && !b.items.length}
            lastBoard={!multi}
            viewRef={viewRef}
            actions={actions}
            renderBoard={renderBoard}
            onFocus={onFocusBoard}
            onPlace={place}
            register={register}
          />
        ))}
      </div>
      <div className="cv__dock" role="toolbar" aria-label="Canvas">
        <Button variant="toolbar" size="s" icon={<Plus />} busy={adding} onClick={() => void addBoard()}>
          New board
        </Button>
        <span className="cv__sep" aria-hidden />
        <Button variant="toolbar" size="s" iconOnly icon={<Minus />} aria-label="Zoom out" title="Zoom out" disabled={view.zoom <= 0.25 + 1e-3} onClick={() => zoomTo(stepZoom(view.zoom, -1))} />
        <button type="button" className="cv__zoom" aria-label={`Zoom ${Math.round(view.zoom * 100)} percent. Reset to 100 percent`} title="Reset to 100%" onClick={() => zoomTo(1)}>
          {Math.round(view.zoom * 100)}%
        </button>
        <Button variant="toolbar" size="s" iconOnly icon={<Plus />} aria-label="Zoom in" title="Zoom in" disabled={view.zoom >= 2 - 1e-3} onClick={() => zoomTo(stepZoom(view.zoom, 1))} />
        <Button variant="toolbar" size="s" icon={<Maximize />} aria-label="Fit all boards" title="Fit all boards" onClick={fit}>
          Fit
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- one board on the canvas

interface BoardFrameProps {
  cb: CanvasBoard;
  frame: Frame;
  current: boolean;
  canDelete: boolean;
  lastBoard: boolean;
  viewRef: RefObject<View>;
  actions: BoardActions;
  renderBoard: (b: CanvasBoard) => ReactNode;
  onFocus: ((boardId: string) => void) | undefined;
  onPlace: (boardId: string, frame: Frame) => void;
  register: (boardId: string, el: HTMLElement | null) => void;
}

const BoardFrame = memo(function BoardFrame({ cb, frame, current, canDelete, lastBoard, viewRef, actions, renderBoard, onFocus, onPlace, register }: BoardFrameProps) {
  const { board, items } = cb;
  const id = board.id;
  const body = useMemo(() => renderBoard(cb), [renderBoard, cb]);
  const setEl = useCallback((el: HTMLElement | null) => register(id, el), [register, id]);

  // Moving (by the title bar) and resizing (by the right edge): live here, saved on release.
  const [live, setLive] = useState<Frame | null>(null);
  const liveRef = useRef<Frame | null>(null);
  const drag = useRef<{ id: number; sx: number; sy: number; from: Frame; mode: "move" | "resize"; moved: boolean } | null>(null);
  const startDrag = (mode: "move" | "resize") => (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    if (mode === "move" && (e.target as Element).closest("button, input, .cvb__grip, .menu")) return;
    e.stopPropagation();
    capture(e);
    drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, from: frame, mode, moved: false };
  };
  const onDrag = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 3) return;
    d.moved = true;
    const zoom = viewRef.current.zoom || 1;
    const dx = (e.clientX - d.sx) / zoom;
    const dy = (e.clientY - d.sy) / zoom;
    const next = d.mode === "move" ? { ...d.from, x: Math.round(d.from.x + dx), y: Math.round(d.from.y + dy) } : { ...d.from, w: clampWidth(d.from.w + dx) };
    liveRef.current = next;
    setLive(next);
  };
  const endDrag = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const next = liveRef.current;
    liveRef.current = null;
    if (d.moved && next && e.type === "pointerup") onPlace(id, next);
    setLive(null);
  };

  // Renaming inline: Enter or leaving the field saves, Escape cancels.
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(false);
  const [draft, setDraft] = useState(board.name);
  const [pendingName, setPendingName] = useState<string | null>(null);
  const startRename = () => {
    setDraft(pendingName ?? board.name);
    editingRef.current = true;
    setEditing(true);
  };
  /** Ends the rename. From the keyboard, the canvas takes the focus back so its keys keep working. */
  const stopRename = (save: boolean, field?: HTMLElement) => {
    if (!editingRef.current) return;
    editingRef.current = false;
    setEditing(false);
    field?.closest<HTMLElement>(".cv")?.focus({ preventScroll: true });
    const name = draft.trim().slice(0, 60);
    if (!save || !name || name === board.name) return;
    setPendingName(name);
    void actions.renameBoard(id, name).finally(() => setPendingName(null));
  };

  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setMenu(false), []);

  const onGripDragStart = (e: DragEvent<HTMLElement>) => {
    e.stopPropagation();
    setDrag(e, { items: board.items, fromBoard: id });
    dragGhost(e, `${pendingName ?? board.name}, ${items.length} ${items.length === 1 ? "card" : "cards"}`);
  };

  const f = live ?? frame;
  const name = pendingName ?? board.name;
  const why = lastBoard ? "The last board stays" : "Move its cards first";
  return (
    <section
      ref={setEl}
      className={cx("cvb", current && "cvb--current", live && "cvb--live", menu && "cvb--raised")}
      style={{ transform: `translate(${f.x}px, ${f.y}px)`, width: f.w }}
      aria-label={name}
      data-board-id={id}
      onPointerDownCapture={() => {
        if (!current) onFocus?.(id);
      }}
    >
      <header
        className="cvb__bar"
        onPointerDown={startDrag("move")}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(e) => {
          if (!editing && !(e.target as Element).closest("button, input, .cvb__grip, .menu")) startRename();
        }}
      >
        <span
          className={cx("cvb__grip", !items.length && "cvb__grip--off")}
          draggable={items.length > 0}
          onDragStart={onGripDragStart}
          role="img"
          aria-label="Drag the board to the timeline"
          title={items.length ? "Drag the board to the timeline" : "Nothing to drag yet"}
        >
          <GripVertical />
        </span>
        {editing ? (
          <Input
            className="cvb__rename"
            value={draft}
            maxLength={60}
            autoFocus
            aria-label="Board name"
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => stopRename(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                stopRename(true, e.currentTarget);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                stopRename(false, e.currentTarget);
              }
            }}
          />
        ) : (
          <span className="cvb__name" title="Double click to rename">
            {name}
          </span>
        )}
        <span className="cvb__count" aria-label={`${items.length} ${items.length === 1 ? "card" : "cards"}`}>
          {items.length}
        </span>
        <span className="cvb__more">
          <Button
            ref={menuRef}
            size="s"
            variant="quiet"
            iconOnly
            icon={<MoreHorizontal />}
            aria-label={`More for ${name}`}
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => setMenu((v) => !v)}
          />
          <Menu open={menu} onClose={closeMenu} anchor={menuRef}>
            <MenuItem
              icon={<Pencil />}
              onClick={() => {
                setMenu(false);
                startRename();
              }}
            >
              Rename
            </MenuItem>
            {canDelete ? (
              <MenuItem
                danger
                icon={<Trash2 />}
                onClick={() => {
                  setMenu(false);
                  void actions.deleteBoard(id);
                }}
              >
                Delete board
              </MenuItem>
            ) : (
              <button type="button" role="menuitem" className="menu__item cvb__off" disabled aria-disabled="true" title={why}>
                <Trash2 />
                <span className="cvb__off-text">
                  Delete board
                  <small>{why}</small>
                </span>
              </button>
            )}
          </Menu>
        </span>
      </header>
      <div className="cvb__body">{body}</div>
      <div className="cvb__resize" aria-hidden onPointerDown={startDrag("resize")} onPointerMove={onDrag} onPointerUp={endDrag} onPointerCancel={endDrag} />
    </section>
  );
});

// ---------------------------------------------------------------- helpers

/** Keeps a drag's pointer events on its element, even off it. A pointer the browser no longer tracks is skipped. */
function capture(e: PointerEvent<HTMLElement>) {
  try {
    e.currentTarget.setPointerCapture?.(e.pointerId);
  } catch {
    // Not an active pointer: the drag still follows while the pointer stays over the element.
  }
}

function typing(el: HTMLElement): boolean {
  return el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

/** Whether something between `target` and the canvas scrolls this way itself, so the wheel is its, not a pan. */
function scrollsWithin(target: Element, root: Element, dx: number, dy: number): boolean {
  for (let n: Element | null = target; n && n !== root; n = n.parentElement) {
    if (n.scrollHeight <= n.clientHeight + 1 && n.scrollWidth <= n.clientWidth + 1) continue;
    const s = getComputedStyle(n);
    const canY = /(auto|scroll)/.test(s.overflowY) && ((dy < 0 && n.scrollTop > 0) || (dy > 0 && n.scrollTop + n.clientHeight < n.scrollHeight - 1));
    const canX = /(auto|scroll)/.test(s.overflowX) && ((dx < 0 && n.scrollLeft > 0) || (dx > 0 && n.scrollLeft + n.clientWidth < n.scrollWidth - 1));
    if (canY || canX) return true;
  }
  return false;
}

/** The dot grid's spacing on screen: 24 canvas units, doubled until the dots are at least 14 pixels apart. */
function gridStep(zoom: number): number {
  let step = 24 * zoom;
  while (step < 14) step *= 2;
  return step;
}

/** A small label to drag instead of the grip: the board's name and how many cards it holds. */
function dragGhost(e: DragEvent<HTMLElement>, label: string) {
  const dt = e.dataTransfer;
  if (!dt || typeof dt.setDragImage !== "function") return;
  const ghost = document.createElement("div");
  ghost.className = "cv-ghost";
  ghost.textContent = label;
  document.body.appendChild(ghost);
  dt.setDragImage(ghost, 14, 14);
  window.setTimeout(() => ghost.remove(), 0);
}
