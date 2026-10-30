/**
 * Edits to a project's boards: add, rename, delete (empty ones), place on the canvas, and move cards between boards.
 * Each edit reads the latest project, changes its boards and saves them, one after another, so quick edits never undo
 * each other.
 */
import { projectBoards, type Board, type Project } from "@nightshift/contract";
import { useCallback, useMemo, useRef } from "react";
import { useEngine } from "@/store/engine";
import { id as newId } from "@/lib/ids";
import { toast } from "@/ui/primitives";
import { moveCard } from "../items";
import { clampWidth, defaultFrames, nextBoardFrame } from "./layout";

export interface BoardActions {
  /** Adds a board after the others and returns its id. */
  addBoard(name?: string): Promise<string | undefined>;
  renameBoard(boardId: string, name: string): Promise<void>;
  /** Deletes a board. Only an empty board can go; the last board stays. */
  deleteBoard(boardId: string): Promise<void>;
  /** Places a board on the canvas. */
  moveBoard(boardId: string, frame: NonNullable<Board["frame"]>): Promise<void>;
  /** Moves a card to a board, at `index` (the end when absent). */
  moveCardTo(itemId: string, boardId: string, index?: number): Promise<void>;
}

/**
 * The boards with the one placed at `frame`, and every board never placed pinned where it shows now. So the canvas
 * looks the same after the move, whatever happens to the list later.
 */
export function placeBoard(boards: Board[], boardId: string, frame: NonNullable<Board["frame"]>): Board[] {
  const frames = defaultFrames(boards);
  const placed = { x: Math.round(frame.x), y: Math.round(frame.y), w: clampWidth(frame.w ?? frames.get(boardId)?.w ?? NaN) };
  return boards.map((b) => ({ ...b, frame: b.id === boardId ? placed : (b.frame ?? frames.get(b.id)) }));
}

/** The boards with a new, empty one to the right of the rightmost. Unnamed, it takes the next free "Board n". */
export function withNewBoard(boards: Board[], id: string, name?: string): Board[] {
  const frame = nextBoardFrame(defaultFrames(boards).values());
  const taken = new Set(boards.map((b) => b.name));
  let n = boards.length + 1;
  while (taken.has(`Board ${n}`)) n++;
  return [...boards, { id, name: name?.trim().slice(0, 60) || `Board ${n}`, items: [], frame }];
}

export function useBoardActions(project: Pick<Project, "id">): BoardActions {
  const { client, updateProject } = useEngine();
  const saves = useRef(Promise.resolve(true));
  /** Runs one edit after the ones before it. Resolves to whether it saved; a failure shows a toast. */
  const edit = useCallback(
    (change: (p: Project) => Board[] | undefined): Promise<boolean> => {
      const run = saves.current.then(async () => {
        const latest = await client.getProject(project.id);
        const boards = change(latest);
        if (boards) await updateProject(project.id, { boards });
        return true;
      });
      saves.current = run.catch((e) => {
        toast({ title: "Couldn't save the boards", text: e instanceof Error ? e.message : String(e), tone: "bad" });
        return false;
      });
      return saves.current;
    },
    [client, updateProject, project.id],
  );
  return useMemo<BoardActions>(
    () => ({
      addBoard: async (name) => {
        const id = newId("board");
        const ok = await edit((p) => withNewBoard(projectBoards(p), id, name));
        return ok ? id : undefined;
      },
      renameBoard: async (boardId, name) => {
        await edit((p) => (name.trim() ? projectBoards(p).map((b) => (b.id === boardId ? { ...b, name: name.trim().slice(0, 60) } : b)) : undefined));
      },
      deleteBoard: async (boardId) => {
        await edit((p) => {
          const boards = projectBoards(p);
          const board = boards.find((b) => b.id === boardId);
          if (!board || board.items.length || boards.length < 2) return undefined;
          return boards.filter((b) => b.id !== boardId);
        });
      },
      moveBoard: async (boardId, frame) => {
        await edit((p) => {
          const boards = projectBoards(p);
          return boards.some((b) => b.id === boardId) ? placeBoard(boards, boardId, frame) : undefined;
        });
      },
      moveCardTo: async (itemId, boardId, index) => {
        await edit((p) => moveCard(p, itemId, boardId, index));
      },
    }),
    [edit],
  );
}
