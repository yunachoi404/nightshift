/**
 * The editor's saves: cards on and off the timeline, their order, the song and the voiceover, and the timeline's style.
 * Each save reads the latest project, changes it and sends one PATCH, one after another, so quick edits never undo each
 * other. The engine cuts the film again after each save and the project event redraws the editor.
 */
import type { Project, Shot } from "@nightshift/contract";
import { useCallback, useMemo, useRef } from "react";
import type { ProjectPatch } from "@/api/client";
import { changesCut, cutShots, placeOnTimeline, soundOff, takeOffTimeline, type TimelineEdit } from "@/features/media/items";
import { useEngine } from "@/store/engine";
import { toast } from "@/ui/primitives";

export interface CutEdits {
  /** Saves a change made to the latest project. Nothing is sent when `change` returns undefined. */
  save(change: (latest: Project) => ProjectPatch | undefined): Promise<void>;
  /**
   * Puts cards on the timeline (shots, images, songs, voiceovers) in front of the first shot of `before` that stays on
   * it, or at the end. `before` is the timeline's shots from the drop point on, as the editor showed them.
   */
  place(items: string[], before?: string[]): Promise<void>;
  /** Takes a shot off the timeline. It stays in Media. */
  takeOff(shotId: string): Promise<void>;
  /** Takes the song or the voiceover off the timeline. */
  soundOff(role: "music" | "voice"): Promise<void>;
}

/** The PATCH that puts `items` on the timeline before the first of `before` that stays; undefined when nothing changes. */
export function placeBefore(project: Project, items: string[], before: string[] = []): ProjectPatch | undefined {
  const moving = new Set(items);
  const rest = cutShots(project).filter((s) => !moving.has(s.id));
  const next = before.find((id) => !moving.has(id) && rest.some((s) => s.id === id));
  const edit = placeOnTimeline(project, items, next ? rest.findIndex((s) => s.id === next) : undefined);
  const order = (shots: Shot[]) => cutShots({ shots }).map((s) => s.id).join(" ");
  const sound = edit.soundtrack && (edit.soundtrack.music !== project.soundtrack?.music || edit.soundtrack.voice !== project.soundtrack?.voice);
  if (!sound && edit.shots.length === project.shots.length && order(edit.shots) === order(project.shots)) return undefined;
  return patchOf(edit);
}

function patchOf(edit: Partial<TimelineEdit>): ProjectPatch {
  return { ...(edit.shots ? { shots: edit.shots } : {}), ...(edit.boards ? { boards: edit.boards } : {}), ...(edit.soundtrack ? { soundtrack: edit.soundtrack } : {}) };
}

/** When the edited-cut note last showed. Quick edits in a row (a duration stepped up) show it once. */
let notedAt = 0;

/**
 * After a save: a cut edited by hand keeps its clips until it is re-cut (the song and the voice still change at once),
 * so a change to what the cut is made of says so, and where to re-cut it.
 */
export function noteEditedCut(latest: Project, patch: ProjectPatch, from: "editor" | "media"): void {
  if (!latest.timeline?.edited || !changesCut(latest, patch)) return;
  if (Date.now() - notedAt < 4000) return;
  notedAt = Date.now();
  const where = from === "editor" ? "Choose Re-cut, under the player," : "Open the editor and choose Re-cut";
  toast({ title: "This cut was edited by hand", text: `It keeps its clips until you re-cut it. ${where} to lay out the timeline with your change.` });
}

export function useCutEdits(projectId: string): CutEdits {
  const { client, updateProject } = useEngine();
  const saves = useRef(Promise.resolve());
  const save = useCallback(
    (change: (latest: Project) => ProjectPatch | undefined) => {
      saves.current = saves.current
        .then(async () => {
          const latest = await client.getProject(projectId);
          const patch = change(latest);
          if (!patch) return;
          await updateProject(projectId, patch);
          noteEditedCut(latest, patch, "editor");
        })
        .catch((e) => toast({ title: "Couldn't save", text: e instanceof Error ? e.message : String(e), tone: "bad" }));
      return saves.current;
    },
    [client, updateProject, projectId],
  );
  return useMemo<CutEdits>(
    () => ({
      save,
      place: (items, before) => save((p) => placeBefore(p, items, before)),
      takeOff: (shotId) => save((p) => (cutShots(p).some((s) => s.id === shotId) ? patchOf(takeOffTimeline(p, shotId)) : undefined)),
      soundOff: (role) => save((p) => patchOf(soundOff(p, role))),
    }),
    [save],
  );
}
