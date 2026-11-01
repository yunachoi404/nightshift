/**
 * Finish N shots tonight: one press queues tonight's final of every picked take in the cut that has none yet, after one
 * confirmation that says when they start, how long they take and when they should be done. On the board's header and
 * in the editor's Export panel. Nothing shows while there is nothing to finish or the setup makes no finals.
 */
import type { Job, Project } from "@nightshift/contract";
import { Moon } from "lucide-react";
import { useState } from "react";
import { useEngine, useEngineState, useJobs } from "@/store/engine";
import { useInstalledTier } from "@/store/tier";
import { Button, Dialog, cx, toast } from "@/ui/primitives";
import { clock, clockFromDate, plural, shortDuration } from "@/lib/format";
import { nextWindowStart, tonightStart, windowEndsAt } from "@/lib/overnight";
import { tonightSeconds } from "@/features/queue/plan";
import { finalKindFor, finalSecondsFor, unfinishedPicks } from "./finishAll";
import "./finals.css";

/**
 * `quiet`: a plain button with the night's moon, beside another warm action (the editor's Export video), so a panel has
 * one warm button. Otherwise the night's amber.
 */
export function FinishTonight({ project, jobs, quiet, className }: { project: Project; jobs: Job[]; quiet?: boolean; className?: string }) {
  const { client, final, updateSettings } = useEngine();
  const { settings } = useEngineState();
  const allJobs = useJobs();
  const tier = useInstalledTier();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const kind = finalKindFor(tier);
  const shots = unfinishedPicks(project, jobs);
  if (!kind || !shots.length) return null;

  const night = settings?.overnight ?? { enabled: true, startAt: "23:00", endAt: "07:00" };
  const now = Date.now();
  const start = tonightStart(night, now);
  const seconds = shots.reduce((sum, s) => sum + finalSecondsFor(project, s, tier, kind), 0);
  // The finals already queued for tonight run first, then these, from now while the window is open, else from when it opens.
  const from = start.open ? now : nextWindowStart(night.startAt, now).getTime();
  const doneBy = new Date(from + (tonightSeconds(allJobs, tier, now) + seconds) * 1000);
  // A final that would start once the window has closed waits for the next night, as the engine holds it.
  const closes = windowEndsAt(night.startAt, night.endAt, now);
  const fits = doneBy <= closes;
  const label = `Finish ${plural(shots.length, "shot")} tonight`;

  const queue = async () => {
    setBusy(true);
    let queued = 0;
    try {
      if (!night.enabled) {
        const latest = await client.settings();
        await updateSettings({ overnight: { ...latest.overnight, enabled: true } });
      }
      for (const s of shots) {
        await final(project.id, s.id, { draftId: s.chosenDraftId!, kind, mode: "overnight" });
        queued += 1;
      }
      setOpen(false);
      toast({ title: `${plural(queued, "final")} queued for tonight`, text: tonightStart(night, Date.now()).text, tone: "night" });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      toast({ title: queued ? `Queued ${queued} of ${shots.length} finals` : "Couldn't queue the finals", text: why, tone: "bad" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button size="s" variant={quiet ? "ghost" : "night"} icon={<Moon />} className={cx(quiet && "finish-tonight--quiet", className)} title="Queue the final of every picked take on the timeline" onClick={() => setOpen(true)}>
        {label}
      </Button>
      <Dialog open={open} onClose={() => !busy && setOpen(false)} width={480}>
        <div className="night">
          <div className="night__head">
            <span className="night__moon" aria-hidden>
              <Moon />
            </span>
            <div>
              <h2 className="dialog__title">{label}?</h2>
              <p className="dialog__text">
                {start.open ? "The night shift is on now. Once the GPU is free, Nightshift" : `At ${clock(night.startAt)} Nightshift`} renders the picked take of {shots.length === 1 ? "the shot" : `each of the ${shots.length} shots`} on the timeline at full quality, one after another. In the morning they are on their cards and in the editor.
              </p>
            </div>
          </div>
          <div className="night__rows">
            <div className="night__row">
              <small>Finals</small>
              <b>{shots.length}</b>
            </div>
            <div className="night__row">
              <small>Takes about</small>
              <b>{shortDuration(seconds)}</b>
            </div>
            <div className="night__row">
              <small>{fits ? "Done around" : "The night ends"}</small>
              <b>{clockFromDate(fits ? doneBy : closes)}</b>
            </div>
          </div>
          {!fits && <p className="t-small">Not all of them fit before {clockFromDate(closes)}. The rest run the next night.</p>}
          <p className="t-small t-muted">
            Keep the computer awake and plugged in. The desktop app keeps it awake for you.{night.enabled ? "" : " This turns overnight runs on. Pause them in Settings."}
          </p>
          <div className="dialog__actions">
            <Button onClick={() => setOpen(false)} disabled={busy}>
              Not now
            </Button>
            <Button variant="night" icon={<Moon />} busy={busy} autoFocus onClick={() => void queue()}>
              Queue {plural(shots.length, "final")}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
