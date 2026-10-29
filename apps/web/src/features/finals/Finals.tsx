import type { FinalKind, Job, Project, Shot } from "@nightshift/contract";
import { Film, Moon, Share2, Sparkles, Sun, Sunrise } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useEngine, useEngineState, useProject, useProjectJobs } from "@/store/engine";
import { upscaleOnly, useInstalledTier } from "@/store/tier";
import { Button, Dialog, Notice, Tag, cx, toast, radioGroupKeyDown } from "@/ui/primitives";
import { Media } from "@/media/Media";
import { activeJob, bestAssetFor, draftsFor, failureText, frameClass, jobLabel, jobStatusLine, lastFailed, takeById } from "@/features/project/helpers";
import { useNow } from "@/lib/useNow";
import { clock, clockFromDate, plural, roughDuration, shortDuration } from "@/lib/format";
import { useMorningSummary } from "./morning";
import { RevealSheet } from "@/features/reveal/RevealSheet";
import { revealable } from "@/features/reveal/reveal";
import "./finals.css";

export function Finals() {
  const { id } = useParams();
  const project = useProject(id)!;
  return <ProjectFinals key={project.id} project={project} />;
}

function ProjectFinals({ project }: { project: Project }) {
  const jobs = useProjectJobs(project.id);
  const { settings } = useEngineState();
  const { final, cancelJob, client, updateSettings } = useEngine();
  const tier = useInstalledTier();
  const nav = useNavigate();
  const morning = useMorningSummary(project.id);

  const canRemaster = project.template !== "what_if" && (tier?.steps?.includes("video_final_remaster") ?? false);
  // Small setups only upscale the draft for a "final". Their copy says so, and never "sharper".
  const upscale = upscaleOnly(tier);
  const [kind, setKind] = useState<FinalKind>("same_take");
  const effectiveKind: FinalKind = canRemaster ? kind : "same_take";
  const [selected, setSelected] = useState<Set<string>>(() => new Set(project.shots.filter((s) => s.chosenDraftId && !s.chosenFinalId).map((s) => s.id)));
  const [nightOpen, setNightOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const step = effectiveKind === "remaster" ? "video_final_remaster" : "video_final_same_take";
  const durationFactor = project.template === "what_if" ? 15 / 4 : 1;
  const perSec = (tier?.estimates?.[step]?.seconds ?? (effectiveKind === "remaster" ? 360 : 180)) * durationFactor;
  const selectable = project.shots.filter((s) => s.chosenDraftId && !activeJob(jobs, s.id, ["video_final_same_take", "video_final_remaster"]));
  const chosen = selectable.filter((s) => selected.has(s.id));
  const totalSec = chosen.length * perSec;

  const isFinal = (j: Job) => j.step === "video_final_same_take" || j.step === "video_final_remaster";
  // Each job's own kind sets its time, not the kind selected above.
  const secondsLeft = (j: Job) => (tier?.estimates?.[j.step as "video_final_same_take" | "video_final_remaster"]?.seconds ?? (j.step === "video_final_remaster" ? 360 : 180)) * durationFactor * (1 - j.progress);
  const overnightJobs = jobs.filter((j) => j.mode === "overnight" && (j.status === "queued" || j.status === "running"));
  const renderingNow = jobs.filter((j) => j.mode === "now" && isFinal(j) && j.status === "running");
  const waitingNow = jobs.filter((j) => j.mode === "now" && isFinal(j) && j.status === "queued");
  const otherWork = jobs.find((j) => j.status === "running" && !isFinal(j));
  const tonightSec = overnightJobs.reduce((s, j) => s + secondsLeft(j), 0);
  const startAt = settings?.overnight.startAt ?? "23:00";
  const endAt = settings?.overnight.endAt ?? "07:00";
  const overnightEnabled = settings?.overnight.enabled ?? true;
  const overnightRunning = overnightJobs.some((j) => j.status === "running");
  const now = useNow(1000, overnightJobs.length > 0 || renderingNow.length > 0);
  const doneBy = useMemo(() => {
    // Running already, or inside the window: count from now. Otherwise from the next time the window opens.
    const from = overnightRunning || insideWindow(startAt, endAt, now) ? new Date(now) : nextWindowStart(startAt, now);
    return new Date(from.getTime() + tonightSec * 1000);
  }, [startAt, endAt, tonightSec, overnightRunning, now]);

  const submit = async (mode: "now" | "overnight") => {
    setBusy(true);
    try {
      if (mode === "overnight") {
        const latest = await client.settings();
        await updateSettings({ overnight: { ...latest.overnight, enabled: true } });
      }
      for (const s of chosen) await final(project.id, s.id, { draftId: s.chosenDraftId!, kind: effectiveKind, mode });
      setSelected(new Set());
      if (mode === "now") toast({ title: `Finishing ${plural(chosen.length, "shot")}`, text: `${cap(roughDuration(totalSec))} in all. You can keep working.`, tone: "accent" });
      else {
        setNightOpen(false);
        toast({ title: `${plural(chosen.length, "final")} queued for tonight`, text: `Starts at ${clock(startAt)}.`, tone: "night" });
      }
    } catch (e) {
      toast({ title: "Couldn't queue the finals", text: e instanceof Error ? e.message : String(e), tone: "bad" });
    } finally {
      setBusy(false);
    }
  };

  const startNow = async () => {
    // Re-submit tonight's finals as "now". The engine runs them in order right away.
    setBusy(true);
    try {
      for (const j of overnightJobs.filter((j) => j.status === "queued")) {
        const shot = project.shots.find((s) => s.id === j.shotId);
        if (!shot?.chosenDraftId) continue;
        await cancelJob(j.id);
        await final(project.id, shot.id, { draftId: shot.chosenDraftId, kind: j.step === "video_final_remaster" ? "remaster" : "same_take", mode: "now" });
      }
      toast({ title: "Running the overnight queue now", tone: "night" });
    } catch (e) {
      toast({ title: "Couldn't start", text: String(e), tone: "bad" });
    } finally {
      setBusy(false);
    }
  };

  const allFinal = project.shots.length > 0 && project.shots.every((s) => s.chosenFinalId);
  const toggle = (sid: string) =>
    setSelected((set) => {
      const n = new Set(set);
      if (n.has(sid)) n.delete(sid);
      else n.add(sid);
      return n;
    });

  if (!project.shots.length) {
    return (
      <div className="page">
        <div className="empty">
          <Film className="empty__icon" />
          <div className="empty__title">Nothing to finish yet</div>
          <p className="empty__text">{upscale ? `Finals are the takes you pick, upscaled${upscale.to}.` : "Finals are full-quality renders of the takes you pick."} Start with the storyboard.</p>
          <Link to={`/p/${project.id}/storyboard`} className="btn btn--primary">
            Go to the storyboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="split">
      <div className="page">
        <div className="page__head">
          <div>
            <h1 className="page__title">Finals</h1>
            <p className="page__sub">{upscale ? `The takes you picked, upscaled${upscale.to}.` : "Full-quality renders of the takes you picked."} Finish now while you watch, or queue them for tonight and find them done in the morning.</p>
          </div>
          <div className="page__actions">
            {allFinal && (
              <Button variant="primary" onClick={() => nav(`/p/${project.id}/editor`)}>
                Open the editor
              </Button>
            )}
          </div>
        </div>

        {morning && (
          <div className="morning" role="status">
            <Sunrise />
            <div className="morning__body">
              <div className="morning__title">While you slept</div>
              <div className="morning__text">
                {morning.done ? `${plural(morning.done, "final")} finished.` : "No finals finished."} {morning.failed ? `${morning.failed} didn't work, see below.` : ""}
              </div>
            </div>
            <div className="morning__actions">
              <Button variant="quiet" size="s" onClick={morning.dismiss}>
                Got it
              </Button>
            </div>
          </div>
        )}

        <div className="fn-kind" role="radiogroup" aria-label="Kind of final" onKeyDown={radioGroupKeyDown}>
          <button type="button" className="kind" role="radio" aria-checked={effectiveKind === "same_take"} tabIndex={effectiveKind === "same_take" ? 0 : -1} onClick={() => setKind("same_take")}>
            <span className="kind__name">
              Same take
              <Tag tone="ok">What you saw</Tag>
            </span>
            <span className="kind__text">{upscale ? `The exact take you picked, upscaled${upscale.to}. Same motion, same framing. It adds no detail.` : "Renders the exact take you picked at full quality. Same motion, same framing, sharper."} {tier?.estimates?.video_final_same_take?.seconds ? `${cap(roughDuration(perSec))} ${project.template === "what_if" ? "for the film" : "a shot"}.` : ""}</span>
          </button>
          <button type="button" className="kind" role="radio" aria-checked={effectiveKind === "remaster"} tabIndex={effectiveKind === "remaster" ? 0 : -1} disabled={!canRemaster} onClick={() => setKind("remaster")}>
            <span className="kind__name">
              Remaster
              <Tag tone="night">
                <Sparkles /> Best quality
              </Tag>
            </span>
            <span className="kind__text">
              {canRemaster
                ? `A stronger model re-renders the shot using your take as the guide. Usually better, can drift a little. ${tier?.estimates?.video_final_remaster?.seconds ? `${cap(roughDuration(tier.estimates.video_final_remaster.seconds))} a shot, best overnight.` : "Best overnight."}`
                : project.template === "what_if" ? "Use Same take to keep the whole film. Remaster is not available for this template."
                  : "Remastering is not available on this setup yet. You can still finish your drafts with Same take."}
            </span>
          </button>
        </div>

        <div className="fn-list">
          <div className="fn-list__head">
            <label className="fn-list__all">
              <input type="checkbox" className="check" aria-label="Select every shot that can be finished" checked={selectable.length > 0 && chosen.length === selectable.length} disabled={!selectable.length} onChange={(e) => setSelected(e.target.checked ? new Set(selectable.map((s) => s.id)) : new Set())} />
              <span>{chosen.length ? `${chosen.length} of ${selectable.length} selected` : selectable.length ? "Select shots to finish" : "No shots can be finished yet"}</span>
            </label>
          </div>
          {project.shots.map((s, i) => (
            <FinalRow key={s.id} project={project} shot={s} index={i} jobs={jobs} now={now} selected={selected.has(s.id)} selectable={selectable.includes(s)} onToggle={() => toggle(s.id)} onRetry={(k, mode) => s.chosenDraftId && void final(project.id, s.id, { draftId: s.chosenDraftId, kind: k, mode })} onCancel={(j) => void cancelJob(j.id)} />
          ))}
        </div>
      </div>

      <aside className="inspector" aria-label="Finish">
        <section className="insp">
          <div className="insp__head">
            <span className="insp__title">Finish</span>
            <span className="t-small t-muted">{effectiveKind === "remaster" ? "Remaster" : "Same take"}</span>
          </div>
          <div className="insp__kv">
            <span>Selected</span>
            <b>{chosen.length ? plural(chosen.length, "shot") : "None"}</b>
          </div>
          <div className="insp__kv">
            <span>Now, takes</span>
            <b>{chosen.length ? roughDuration(totalSec) : "None"}</b>
          </div>
          <div className="insp__kv">
            <span>Tonight, done by</span>
            <b>{chosen.length ? clockFromDate(new Date(doneBy.getTime() + totalSec * 1000)) : "None"}</b>
          </div>
          <div className="fn-actions">
            <Button variant="primary" icon={<Sun />} disabled={!tier || !chosen.length} busy={busy} onClick={() => void submit("now")}>
              Finish now
            </Button>
            <Button variant="night" icon={<Moon />} disabled={!tier || !chosen.length || busy} onClick={() => setNightOpen(true)}>
              Finish overnight
            </Button>
          </div>
          {!chosen.length && <div className="insp__text">Tick the shots on the left. Shots need a picked take first.</div>}
          {chosen.length > 0 && selectable.length !== project.shots.length && <div className="insp__text">{project.shots.length - selectable.length} {project.shots.length - selectable.length === 1 ? "shot needs a picked take or is already rendering." : "shots need a picked take or are already rendering."}</div>}
        </section>

        {overnightJobs.length > 0 && (
          <section className="insp insp--night">
            <div className="insp__head">
              <span className="insp__title">
                <Moon className="insp__icon" /> Tonight
              </span>
              {overnightRunning && <Tag tone="night">Running</Tag>}
            </div>
            <div className="insp__kv">
              <span>Queued</span>
              <b>{plural(overnightJobs.length, "final")}</b>
            </div>
            <div className="insp__kv">
              <span>Starts</span>
              <b>{overnightRunning ? "Running now" : overnightEnabled ? clock(startAt) : "Paused in Settings"}</b>
            </div>
            <div className="insp__kv">
              <span>Done by</span>
              <b>{overnightEnabled ? `about ${clockFromDate(doneBy)}` : "When runs resume"}</b>
            </div>
            <div className="insp__text">Keep the computer awake and plugged in. A summary waits here in the morning.</div>
            {overnightJobs.some((j) => j.status === "queued") && !overnightRunning && (
              <div>
                <Button size="s" busy={busy} onClick={() => void startNow()}>
                  Start now instead
                </Button>
              </div>
            )}
          </section>
        )}

        {(renderingNow.length > 0 || waitingNow.length > 0) && (
          <section className="insp">
            <div className="insp__head">
              <span className="insp__title">{renderingNow.length ? "Rendering" : "Waiting"}</span>
            </div>
            {renderingNow.length > 0 && (
              <div className="insp__text">
                {plural(renderingNow.length, "final")} rendering now, {shortDuration(renderingNow.reduce((s, j) => s + secondsLeft(j), 0))} left.
              </div>
            )}
            {waitingNow.length > 0 && (
              <div className="insp__text">
                {plural(waitingNow.length, "final")} waiting{otherWork ? ` for the GPU to finish ${jobLabel(otherWork, project).toLowerCase()}` : renderingNow.length ? " in line" : " for the GPU"}, about {shortDuration(waitingNow.reduce((s, j) => s + secondsLeft(j), 0))} of work.
              </div>
            )}
          </section>
        )}
      </aside>

      <Dialog open={nightOpen} onClose={() => setNightOpen(false)} width={480}>
        <div className="night">
          <div className="night__head">
            <span className="night__moon" aria-hidden>
              <Moon />
            </span>
            <div>
              <h2 className="dialog__title">Tonight, while you sleep</h2>
              <p className="dialog__text">
                At {clock(startAt)} Nightshift renders {plural(chosen.length, "final")} at the heaviest settings this machine allows, one after another. In the morning the finals are here, with a note on how it went.
              </p>
            </div>
          </div>
          <div className="night__rows">
            <div className="night__row">
              <small>Finals</small>
              <b>{chosen.length}</b>
            </div>
            <div className="night__row">
              <small>Takes about</small>
              <b>{shortDuration(totalSec + tonightSec)}</b>
            </div>
            <div className="night__row">
              <small>Done around</small>
              <b>{clockFromDate(new Date(doneBy.getTime() + totalSec * 1000))}</b>
            </div>
          </div>
          <p className="t-small t-muted">Keep the computer awake and plugged in. The desktop app keeps it awake for you. Change the window in Settings.</p>
          {!overnightEnabled && <p className="t-small t-muted">This turns overnight runs on. Pause them in Settings.</p>}
          <div className="dialog__actions">
            <Button onClick={() => setNightOpen(false)}>Not now</Button>
            <Button variant="night" icon={<Moon />} busy={busy} autoFocus onClick={() => void submit("overnight")}>
              Queue for tonight
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function FinalRow({
  project,
  shot,
  index,
  jobs,
  now,
  selected,
  selectable,
  onToggle,
  onRetry,
  onCancel,
}: {
  project: Project;
  shot: Shot;
  index: number;
  jobs: Job[];
  now: number;
  selected: boolean;
  selectable: boolean;
  onToggle: () => void;
  onRetry: (kind: FinalKind, mode: "now" | "overnight") => void;
  onCancel: (j: Job) => void;
}) {
  const { client } = useEngine();
  const upscale = upscaleOnly(useInstalledTier());
  const best = bestAssetFor(project, shot);
  const finalTake = takeById(project, shot.chosenFinalId);
  const working = activeJob(jobs, shot.id, ["video_final_same_take", "video_final_remaster"]);
  const failed = !working && !finalTake ? lastFailed(jobs, shot.id, ["video_final_same_take", "video_final_remaster"]) : undefined;
  const drafts = draftsFor(project, shot);
  const takeNo = drafts.findIndex((d) => d.id === shot.chosenDraftId) + 1;
  const canReveal = Boolean(revealable(project, shot));
  const [revealOpen, setRevealOpen] = useState(false);

  return (
    <div className={cx("fn-row", project.aspect === "9:16" && "fn-row--tall")}>
      <div className="fn-row__check">
        <input type="checkbox" className="check" checked={selected} disabled={!selectable} onChange={onToggle} aria-label={`Select shot ${index + 1}`} />
      </div>
      <div className="fn-row__thumb">
        <div className={cx("frame", frameClass(project.aspect), !best && "frame--empty")}>
          {best && <Media src={client.assetUrl(project.id, best.asset.id)} kind={best.rung === "still" ? "image" : "video"} />}
          {best?.rung === "final" && (
            <div className="frame__corner">
              <Tag onMedia tone="night">Final</Tag>
            </div>
          )}
        </div>
      </div>
      <div className="fn-row__text">
        <div className="fn-row__title">
          <span className="fn-row__n">Shot {index + 1}</span>
          <span className="t-small t-muted">
            {shot.durationSec} s{takeNo ? `, take ${takeNo}` : ""}
          </span>
        </div>
        <div className="fn-row__prompt">{shot.prompt}</div>
      </div>
      <div className={cx("fn-row__state", failed && "fn-row__state--bad")}>
        {working ? (
          <>
            <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
              <span>{jobStatusLine(working, now)}</span>
              {working.status === "running" && <span className="t-num">{Math.round(working.progress * 100)}%</span>}
            </span>
            <div className={cx("bar", working.mode === "overnight" && "bar--night")}>
              <div className="bar__fill" style={{ width: `${working.progress * 100}%` }} />
            </div>
            <div>
              <Button size="s" variant="quiet" onClick={() => onCancel(working)}>
                Cancel
              </Button>
            </div>
          </>
        ) : failed ? (
          <>
            <span>{failed.message ?? "Didn't work"}</span>
            <span className="t-micro t-muted">{failureText(failed)}</span>
            <span style={{ display: "flex", gap: 8 }}>
              <Button size="s" onClick={() => onRetry(failed.step === "video_final_remaster" ? "remaster" : "same_take", "now")}>
                Try again
              </Button>
              <Button size="s" variant="quiet" onClick={() => onRetry(failed.step === "video_final_remaster" ? "remaster" : "same_take", "overnight")}>
                Tonight
              </Button>
            </span>
          </>
        ) : finalTake ? (
          <>
            <Tag tone="night">{finalTake.finalKind === "remaster" ? "Final, remastered" : "Final, same take"}</Tag>
            <span className="t-micro t-muted">{upscale && finalTake.finalKind !== "remaster" ? `Upscaled${upscale.to}.` : "Full quality."} Shown in the editor.</span>
            {canReveal && (
              <>
                <Button size="s" className="rv-open" icon={<Share2 />} onClick={() => setRevealOpen(true)}>
                  Share reveal
                </Button>
                <RevealSheet project={project} shot={shot} open={revealOpen} onClose={() => setRevealOpen(false)} />
              </>
            )}
          </>
        ) : shot.chosenDraftId ? (
          <>
            <span>Take {takeNo} picked</span>
            <span className="t-micro t-muted">Ready to finish.</span>
          </>
        ) : (
          <>
            <span>No take picked</span>
            <Link to={`/p/${project.id}/takes?shot=${shot.id}`} className="t-micro">
              Pick one in Takes
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

export function finalsSummary(p: Project): string {
  const n = p.shots.filter((s) => s.chosenFinalId).length;
  return `${n} of ${p.shots.length}`;
}

/** Minutes since midnight of "HH:MM". */
function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** True while the clock is inside the overnight window, which usually crosses midnight. */
export function insideWindow(startAt: string, endAt: string, now: number): boolean {
  const d = new Date(now);
  const cur = d.getHours() * 60 + d.getMinutes();
  const start = minutesOf(startAt);
  const end = minutesOf(endAt);
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

/** The next time the window opens: today if still ahead, else tomorrow. */
export function nextWindowStart(startAt: string, now: number): Date {
  const d = new Date(now);
  const [h, m] = startAt.split(":").map(Number);
  d.setHours(h ?? 23, m ?? 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d;
}
