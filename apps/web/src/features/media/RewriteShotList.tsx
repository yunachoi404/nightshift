/**
 * "Rewrite shot list": the writer writes a film's shot list again from its brief, at any time, from the main board's
 * menu (the single board's More, a canvas board's menu). Its confirm says plainly what stays: locked shots keep their
 * stills and takes, and a shot the new list replaces keeps whatever was made for it, off the timeline.
 */
import type { Job, Project } from "@nightshift/contract";
import { useCallback, useState, type ReactNode } from "react";
import { useEngine } from "@/store/engine";
import { Button, Dialog, toast } from "@/ui/primitives";
import { isActive } from "@/features/project/helpers";

/** Films start with a shot list from their brief, and can have it written again. */
export const FILMS = new Set<Project["template"]>(["cinematic_shot", "music_video", "product_ad", "talking_intro", "micro_drama"]);

/**
 * The rewrite's confirm, and what opens it: undefined for a project with no shot list to write, and while the writer
 * is at work on this one.
 */
export function useRewriteShotList(project: Project, jobs: Job[]): { open: (() => void) | undefined; dialog: ReactNode } {
  const { storyboard } = useEngine();
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const show = useCallback(() => setShown(true), []);
  const writing = jobs.some((j) => j.step === "text" && isActive(j));
  const rewrite = async () => {
    setBusy(true);
    try {
      await storyboard(project.id);
      setShown(false);
    } catch (e) {
      toast({ title: "Couldn't rewrite the shot list", text: e instanceof Error ? e.message : String(e), tone: "bad" });
    } finally {
      setBusy(false);
    }
  };
  const dialog = (
    <Dialog open={shown} onClose={() => !busy && setShown(false)} width={480}>
      <h2 className="dialog__title">Rewrite the shot list?</h2>
      <p className="dialog__text">The writer drafts new shots from your brief, then draws a still for each one.</p>
      <p className="dialog__text">Locked shots keep their place, their stills and their takes. Any other shot with a still or a video stays on the board, off the timeline, so nothing you made is deleted.</p>
      <div className="dialog__actions">
        <Button onClick={() => setShown(false)} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" busy={busy} onClick={() => void rewrite()}>
          Rewrite shot list
        </Button>
      </div>
    </Dialog>
  );
  return { open: FILMS.has(project.template) && !writing ? show : undefined, dialog };
}
