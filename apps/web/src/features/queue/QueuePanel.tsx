/**
 * The Queue. What the GPU is making now leads the page as its one big picture, with its moon, how far along it is and
 * the time it has left; the exports and song timing that run beside it on the CPU sit under it. Then the GPU's line on
 * a time rail, in the order it runs, each job at the time it should start: the work for now, then tonight's finals in
 * the groups that share a model, under the night's arc. What finished, and what failed with a way to try again, keeps a
 * column of its own beside them. Every section shows even when it is empty, saying what goes in it, so the page always
 * reads as the queue.
 */
import type { Job, Project, TierSummary } from "@nightshift/contract";
import { FileText, Film, Mic, Moon as MoonIcon, Music2, RotateCcw, X } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useCompute } from "@/app/ComputePopover";
import { retryFor } from "@/features/media/items";
import { failureReason, fitFor, isActive, jobLabel, jobPicture, jobStage, timelineShots } from "@/features/project/helpers";
import { TemplateIcon } from "@/features/project/TemplateIcon";
import { clock, clockFromDate, pct, plural, relativeTime, shortDuration } from "@/lib/format";
import { useNow } from "@/lib/useNow";
import { Media } from "@/media/Media";
import { useEngine, useEngineState, useJobs } from "@/store/engine";
import { useInstalledTier, useThisMachine } from "@/store/tier";
import { Button, cx, toast } from "@/ui/primitives";
import { Moon } from "@/ui/Moon";
import { NightArc } from "./NightArc";
import { estimateSeconds, planQueue, resultPath, type QueuePlan, type Slot } from "./plan";
import "./queue.css";

/** Finished jobs shown at first, and how many more each "Show more" adds. */
const PAGE = 30;

