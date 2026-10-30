import type { Job } from "@nightshift/contract";
import { ArrowUpRight, Settings as SettingsIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Link, useLocation } from "react-router";
import { useEngineState, useJobs } from "@/store/engine";
import { isGpuJob, jobLabel, jobStage, jobStatusLine } from "@/features/project/helpers";
import { clock, plural } from "@/lib/format";
import { useNow } from "@/lib/useNow";
import { useThisMachine } from "@/store/tier";
import { cx } from "@/ui/primitives";

/** Where work runs and what it is doing: the one reading the toolbar pill, the sidebar foot and the popover share. */
export interface ComputeSummary {
  /** The GPU computer's name, or this machine's. */
  where: string;
  remote: boolean;
  /** Generation can't start: the GPU is away, busy or starting. */
  away: boolean;
  running?: Job;
  queued: Job[];
}

export function useCompute(): ComputeSummary {
  const { status, settings } = useEngineState();
  const jobs = useJobs();
  const here = useThisMachine();
  const remoteSettings = status?.mode === "remote" ? settings?.remote : null;
  const where = remoteSettings ? (remoteSettings.name ?? remoteSettings.url.replace(/^https?:\/\//, "")) : status?.mode === "attach" ? "GPU proxy" : here.name;
  const running = jobs.find((j) => j.status === "running");
  const queued = jobs.filter((j) => j.status === "queued");
  const away = !!status && status.phase === "ready" && !status.comfyui.running && (!running || isGpuJob(running));
  return { where, remote: !!remoteSettings, away, running, queued };
}

/** Opens and closes the popover from a trigger. Closes on a click outside, Escape, or a move to another page. */
export function usePopover<T extends HTMLElement>(): { open: boolean; toggle: () => void; close: () => void; anchor: RefObject<T | null> } {
  const [open, setOpen] = useState(false);
  const anchor = useRef<T>(null);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  return { open, toggle: () => setOpen((v) => !v), close: () => setOpen(false), anchor };
}

type Placement = "below-end" | "above-start";

/**
 * What the GPU is doing, in place: the running job, what waits and why, and a way to the full queue. Opens from the
 * toolbar pill (below it) and the sidebar foot (above it), so it never takes you away from your project.
 */
export function ComputePopover({ open, onClose, anchor, placement }: { open: boolean; onClose: () => void; anchor: RefObject<HTMLElement | null>; placement: Placement }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<React.CSSProperties | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      setPos(placement === "below-end" ? { top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) } : { bottom: window.innerHeight - r.top + 6, left: Math.max(8, r.left) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, anchor, placement]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
      anchor.current?.focus();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose, anchor]);

  if (!open || !pos) return null;
  return createPortal(
    <div ref={ref} className={cx("gpu-pop", `gpu-pop--${placement}`)} role="dialog" aria-label="What the GPU is doing" style={pos}>
      <ComputeDetail />
    </div>,
    document.body,
  );
}

const SHOWN = 4;

function ComputeDetail() {
  const { status, settings, projects } = useEngineState();
  const { where, remote, away, running, queued } = useCompute();
  const now = useNow(1000, !!running);
  const night = queued.filter((j) => j.mode === "overnight");
  const soon = queued.filter((j) => j.mode !== "overnight");
  const ready = status?.phase === "ready";

  let state: { text: string; tone?: "busy" | "away" | "night" } = { text: "Ready" };
  if (!ready) state = { text: status?.phase === "error" ? "Needs attention" : status?.phase === "installing" ? "Installing" : "Starting", tone: "away" };
  else if (away) state = { text: remote ? "Busy" : "Not ready", tone: "away" };
  else if (running) state = { text: "Working", tone: running.mode === "overnight" ? "night" : "busy" };

  const name = (j: Job) => projects[j.projectId]?.name;
  return (
    <>
      <div className="gpu-pop__head">
        <span className={cx("pulse", state.tone === "away" ? "pulse--idle" : state.tone === "night" ? "pulse--night" : state.tone === "busy" ? "" : "pulse--ok")} />
        <span className="gpu-pop__where" title={remote && settings?.remote ? settings.remote.url : undefined}>
          {where}
        </span>
        <span className={cx("gpu-pop__state", state.tone && `gpu-pop__state--${state.tone}`)}>{state.text}</span>
      </div>
      {away && (
        <p className="gpu-pop__why">
          {remote ? "The GPU computer is busy with other work, or it can't be reached. Your jobs start on their own when it is free." : "The GPU is starting or busy. Your jobs start on their own when it is ready."}
        </p>
      )}

      {running && (
        <Section title="Running">
          <div className="gpu-pop__job gpu-pop__job--live">
            <span className="gpu-pop__job-main">
              <span className="gpu-pop__job-name">{jobLabel(running, projects[running.projectId])}</span>
              <span className="gpu-pop__job-sub">{[name(running), jobStatusLine(running, now)].filter(Boolean).join(", ")}</span>
            </span>
            <span className="gpu-pop__pct">{Math.round(running.progress * 100)}%</span>
          </div>
          <span className={cx("bar", running.mode === "overnight" && "bar--night", "gpu-pop__bar")}>
            <span className="bar__fill" style={{ width: `${running.progress * 100}%` }} />
          </span>
        </Section>
      )}

      {soon.length > 0 && (
        <Section title={away ? `Waiting, ${soon.length}` : `Up next, ${soon.length}`}>
          {soon.slice(0, SHOWN).map((j) => (
            <JobRow key={j.id} job={j} project={name(j)} stage={jobStage(j)} />
          ))}
          {soon.length > SHOWN && <div className="gpu-pop__more">and {plural(soon.length - SHOWN, "more")}</div>}
        </Section>
      )}

      {night.length > 0 && (
        <Section title={settings?.overnight.enabled ? `Tonight at ${clock(settings.overnight.startAt)}, ${night.length}` : `For tonight, ${night.length}`} night>
          {night.slice(0, SHOWN).map((j) => (
            <JobRow key={j.id} job={j} project={name(j)} />
          ))}
          {night.length > SHOWN && <div className="gpu-pop__more">and {plural(night.length - SHOWN, "more")}</div>}
        </Section>
      )}

      {!running && queued.length === 0 && <p className="gpu-pop__empty">{away ? "Nothing is waiting." : "Nothing is running. New work starts right away."}</p>}

      <div className="gpu-pop__foot">
        <Link to="/queue" className="btn btn--s gpu-pop__queue">
          Open the queue
          <ArrowUpRight />
        </Link>
        <Link to="/settings" className="btn btn--s btn--quiet gpu-pop__settings" title="Where renders run">
          <SettingsIcon />
          Settings
        </Link>
      </div>
    </>
  );
}

function Section({ title, night, children }: { title: string; night?: boolean; children: ReactNode }) {
  return (
    <section className={cx("gpu-pop__section", night && "gpu-pop__section--night")}>
      <h3 className="gpu-pop__title">{title}</h3>
      {children}
    </section>
  );
}

function JobRow({ job, project, stage }: { job: Job; project?: string; stage?: string }) {
  const { projects } = useEngineState();
  const sub = [project, stage && stage !== "Queued" && stage !== "Waiting for the GPU" ? stage : null].filter(Boolean).join(", ");
  return (
    <div className="gpu-pop__job">
      <span className="gpu-pop__job-main">
        <span className="gpu-pop__job-name">{jobLabel(job, projects[job.projectId])}</span>
        {sub && <span className="gpu-pop__job-sub">{sub}</span>}
      </span>
    </div>
  );
}
