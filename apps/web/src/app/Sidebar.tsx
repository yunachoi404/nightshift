import type { Project } from "@nightshift/contract";
import { Gpu, LayoutGrid, ListTodo, PanelLeftClose, PanelLeftOpen, Plus, Settings as SettingsIcon, X } from "lucide-react";
import { Moon } from "@/ui/Moon";
import { CRESCENT } from "@/ui/mark-svg";
import { BrandTile } from "@/ui/Mark";
import { useState } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { useEngine, useEngineState, useJobs, useProjectList } from "@/store/engine";
import { Media } from "@/media/Media";
import { coverFor, isActive, isGpuJob, jobLabel, jobStage } from "@/features/project/helpers";
import { tonightTally } from "@/features/queue/tonight";
import { tonightSeconds } from "@/features/queue/plan";
import { Button, cx } from "@/ui/primitives";
import { TemplateIcon } from "@/features/project/TemplateIcon";
import { gb, plural, shortDuration } from "@/lib/format";
import { insideWindow, nightClock } from "@/lib/overnight";
import { useNow } from "@/lib/useNow";
import { useHardware, useInstalledTier, useThisMachine } from "@/store/tier";
import { modKey, sidebarShortcut } from "./useSidebar";
import { ComputePopover, useCompute, usePopover } from "./ComputePopover";

/** Opens or closes the sidebar. In the sidebar's title strip when it is open, first in the toolbar when it is not. */
export function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = collapsed ? "Show sidebar" : "Hide sidebar";
  return (
    <Button
      variant="toolbar"
      iconOnly
      icon={collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
      aria-label={label}
      aria-controls="app-sidebar"
      title={`${label} (${sidebarShortcut()})`}
      className="side-toggle"
      data-sidebar-toggle=""
      onClick={onToggle}
    />
  );
}

export function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const projects = useProjectList();
  const jobs = useJobs();
  const loc = useLocation();
  const active = jobs.filter(isActive);
  const overnight = active.filter((j) => j.mode === "overnight").length;
  const running = jobs.some((j) => j.status === "running");

  return (
    <aside id="app-sidebar" className="sidebar" aria-label="Sidebar" inert={collapsed} aria-hidden={collapsed || undefined}>
      <div className="sidebar__top drag">
        <Link to="/" className="sidebar__brand" aria-label="Nightshift, all projects">
          <BrandTile />
          <span className="sidebar__name">Nightshift</span>
        </Link>
        <SidebarToggle collapsed={false} onToggle={onToggle} />
      </div>
      <div className="sidebar__body">
        <nav className="sidebar__nav" aria-label="Studio">
          <Link to="/new" className="side__new" aria-current={loc.pathname === "/new" ? "page" : undefined} title={`New project (${modKey()}N)`}>
            <span className="side__new-icon" aria-hidden>
              <Plus />
            </span>
            <span className="side__label">New project</span>
            <kbd className="kbd kbd--bare side__keys" aria-hidden>
              {modKey()}N
            </kbd>
          </Link>
          <div className="side__places">
            <NavLink to="/" end className="side__item">
              <LayoutGrid />
              <span className="side__label">Projects</span>
            </NavLink>
            <NavLink to="/queue" className="side__item">
              <ListTodo />
              <span className="side__label">Queue</span>
              {active.length > 0 && <span className={cx("side__count", overnight ? "side__count--night" : running ? "side__count--live" : undefined)}>{active.length}</span>}
            </NavLink>
          </div>
        </nav>
        <nav className="sidebar__list" aria-label="Recent projects">
          {projects.length > 0 && <div className="side__head">Recent</div>}
          {projects.map((p) => (
            <ProjectItem key={p.id} project={p} current={loc.pathname.startsWith(`/p/${p.id}`)} />
          ))}
        </nav>
      </div>
      <div className="sidebar__foot">
        <OtherGpuUse />
        <Tonight />
        <div className="side__footrow">
          <ComputeStatus />
          <NavLink to="/settings" className="side__gear" aria-label="Settings" title={`Settings (${modKey()},)`}>
            <SettingsIcon />
          </NavLink>
        </div>
      </div>
    </aside>
  );
}

function ProjectItem({ project, current }: { project: Project; current: boolean }) {
  const { client } = useEngine();
  const cover = coverFor(project);
  return (
    <Link to={`/p/${project.id}`} className="side__item side__item--project" aria-current={current ? "page" : undefined} title={project.name}>
      <span className="side__thumb">{cover ? <Media src={client.assetUrl(project.id, cover.id)} kind={cover.kind === "video" ? "video" : "image"} thumb={160} /> : <TemplateIcon template={project.template} />}</span>
      <span className="side__label">{project.name}</span>
    </Link>
  );
}

/** At most this many marks in tonight's bar; more finals than that read as one bar. */
const MARKS = 12;

/**
 * Finals waiting for tonight: a card above the foot with the crescent, when the night starts, how many wait, and a bar of
 * those done against all of tonight's. It leads to the queue, where the night is laid out on its arc.
 */