export function QueuePage() {
  const jobs = useJobs();
  const { projects, settings, status } = useEngineState();
  const tier = useInstalledTier();
  const { where, remote } = useCompute();
  const here = useThisMachine();
  // The GPU's runtime is down: work for it waits, whatever runs beside it on the CPU.
  const away = status?.phase === "ready" && !status.comfyui.running;
  const active = jobs.some(isActive);
  // The clock moves while anything waits or runs: the times on the rail count down with it.
  const now = useNow(1000, active);
  // Until the engine is ready, no start time can be said either.
  const plan = planQueue(jobs, { now, tier, night: settings?.overnight, away: away || status?.phase !== "ready" });
  // Work of a deleted project is gone with it.
  const finished = plan.finished.filter((j) => projects[j.projectId]);
  const host = remote ? where : here.lower;

  return (
    <div className="page page--queue">
      <div className="page__head">
        <div>
          <h1 className="page__title">Queue</h1>
        </div>
      </div>

      <div className="qp">
        <div className="qp__main">
          <NowSection plan={plan} now={now} away={away} host={host} remote={remote} />
          <NextSection plan={plan} now={now} away={away} />
          <TonightSection plan={plan} now={now} />
        </div>
        <FinishedSection jobs={finished} now={now} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- now

function NowSection({ plan, now, away, host, remote }: { plan: QueuePlan; now: number; away: boolean; host: string; remote: boolean }) {
  return (
    <section className="q-sec" aria-labelledby="q-now">
      <h2 id="q-now" className="q-sec__title">
        Rendering now
      </h2>
      {plan.gpu ? <Live job={plan.gpu} left={plan.gpuLeft} now={now} away={away} host={remote ? host : null} /> : <Free plan={plan} away={away} host={remote ? host : null} />}
      {plan.cpu.length > 0 && (
        <div className="q-beside">
          <h3 className="q-beside__title">Beside it, on the CPU</h3>
          <ol className="q-line q-line--plain">
            {plan.cpu.map((j) => (
              <Row
                key={j.id}
                job={j}
                when={j.status === "running" ? <span className="t-num">{pct(j.progress)}</span> : null}
                node={j.status === "running" ? <Moon phase={Math.max(0.04, j.progress)} size={14} label={`${pct(j.progress)} done`} /> : <Moon phase={0} sliver={false} size={14} />}
                status={j.status === "running" ? jobStage(j) : (j.message ?? "Next up")}
                actions={<RemoveButton job={j} />}
              />
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

/** The job on the GPU, as the page's big picture: its moon, its stage and how far along it is, and the time it has left. */
function Live({ job, left, now, away, host }: { job: Job; left: number | null; now: number; away: boolean; host: string | null }) {
  const { projects } = useEngineState();
  const { cancelJob } = useEngine();
  const tier = useInstalledTier();
  const p = projects[job.projectId];
  const night = job.mode === "overnight";
  const elapsed = job.startedAt ? (now - new Date(job.startedAt).getTime()) / 1000 : 0;
  const model = modelOf(job, tier);
  const time = away ? null : left === null ? (elapsed >= 1 ? `${shortDuration(elapsed)} so far` : null) : left < 10 ? "Almost done" : `About ${shortDuration(left)} left`;
  return (
    <div className={cx("q-live", night && "q-live--night", away && "q-live--away")}>
      <Picture job={job} project={p} className="q-live__pic">
        {!away && (
          <span className="q-live__progress" aria-hidden>
            <span style={{ width: `${job.progress * 100}%` }} />
          </span>
        )}
      </Picture>
      <div className="q-live__body">
        <div className="q-live__top">
          <div className="q-live__titles">
            <div className="q-live__name">{label(job, p)}</div>
            <ProjectLink job={job} project={p} className="q-live__project" />
          </div>
          <Button size="s" variant="quiet" onClick={() => void cancelJob(job.id).catch(failed("Couldn't cancel it"))}>
            Cancel
          </Button>
        </div>
        <div className="q-live__status">
          <div className="q-live__stage">
            {away ? <span className="pulse pulse--idle" /> : <Moon phase={Math.max(0.04, job.progress)} night={night} size={18} label={`${pct(job.progress)} done`} />}
            <span className="q-live__stage-text">{away ? (host ? `Waiting for ${host}` : "Waiting for the GPU") : jobStage(job)}</span>
            {!away && <span className="q-live__pct">{pct(job.progress)}</span>}
          </div>
          <div className="q-live__meta">{[time, model].filter(Boolean).join(", ")}</div>
        </div>
      </div>
    </div>
  );
}

/**
 * Nothing on the GPU: one line with a dot for its state, and why: free, away, or the engine not ready yet. Tonight's
 * finals can start now.
 */
function Free({ plan, away, host }: { plan: QueuePlan; away: boolean; host: string | null }) {
  const { status, settings } = useEngineState();
  const { setJobMode } = useEngine();
  const [busy, setBusy] = useState(false);
  const night = settings?.overnight;
  const tonight = plan.tonight.flatMap((g) => g.slots.map((s) => s.job));
  const ready = status?.phase === "ready";

  let title = "Nothing is rendering";
  let text: ReactNode = "The GPU is free. New work starts right away.";
  let action: ReactNode = null;
  if (!ready) {
    title = status?.phase === "installing" ? "Setting up" : status?.phase === "error" ? "The engine needs attention" : "The engine is starting";
    text = "Queued work starts when it is ready";
  } else if (away) {
    title = host ? `Waiting for ${host}` : "Waiting for the GPU";
    text = host ? "It is busy with other work or can't be reached. Queued work starts on its own when it is free." : "It is starting or busy. Queued work starts on its own when it is back.";
  } else if (tonight.length && night && !plan.nightOpen) {
    const one = tonight.length === 1;
    text = night.enabled ? `Tonight's ${plural(tonight.length, "final")} ${one ? "starts" : "start"} at ${clock(night.startAt)}` : `Tonight's ${plural(tonight.length, "final")} ${one ? "waits" : "wait"}. The night shift is off in Settings.`;
    const startAll = async () => {
      setBusy(true);
      try {
        for (const j of tonight) await setJobMode(j.id, "now");
      } catch (e) {
        failed("Couldn't start them")(e);
      } finally {
        setBusy(false);
      }
    };
    action = (
      <Button size="s" busy={busy} onClick={() => void startAll()}>
        Start {tonight.length === 1 ? "it" : "them"} now
      </Button>
    );
  }
  return (
    <div className="q-free">
      <span className={cx("pulse", away || !ready ? "pulse--idle" : "pulse--ok")} aria-hidden />
      <div className="q-free__body">
        <div className="q-free__title">{title}</div>
        <p className="q-free__text">{text}</p>
      </div>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------- the line for now

function NextSection({ plan, now, away }: { plan: QueuePlan; now: number; away: boolean }) {
  const { setJobMode } = useEngine();
  const tier = useInstalledTier();
  return (
    <section className="q-sec" aria-labelledby="q-next">
      <header className="q-sec__head">
        <h2 id="q-next" className="q-sec__title">
          Up next
        </h2>
        {plan.next.length > 0 && (
          <span className="q-sec__meta">
            {plural(plan.next.length, "job")}, about {shortDuration(plan.nextSeconds)}
          </span>
        )}
      </header>
      {plan.next.length === 0 && <p className="q-empty">Nothing waiting. Stills, drafts, music and voice line up here in the order they run.</p>}
      {plan.next.length > 0 && (
        <ol className="q-line">
          {plan.next.map((s, i) => (
            <Row
              key={s.job.id}
              job={s.job}
              when={whenSoon(s, i, now)}
              node={<Moon phase={0} sliver={false} size={14} />}
              status={waitText(s.job, away) ?? modelOf(s.job, tier)}
              actions={
                <>
                  {isFinal(s.job) && (
                    <Button size="s" variant="quiet" icon={<MoonIcon />} title="Finish it in tonight's window instead" onClick={() => void setJobMode(s.job.id, "overnight").catch(failed("Couldn't move it"))}>
                      Tonight
                    </Button>
                  )}
                  <RemoveButton job={s.job} />
                </>
              }
            />
          ))}
        </ol>
      )}
    </section>
  );
}

/** When a job in the line for now should start: next, in so many minutes, or at a time when it is an hour or more off. */
function whenSoon(s: Slot, i: number, now: number): ReactNode {
  if (s.at === null) return null;
  const min = Math.round((s.at - now) / 60_000);
  if (i === 0 && min < 1) return "Next";
  if (min < 60) return <span className="t-num">in {Math.max(1, min)} min</span>;
  return <span className="t-num">{clockFromDate(new Date(s.at))}</span>;
}

/** What a queued job says under its name: what it waits for when that is news, else the model it loads. */
function waitText(j: Job, away: boolean): string | null {
  const stage = jobStage(j);
  if (away || stage === "Queued" || stage === "Waiting for the GPU" || stage === "Queued for tonight" || /^Runs (tonight|when)/.test(stage)) return null;
  return stage;
}

// ---------------------------------------------------------------- tonight

function TonightSection({ plan, now }: { plan: QueuePlan; now: number }) {
  const { settings, projects } = useEngineState();
  const { setJobMode } = useEngine();
  const tier = useInstalledTier();
  const night = settings?.overnight;
  const finals = plan.tonight.flatMap((g) => g.slots);
  const count = finals.length;
  const late = finals.filter((s) => s.later).length;
  const paused = !!night && !night.enabled;
  const running = plan.gpu?.mode === "overnight" ? plan.gpu : undefined;
  return (
    <section className="q-sec q-tonight" aria-labelledby="q-tonight">
      <header className="q-sec__head">
        <h2 id="q-tonight" className="q-sec__title">
          Tonight
        </h2>
        {night && <span className="q-sec__meta t-num">{paused ? "Paused" : `${clock(night.startAt)} to ${clock(night.endAt)}`}</span>}
        <Link to="/settings" className="q-sec__link">
          {paused ? "Turn it on" : "Change the hours"}
        </Link>
      </header>
      {night && (
        <NightArc
          className="q-arc"
          startAt={night.startAt}
          endAt={night.endAt}
          enabled={night.enabled}
          now={now}
          finals={[
            ...(running ? [{ id: running.id, label: label(running, projects[running.projectId]), seconds: plan.gpuLeft ?? 0, at: now }] : []),
            ...finals.map((s) => ({ id: s.job.id, label: label(s.job, projects[s.job.projectId]), seconds: estimateSeconds(s.job, tier), ...(s.at !== null ? { at: s.at } : {}) })),
          ]}
        />
      )}
      {count === 0 && !running && <p className="q-empty">No finals for tonight. On a take you like, choose Finish tonight and it renders here while you sleep.</p>}
      {late > 0 && <p className="q-note">{late === count ? "These finals don't fit in tonight's window. They run tomorrow night." : `${plural(late, "final")} don't fit in tonight's window. They run tomorrow night.`}</p>}
      <ol className="q-line q-line--night">
        {plan.tonight.map((g, gi) => (
          <Fragment key={g.slots[0]!.job.id}>
            <li className="q-group" aria-label={`${g.name}, ${plural(g.slots.length, "final")}`}>
              <span className="q-group__name">{g.name}</span>
              <span className="q-group__note">
                {g.slots.length > 1 ? `${plural(g.slots.length, "final")} back to back, so the model loads once` : "1 final"}
                {gi === 0 && running?.nightGroup === g.slots[0]!.job.nightGroup ? ", after the one rendering" : ""}
              </span>
            </li>
            {g.slots.map((s) => (
              <Row
                key={s.job.id}
                job={s.job}
                when={s.at !== null ? <span className="t-num">{clockFromDate(new Date(s.at))}</span> : null}
                node={<MoonIcon className="q-row__crescent" aria-hidden />}
                status={s.later ? "Tomorrow night" : paused ? "Waits until the night shift is on" : waitText(s.job, false)}
                actions={
                  <>
                    <Button size="s" variant="quiet" title="Run it as soon as the GPU is free" onClick={() => void setJobMode(s.job.id, "now").catch(failed("Couldn't move it"))}>
                      Run now
                    </Button>
                    <RemoveButton job={s.job} />
                  </>
                }
              />
            ))}
          </Fragment>
        ))}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------- finished

function FinishedSection({ jobs, now }: { jobs: Job[]; now: number }) {
  const [shown, setShown] = useState(PAGE);
  const days: Array<{ label: string; jobs: Job[] }> = [];
  for (const j of jobs.slice(0, shown)) {
    const day = dayLabel(j.finishedAt ?? j.createdAt, now);
    if (days.at(-1)?.label === day) days.at(-1)!.jobs.push(j);
    else days.push({ label: day, jobs: [j] });
  }
  return (
    <section className="q-done" aria-labelledby="q-done">
      <h2 id="q-done" className="q-sec__title">
        Finished
      </h2>
      {jobs.length === 0 && <p className="q-empty">Nothing finished yet. Each result shows here with a link to it.</p>}
      {days.map((d) => (
        <div key={d.label} className="q-done__day">
          <h3 className="q-done__date">{d.label}</h3>
          <ul className="q-done__list">
            {d.jobs.map((j) => (
              <DoneRow key={j.id} job={j} now={now} />
            ))}
          </ul>
        </div>
      ))}
      {jobs.length > shown && (
        <Button size="s" variant="quiet" className="q-done__more" onClick={() => setShown((n) => n + PAGE)}>
          Show more
        </Button>
      )}
    </section>
  );
}

/** A finished job: its picture and name lead to the result. A failed one says why and offers to try again. */
function DoneRow({ job, now }: { job: Job; now: number }) {
  const { projects } = useEngineState();
  const { still, draft, final } = useEngine();
  const [busy, setBusy] = useState(false);
  const p = projects[job.projectId]!;
  const shot = job.shotId ? p.shots.find((s) => s.id === job.shotId) : undefined;
  const bad = job.status === "failed";
  const again = bad && shot ? retryFor(p, shot, job.step) : undefined;
  const retry = async () => {
    if (!shot || !again) return;
    setBusy(true);
    try {
      if (again.kind === "still") await still(p.id, shot.id);
      else if (again.kind === "draft") await draft(p.id, shot.id);
      else if (again.kind === "final" && shot.chosenDraftId) await final(p.id, shot.id, { draftId: shot.chosenDraftId, kind: again.finalKind, mode: job.mode });
    } catch (e) {
      failed("Couldn't start it")(e);
    } finally {
      setBusy(false);
    }
  };
  const to = again?.kind === "story" ? `/p/${p.id}/storyboard` : resultPath(job, p);
  return (
    <li className={cx("q-done__row", bad && "q-done__row--bad", job.status === "cancelled" && "q-done__row--off")}>
      <Picture job={job} project={p} className="q-done__pic" />
      <div className="q-done__main">
        <Link to={to} className="q-done__name">
          {label(job, p)}
        </Link>
        <div className="q-done__sub">
          <span className="q-done__project">{p.name}</span>
          <span className="q-done__when">{job.finishedAt ? (dayLabel(job.finishedAt, now) === "Today" ? relativeTime(job.finishedAt, now) : clockFromDate(new Date(job.finishedAt))) : ""}</span>
        </div>
        {bad && (
          <p className="q-done__reason" title={job.error}>
            {failureReason(job)}
          </p>
        )}
        {job.status === "cancelled" && <p className="q-done__note">Cancelled</p>}
      </div>
      {bad && again && again.kind !== "story" && (
        <Button size="s" className="q-done__again" icon={<RotateCcw />} busy={busy} onClick={() => void retry()}>
          Try again
        </Button>
      )}
    </li>
  );
}

/** "Today", "Yesterday", the weekday within a week, else the date. */
function dayLabel(iso: string, now: number): string {
  const d = new Date(iso);
  const midnight = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const days = Math.round((midnight(new Date(now)) - midnight(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "long", day: "numeric" });
}

// ---------------------------------------------------------------- parts

/** A job on the rail: when it should start, its node, its picture, what it is and for which project, and its actions. */
function Row({ job, when, node, status, actions }: { job: Job; when: ReactNode; node: ReactNode; status?: string | null; actions?: ReactNode }) {
  const { projects } = useEngineState();
  const p = projects[job.projectId];
  return (
    <li className="q-row">
      <span className="q-row__when">{when}</span>
      <span className="q-row__node">{node}</span>
      <Picture job={job} project={p} className="q-row__pic" />
      <div className="q-row__main">
        <div className="q-row__name">{label(job, p)}</div>
        <div className="q-row__sub">
          <ProjectLink job={job} project={p} />
          {status && <span className="q-row__status">{status}</span>}
        </div>
      </div>
      <div className="q-row__actions">{actions}</div>
    </li>
  );
}

function RemoveButton({ job }: { job: Job }) {
  const { cancelJob } = useEngine();
  const what = job.status === "running" ? "Cancel" : "Remove";
  return <Button size="s" variant="quiet" iconOnly icon={<X />} aria-label={`${what} ${jobLabel(job).toLowerCase()}`} title={what} onClick={() => void cancelJob(job.id).catch(failed(`Couldn't ${what.toLowerCase()} it`))} />;
}

function ProjectLink({ job, project, className }: { job: Job; project: Project | undefined; className?: string }) {
  return (
    <Link to={`/p/${job.projectId}`} className={cx("q-project", className)}>
      {project?.name ?? "Project"}
    </Link>
  );
}

/** The picture of what a job makes, on the dark frame; a song, a voice or a shot list shows its kind. */
function Picture({ job, project, className, children }: { job: Job; project: Project | undefined; className?: string; children?: ReactNode }) {
  const { client } = useEngine();
  const asset = project ? jobPicture(project, job) : undefined;
  const Icon = job.step === "export" ? Film : job.step === "music" ? Music2 : job.step === "voice" ? Mic : job.step === "text" ? FileText : null;
  return (
    <span className={cx("q-pic", className)}>
      {asset ? (
        <Media src={client.assetUrl(job.projectId, asset.id)} kind={asset.kind === "video" ? "video" : "image"} fit={fitFor(asset, 16 / 9)} />
      ) : Icon ? (
        <Icon className="q-pic__icon" aria-hidden />
      ) : project ? (
        <TemplateIcon template={project.template} />
      ) : null}
      {children}
    </span>
  );
}

/** "Draft, shot 3": what the job does, and its shot's place in the cut. A shot kept in Media only has no number. */
function label(j: Job, p: Project | undefined): string {
  const idx = p && j.shotId ? timelineShots(p).findIndex((s) => s.id === j.shotId) : -1;
  return [jobLabel(j, p), idx >= 0 ? `shot ${idx + 1}` : null].filter(Boolean).join(", ");
}

/** The model a job loads, in plain words, when the engine or the setup says. */
function modelOf(j: Job, tier: TierSummary | null): string | null {
  if (j.analysis || j.step === "export") return null;
  return j.model ?? tier?.models?.[j.step] ?? null;
}

const isFinal = (j: Job) => j.step === "video_final_same_take" || j.step === "video_final_remaster";

const failed = (title: string) => (e: unknown) => toast({ title, text: e instanceof Error ? e.message : String(e), tone: "bad" });
