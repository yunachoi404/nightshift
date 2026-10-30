/**
 * What the Media page shares with its boards and cards: the project, its jobs, the prompt panel's wish for an image,
 * and the edits every card makes (one save at a time, each on the latest project).
 */
import type { Job, Project } from "@nightshift/contract";
import { createContext, useCallback, useContext, useRef } from "react";
import type { ProjectPatch } from "@/api/client";
import { useEngine } from "@/store/engine";
import { toast } from "@/ui/primitives";
import { noteEditedCut } from "@/features/editor/edits";
import type { BoardActions } from "./canvas/boardActions";

/** A tool that starts from an image. */
export type ImageTool = "video" | "edit" | "effect" | "camera_move";

export interface MediaCtx {
  project: Project;
  jobs: Job[];
  /** The panel waits for an image: clicking a card hands over its image instead of opening it. */
  picking: boolean;
  /** Hands an image to the panel's tool. `cardId` is the card it came from, which the board then marks. */
  pickSource(assetId: string, cardId?: string): void;
  /** The card whose image the panel's tool starts from, marked on the board. */
  sourceCardId?: string;
  /** Opens a shot card's popup. */
  openCard(shotId: string): void;
  /** Picks a tool in the panel with this image as its source. */
  withImage(assetId: string, tool: ImageTool, cardId?: string): void;
  currentBoardId: string;
  focusBoard(boardId: string): void;
  /** Saves a change made on the latest project. Return nothing to save nothing. */
  edit(change: (latest: Project) => ProjectPatch | undefined): Promise<void>;
  boardActions: BoardActions;
  /** Uploads files onto a board: images as references, audio as songs. */
  upload(files: File[], boardId: string, role?: "reference" | "music" | "voice"): Promise<string[]>;
}

export const MediaContext = createContext<MediaCtx | null>(null);

export function useMedia(): MediaCtx {
  const ctx = useContext(MediaContext);
  if (!ctx) throw new Error("useMedia outside MediaPage");
  return ctx;
}

/**
 * Edits to one project, saved one after another: each reads the latest project, computes its patch and saves it, so a
 * quick second edit never undoes the first. Errors become a toast, and so does a change a cut edited by hand keeps out.
 */
export function useProjectEdit(projectId: string): MediaCtx["edit"] {
  const { client, updateProject } = useEngine();
  const saves = useRef(Promise.resolve());
  return useCallback(
    (change) => {
      const run = saves.current.then(async () => {
        const latest = await client.getProject(projectId);
        const patch = change(latest);
        if (!patch) return;
        await updateProject(projectId, patch);
        noteEditedCut(latest, patch, "media");
      });
      saves.current = run.catch((e) => toast({ title: "Couldn't save", text: e instanceof Error ? e.message : String(e), tone: "bad" }));
      return saves.current;
    },
    [client, updateProject, projectId],
  );
}
