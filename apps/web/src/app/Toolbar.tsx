import type { Project } from "@nightshift/contract";
import { templates } from "@nightshift/contract";
import { ChevronDown, ChevronLeft, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useEngineState, useJobs } from "@/store/engine";
import { Button, Segmented, cx } from "@/ui/primitives";
import { isDevMock } from "@/api/config";
import { isGpuJob, jobLabel, projectStage, timelineShots, totalDuration } from "@/features/project/helpers";
import { plural, shortDuration } from "@/lib/format";
import { useThisMachine } from "@/store/tier";
import { SidebarToggle } from "./Sidebar";
import { modKey } from "./useSidebar";
import { ComputePopover, useCompute, usePopover } from "./ComputePopover";

/** A project's two areas. The old storyboard, takes and finals pages belong to Media. */
type Stage = "media" | "editor";

export function Toolbar({ project, backTo, onDev, sidebarCollapsed, onToggleSidebar }: { project?: Project; backTo?: Project; onDev: () => void; sidebarCollapsed: boolean; onToggleSidebar: () => void }) {
  const loc = useLocation();
  const nav = useNavigate();
  const jobs = useJobs();
  const stage: Stage = /^\/p\/[^/]+\/editor/.test(loc.pathname) ? "editor" : "media";

  let title = "Nightshift";
  // The subtitle's parts, most important last. Narrow windows drop the first ones (see .toolbar__sub in app.css).
  let sub: string[] = [];
  if (project) {
    title = project.name;
    const t = templates.find((x) => x.id === project.template);
    const s = projectStage(project, jobs);
    const cut = timelineShots(project).length;
    sub = [t?.name, cut ? `${plural(cut, "shot")}, ${shortDuration(totalDuration(project))}` : null, s.label].filter((x): x is string => !!x);
  } else if (loc.pathname === "/settings") title = "Settings";
  else if (loc.pathname === "/new") title = "New project";
  else if (loc.pathname === "/queue") title = "Queue";
  // The queue and settings lead back to the project you came from.
  const back = !project && backTo && (loc.pathname === "/queue" || loc.pathname === "/settings") ? backTo : undefined;

  return (
    <header className="toolbar drag">
      <div className="toolbar__left">
        {sidebarCollapsed && <SidebarToggle collapsed onToggle={onToggleSidebar} />}
        {back && (
          <Link to={`/p/${back.id}`} className="toolbar__back" title={`Back to ${back.name}`}>
            <ChevronLeft aria-hidden />
            <span className="toolbar__back-label">Back to {back.name}</span>
          </Link>
        )}
        <div className="toolbar__title">
          <div className="toolbar__name">{title}</div>
          {sub.length > 0 && (
            <div className="toolbar__sub">
              {sub.map((part, i) => (
                <span key={part} className={cx("toolbar__sub-part", i < sub.length - 1 && "toolbar__sub-part--extra")}>
                  {part}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="toolbar__center">
        {project && (
          <Segmented
            label="Project stage"
            value={stage}
            onChange={(v) => nav(`/p/${project.id}/${v}`)}
            options={[
              { value: "media", label: "Media", title: `Media (${modKey()}1)` },
              { value: "editor", label: "Editor", title: `Editor (${modKey()}2)` },
            ]}
          />
        )}
      </div>
      <div className="toolbar__right">
        <Activity />
        {isDevMock() && (
          <Button variant="toolbar" size="s" onClick={onDev} title="Mock engine controls (press M)">
            Mock
          </Button>
        )}
        {!project && loc.pathname !== "/new" && (
          <Link to="/new" className="btn btn--toolbar btn--icon" aria-label="New project" title="New project">
            <Plus />
          </Link>
        )}
      </div>
    </header>
  );
}

/** The running job as a small ring and a few words. Opens what the GPU is doing in place, over the page. */
function Activity() {
  const { status, projects } = useEngineState();
  const { where, remote, away, running, queued } = useCompute();
  const here = useThisMachine();
  const pop = usePopover<HTMLButtonElement>();

  if (!status || status.phase !== "ready") return null;
  let body: ReactNode = null;
  let night = false;
  if (away) {
    body = (
      <>
        <span className="pulse pulse--idle" />
        <span>{remote ? `Waiting for ${where}` : "Waiting for the GPU"}</span>
      </>
    );
  } else if (running) {
    night = running.mode === "overnight";
    body = (
      <>
        <span className={cx("ring", night && "ring--night")} style={{ "--pct": Math.round(running.progress * 100) } as React.CSSProperties} />
        <ActivityLabel label={jobLabel(running, projects[running.projectId])} where={remote ? (isGpuJob(running) ? where : here.lower) : undefined} />
      </>
    );
  } else if (queued.length) {
    night = queued.some((j) => j.mode === "overnight");
    body = (
      <>
        <span className={cx("pulse", night ? "pulse--night" : "pulse--idle")} />
        <span>{night ? `${queued.length} for tonight` : `${queued.length} queued`}</span>
      </>
    );
  } else if (remote) {
    body = (
      <>
        <span className="pulse pulse--ok" />
        <span>{where}</span>
      </>
    );
  }
  if (!body) return null;
  return (
    <>
      <button
        ref={pop.anchor}
        type="button"
        className={cx("activity", night && "activity--night", away && "activity--away")}
        aria-expanded={pop.open}
        aria-haspopup="dialog"
        title={away ? status.error : undefined}
        onClick={pop.toggle}
      >
        {body}
        <ChevronDown className="activity__chev" aria-hidden />
      </button>
      <ComputePopover open={pop.open} onClose={pop.close} anchor={pop.anchor} placement="below-end" />
    </>
  );
}

/** The job in a few words. Narrow windows drop the device, then the detail after the comma (see .activity in app.css). */
function ActivityLabel({ label, where }: { label: string; where?: string }) {
  const short = label.split(",")[0]!.trim();
  return (
    <span className="activity__text">
      <span className="activity__long">{label}</span>
      <span className="activity__short">{short}</span>
      {where && <span className="activity__where"> on {where}</span>}
    </span>
  );
}
