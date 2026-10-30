import type { Job } from "@nightshift/contract";
import { ListTodo } from "lucide-react";
import { Link } from "react-router";
import { useEngine, useEngineState, useJobs } from "@/store/engine";
import { Button, Tag, cx } from "@/ui/primitives";
import { failureReason, isGpuJob, jobLabel, jobStage, jobStatusLine, timelineShots } from "@/features/project/helpers";
import { useNow } from "@/lib/useNow";
import { clock, pct, plural, relativeTime } from "@/lib/format";
import { insideWindow } from "@/lib/overnight";
import "./queue.css";
import { useThisMachine } from "@/store/tier";
import { groupName, nightTurn, tonightGroups } from "./tonight";

export function QueuePage() {
  const jobs = useJobs();
  const { projects, settings, status } = useEngineState();
  const { cancelJob } = useEngine();
  const running = jobs.filter((j) => j.status === "running");
  const queued = jobs.filter((j) => j.status === "queued");
  const waiting = queued.filter((j) => j.mode !== "overnight");
  // Finals for the night run in groups that share a model, in the order the engine runs them.
  const tonight = tonightGroups(jobs, nightTurn(jobs));
  // The clock moves while something runs, and while finals wait for the window to open.
  const now = useNow(1000, running.length > 0 || tonight.length > 0);
  const runningTonight = running.find((j) => j.mode === "overnight");
  const night = settings?.overnight;
  const nightOpen = !!runningTonight || (!!night?.enabled && insideWindow(night.startAt, night.endAt, now));
  const recent = jobs
    .filter((j) => j.status === "done" || j.status === "failed" || j.status === "cancelled")
    .slice(-30)
    .reverse();
  const remote = status?.mode === "remote" ? settings?.remote : null;
  const here = useThisMachine();
  const where = remote ? (remote.name ?? remote.url) : here.lower;

  const name = (j: Job) => projects[j.projectId]?.name ?? "Project";
  // Its place in the cut. A shot kept in Media only has no number.
  const shotNo = (j: Job) => {
    const p = projects[j.projectId];
    const idx = p ? timelineShots(p).findIndex((s) => s.id === j.shotId) : -1;
    return idx >= 0 ? `shot ${idx + 1}` : null;
  };
  const label = (j: Job) => [jobLabel(j, projects[j.projectId]), shotNo(j)].filter(Boolean).join(", ");
  /** What a final for the night waits for: the engine's message, else its place tonight. */
  const tonightStatus = (j: Job, first: boolean) => {
    if (j.message) return jobStage(j);
    if (!night) return "Queued for tonight";
    if (!night.enabled) return "Paused in Settings";
    if (!nightOpen) return `Starts at ${clock(night.startAt)}`;
    return first ? "Next up" : "In line";
  };
  const waitingRow = (j: Job, status: string) => (
    <div key={j.id} className="group__row q-item">
      <span className="pulse pulse--idle" />
      <div className="q-item__main">
        <div className="q-item__name">{label(j)}</div>
        <div className="q-item__sub">
          <Link to={`/p/${j.projectId}`}>{name(j)}</Link>
          <span>{status}</span>
        </div>
      </div>
      <Button size="s" variant="quiet" onClick={() => void cancelJob(j.id)}>
        Remove
      </Button>
    </div>
  );

  return (
    <div className="page page--narrow">
      <div className="page__head">
        <div>
          <h1 className="page__title">Queue</h1>
          <p className="page__sub">
            Generation runs one job at a time on {where}. {remote ? `Exports and audio timing run on ${here.lower}. ` : ""}{status?.comfyui.running === false ? (remote ? `${where} is not answering right now. Queued generation starts on its own when it is back.` : "The GPU is away right now. Queued generation starts when it is back.") : "Quick work goes first. Overnight finals wait for the window in Settings."}
          </p>
        </div>
      </div>

      {!running.length && !queued.length && !recent.length && (
        <div className="empty">
          <ListTodo className="empty__icon" />
          <div className="empty__title">Nothing in the queue</div>
          <p className="empty__text">Stills, drafts, finals, music, voice and exports show up here as they run.</p>
        </div>
      )}

      {running.length > 0 && (
        <section className="q-group">
          <div className="group__head">Running</div>
          <div className="group">
            {running.map((j) => (
              <div key={j.id} className="group__row q-item">
                <span className={cx("pulse", j.mode === "overnight" ? "pulse--night" : "")} />
                <div className="q-item__main">
                  <div className="q-item__name">{label(j)}</div>
                  <div className="q-item__sub">
                    <Link to={`/p/${j.projectId}`}>{name(j)}</Link>
                    <span>
                      {jobStatusLine(j, now)}, {pct(j.progress)}
                    </span>
                  </div>
                  <div className={cx("bar q-item__bar", j.mode === "overnight" && "bar--night")}>
                    <div className="bar__fill" style={{ width: `${j.progress * 100}%` }} />
                  </div>
                </div>
                <Button size="s" variant="quiet" onClick={() => void cancelJob(j.id)}>
                  Cancel
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      {waiting.length > 0 && (
        <section className="q-group">
          <div className="group__head">Waiting</div>
          <div className="group">{waiting.map((j) => waitingRow(j, j.message ? jobStage(j) : "Next up"))}</div>
        </section>
      )}

      {tonight.length > 0 && (
        <section className="q-group">
          <div className="group__head">Tonight</div>
          {tonight.length > 1 && <p className="q-note">Finals that share a model run back to back, so each model loads once. Groups go in the order you queued them.</p>}
          <div className="group">
            {tonight.map((g, gi) => {
              // The group on the GPU now: one of its finals runs above, these follow while its model is loaded.
              const more = runningTonight !== undefined && runningTonight.nightGroup === g.jobs[0]!.nightGroup;
              const count = more ? plural(g.jobs.length, "more final", "more finals") : plural(g.jobs.length, "final");
              return (
                <div key={g.jobs[0]!.id} className="q-batch" role="group" aria-label={`${groupName(g)}, ${count}`}>
                  <div className="q-batch__head">
                    <span className="q-batch__model">{groupName(g)}</span>
                    <span className="q-batch__count">{count}</span>
                  </div>
                  {g.jobs.map((j, i) => waitingRow(j, tonightStatus(j, gi === 0 && i === 0 && !waiting.some(isGpuJob))))}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {recent.length > 0 && (
        <section className="q-group">
          <div className="group__head">Recent</div>
          <div className="group">
            {recent.map((j) => (
              <div key={j.id} className="group__row q-item">
                <span className={cx("pulse", j.status === "done" ? "pulse--ok" : j.status === "failed" ? "pulse--bad" : "pulse--idle")} />
                <div className="q-item__main">
                  <div className="q-item__name">{label(j)}</div>
                  <div className="q-item__sub">
                    <Link to={`/p/${j.projectId}`}>{name(j)}</Link>
                  </div>
                  {j.status === "failed" && (
                    <div className="q-item__reason" title={j.error}>
                      {failureReason(j)}
                    </div>
                  )}
                </div>
                {/* One column for every row, so the times and the outcomes line up. */}
                <div className="q-item__end">
                  <span className="t-num">{j.finishedAt ? relativeTime(j.finishedAt) : ""}</span>
                  <span className={cx(j.status === "failed" && "q-item__bad")}>{j.status === "failed" ? "Failed" : j.status === "cancelled" ? "Cancelled" : "Done"}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
