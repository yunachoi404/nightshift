import type { Project } from "@nightshift/contract";
import { Film, Gpu, ListTodo, PanelLeftClose, PanelLeftOpen, Plus, Settings as SettingsIcon, X } from "lucide-react";
import { useState } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { useEngine, useEngineState, useJobs, useProjectList } from "@/store/engine";
import { Media } from "@/media/Media";
import { coverFor, isActive, isGpuJob, jobLabel, jobStage } from "@/features/project/helpers";
import { Button, cx } from "@/ui/primitives";
import { TemplateIcon } from "@/features/project/TemplateIcon";
import { clock, gb } from "@/lib/format";
import { useThisMachine } from "@/store/tier";
import { sidebarShortcut } from "./useSidebar";
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
        <SidebarToggle collapsed={false} onToggle={onToggle} />
      </div>
      <nav className="sidebar__list">
        <div className="side__head">Projects</div>
        {projects.length === 0 && <div className="side__empty">Nothing yet. Start a project.</div>}
        {projects.map((p) => (
          <ProjectItem key={p.id} project={p} current={loc.pathname.startsWith(`/p/${p.id}`)} />
        ))}
        <Link to="/new" className="side__item side__item--new" aria-current={loc.pathname === "/new" ? "page" : undefined}>
          <Plus />
          <span className="side__label">New project</span>
        </Link>

        <div className="side__head">Studio</div>
        <NavLink to="/" end className="side__item">
          <Film />
          <span className="side__label">All projects</span>
        </NavLink>
        <NavLink to="/queue" className="side__item">
          <ListTodo />
          <span className="side__label">Queue</span>
          {active.length > 0 && <span className={cx("side__badge", overnight ? "side__badge--night" : running ? "side__badge--live" : undefined)}>{active.length}</span>}
        </NavLink>
        <NavLink to="/settings" className="side__item">
          <SettingsIcon />
          <span className="side__label">Settings</span>
        </NavLink>
      </nav>
      <div className="sidebar__foot">
        <OtherGpuUse />
        <ComputeStatus />
      </div>
    </aside>
  );
}

function ProjectItem({ project, current }: { project: Project; current: boolean }) {
  const { client } = useEngine();
  const cover = coverFor(project);
  return (
    <Link to={`/p/${project.id}`} className="side__item side__item--project" aria-current={current ? "page" : undefined} title={project.name}>
      <span className="side__thumb">{cover ? <Media src={client.assetUrl(project.id, cover.id)} kind={cover.kind === "video" ? "video" : "image"} /> : <TemplateIcon template={project.template} />}</span>
      <span className="side__label">{project.name}</span>
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

/** Where work runs and what it is doing, in one line at the foot of the sidebar. Opens the details above it. */
function ComputeStatus() {
  const { status, settings, projects } = useEngineState();
  const { where, remote, away, running, queued } = useCompute();
  const here = useThisMachine();
  const pop = usePopover<HTMLButtonElement>();

  let dot = "pulse--ok";
  let text = where;
  let tone: "night" | undefined;
  let bar: { value: number; night: boolean } | null = null;
  if (!status || status.phase !== "ready") {
    text = status?.phase === "installing" ? "Installing" : status?.phase === "starting" ? "Starting" : status?.phase === "error" ? "Needs attention" : "Not set up";
    dot = status?.phase === "error" ? "pulse--bad" : "pulse--idle";
  } else if (away) {
    text = remote ? `Waiting for ${where}` : "Waiting for the GPU";
    dot = "pulse--idle";
  } else if (running) {
    const night = running.mode === "overnight";
    text = `${jobLabel(running, projects[running.projectId])}, ${jobStage(running).toLowerCase()}`;
    dot = night ? "pulse--night" : "";
    tone = night ? "night" : undefined;
    bar = { value: running.progress, night };
  } else if (queued.some((j) => j.mode === "overnight") && settings?.overnight.enabled) {
    const n = queued.filter((j) => j.mode === "overnight").length;
    text = `${n} waiting for ${clock(settings.overnight.startAt)}`;
    dot = "pulse--night";
    tone = "night";
  } else if (queued.length) {
    text = `${queued.length} queued`;
    dot = "";
  }

  return (
    <>
      <button
        ref={pop.anchor}
        type="button"
        className={cx("side__status", tone && `side__status--${tone}`)}
        aria-expanded={pop.open}
        aria-haspopup="dialog"
        title={running && !isGpuJob(running) ? `This work runs on ${here.lower}` : remote ? `Generation runs on ${where}` : "Work runs on this computer"}
        onClick={pop.toggle}
      >
        <span className={cx("pulse", dot)} />
        <span>{text}</span>
        {bar && (
          <span className={cx("bar", bar.night && "bar--night")}>
            <span className="bar__fill" style={{ width: `${bar.value * 100}%` }} />
          </span>
        )}
      </button>
      <ComputePopover open={pop.open} onClose={pop.close} anchor={pop.anchor} placement="above-start" />
    </>
  );
}