function Tonight() {
  const jobs = useJobs();
  const { settings } = useEngineState();
  const tier = useInstalledTier();
  const night = settings?.overnight;
  const waiting = jobs.some((j) => j.mode === "overnight" && (j.status === "queued" || j.status === "running"));
  const now = useNow(60_000, waiting);
  if (!waiting) return null;
  const tally = tonightTally(jobs, night, now);
  const left = tally.queued + (tally.running ? 1 : 0);
  const total = tally.done + left;
  const on = !!night?.enabled;
  const open = on && insideWindow(night, now);
  const c = nightClock(night, now);
  const when = !night ? "" : !on ? "Paused" : open ? `until ${c.time(night.endAt)}` : c.time(night.startAt);
  // The same words and numbers as the Queue's Tonight.
  const work = shortDuration(tonightSeconds(jobs, tier, now));
  const text = !on ? `${plural(left, "final")} queued. The night shift is off in Settings.` : open && total > left ? `${tally.done} of ${plural(total, "final")} done, about ${work} left` : `${plural(left, "final")}, about ${work} of work`;
  const marks = Array.from({ length: total }, (_, i) => (i < tally.done ? 1 : i === tally.done && tally.running ? tally.running.progress : 0));
  return (
    <Link to="/queue" className="side__tonight" aria-label={`Tonight${when ? `, ${when}` : ""}. ${plural(left, "final")} queued. Open the queue`}>
      <span className="side__tonight-head">
        <svg className="side__crescent" viewBox="14 14 72 72" aria-hidden focusable="false">
          <path d={CRESCENT} />
        </svg>
        <span className="side__tonight-title">Tonight</span>
        {when && <span className="side__tonight-when t-mono">{when}</span>}
      </span>
      <span className="side__tonight-text">{text}</span>
      <span className="side__tonight-bar" aria-hidden>
        {total > MARKS ? (
          <span className="side__tonight-mark">
            <span style={{ width: `${((tally.done + (tally.running?.progress ?? 0)) / total) * 100}%` }} />
          </span>
        ) : (
          marks.map((fill, i) => (
            <span key={i} className="side__tonight-mark">
              <span style={{ width: `${fill * 100}%` }} />
            </span>
          ))
        )}
      </span>
    </Link>
  );
}

/**
 * Other programs hold part of the graphics card while a render runs (the engine looks while GPU jobs run). Dismissed,
 * it stays away for the same programs; it shows again when others take their place.
 */
function OtherGpuUse() {
  const use = useEngineState().status?.otherGpuUse;
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!use) return null;
  const key = [...use.apps].sort().join("\n");
  if (key === dismissed) return null;
  const one = use.apps.length < 2;
  return (
    <div className="side__notice">
      <Gpu />
      <div className="side__notice-body">
        {/* Floats, so the words run on under it after the first line. */}
        <Button variant="quiet" size="s" iconOnly icon={<X />} aria-label="Dismiss" title="Dismiss" className="side__notice-close" onClick={() => setDismissed(key)} />
        <p className="side__notice-text" role="status">
          <span className="side__notice-lead">
            {one ? "Another app is" : "Other apps are"} using {gb(use.usedGb, use.usedGb % 1 ? 1 : 0)} of your graphics card{use.apps.length ? ` (${use.apps.join(", ")})` : ""}.
          </span>{" "}
          Renders may be slower until {one ? "it stops" : "they stop"}.
        </p>
      </div>
    </div>
  );
}

/**
 * Where work runs and what it is doing, in one line at the foot of the sidebar: the GPU's name and a word for its state.
 * A render under way shows its moon in place of the dot. Opens the details above it.
 */
function ComputeStatus() {
  const { status, projects } = useEngineState();
  const { where, remote, away, running, queued } = useCompute();
  const here = useThisMachine();
  const hw = useHardware();
  const pop = usePopover<HTMLButtonElement>();
  const gpu = hw?.gpus[0];
  // This machine reads as its graphics card when it has one; a GPU computer on the network goes by its name.
  const name = remote || status?.mode === "attach" || !gpu || gpu.vendor === "none" || !gpu.name ? where : gpu.name;

  let dot = "pulse--ok";
  let state = "idle";
  if (!status || status.phase !== "ready") {
    state = status?.phase === "installing" ? "installing" : status?.phase === "starting" ? "starting" : status?.phase === "error" ? "needs attention" : "not set up";
    dot = status?.phase === "error" ? "pulse--bad" : "pulse--idle";
  } else if (away) {
    state = "waiting";
    dot = "pulse--idle";
  } else if (running || queued.some((j) => j.mode !== "overnight")) {
    state = "busy";
    // Work about to start: the banana dot, holding still until it runs.
    dot = "pulse--still";
  }
  const title = running
    ? `${jobLabel(running, projects[running.projectId])}, ${jobStage(running).toLowerCase()}${isGpuJob(running) ? "" : `. This work runs on ${here.lower}`}`
    : away
      ? remote
        ? `Waiting for ${where}`
        : "Waiting for the GPU"
      : remote
        ? `Generation runs on ${where}`
        : "Work runs on this computer";

  return (
    <>
      <button ref={pop.anchor} type="button" className="side__status" aria-expanded={pop.open} aria-haspopup="dialog" title={title} onClick={pop.toggle}>
        {state === "busy" && running ? (
          <Moon phase={Math.max(0.04, running.progress)} night={running.mode === "overnight"} size={12} label={`${Math.round(running.progress * 100)}% done`} />
        ) : (
          <span className={cx("pulse", "side__dot", dot)} />
        )}
        <span className="side__where">{name}</span>
        <span className="side__state">· {state}</span>
      </button>
      <ComputePopover open={pop.open} onClose={pop.close} anchor={pop.anchor} placement="above-start" />
    </>
  );
}
