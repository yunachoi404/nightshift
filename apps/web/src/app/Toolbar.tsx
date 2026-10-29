import type { Project } from "@nightshift/contract";
import { templates } from "@nightshift/contract";
import { Plus } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router";
import { useEngineState, useJobs } from "@/store/engine";
import { Button, Segmented, cx } from "@/ui/primitives";
import { isDevMock } from "@/api/config";
import { isGpuJob, jobLabel, projectStage } from "@/features/project/helpers";
import { plural, shortDuration } from "@/lib/format";
import { totalDuration } from "@/features/project/helpers";
import { useThisMachine } from "@/store/tier";

type Stage = "storyboard" | "takes" | "finals" | "editor";

export function Toolbar({ project, onDev }: { project?: Project; onDev: () => void }) {
  const loc = useLocation();
  const nav = useNavigate();
  const jobs = useJobs();
  const stage = (/^\/p\/[^/]+\/(storyboard|takes|finals|editor)/.exec(loc.pathname)?.[1] as Stage | undefined) ?? "storyboard";

  let title = "Nightshift";
  // The subtitle's parts, most important last. Narrow windows drop the first ones (see .toolbar__sub in app.css).
  let sub: string[] = [];
  if (project) {
    title = project.name;
    const t = templates.find((x) => x.id === project.template);
    const s = projectStage(project, jobs);
    sub = [t?.name, project.shots.length ? `${plural(project.shots.length, "shot")}, ${shortDuration(totalDuration(project))}` : null, s.label].filter((x): x is string => !!x);
  } else if (loc.pathname === "/settings") title = "Settings";
  else if (loc.pathname === "/new") title = "New project";
  else if (loc.pathname === "/queue") title = "Queue";

  return (
    <header className="toolbar drag">
      <div className="toolbar__left">
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
              { value: "storyboard", label: project.template === "camera_move" ? "Photo & move" : project.template === "vfx_effect" ? "Photo & effect" : "Storyboard" },
              { value: "takes", label: "Takes" },
              { value: "finals", label: "Finals" },
              { value: "editor", label: "Editor" },
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

/** The running job as a small ring and a few words. Opens the queue. */
function Activity() {
  const { status, settings, projects } = useEngineState();
  const jobs = useJobs();
  const loc = useLocation();
  const running = jobs.find((j) => j.status === "running");
  const queued = jobs.filter((j) => j.status === "queued");
  const remote = status?.mode === "remote" ? settings?.remote : null;
  const remoteName = remote ? (remote.name ?? remote.url.replace(/^https?:\/\//, "")) : null;
  const here = useThisMachine();

  if (!status || status.phase !== "ready") return null;
  if (!status.comfyui.running && (!running || isGpuJob(running))) {
    return (
      <Link to="/queue" className="activity" aria-current={loc.pathname === "/queue" ? "page" : undefined} title={status.error}>
        <span className="pulse pulse--idle" />
        <span>{remoteName ? `Waiting for ${remoteName}` : "Waiting for the GPU"}</span>
      </Link>
    );
  }
  if (running) {
    const night = running.mode === "overnight";
    return (
      <Link to="/queue" className={cx("activity", night && "activity--night")} aria-current={loc.pathname === "/queue" ? "page" : undefined}>
        <span className={cx("ring", night && "ring--night")} style={{ "--pct": Math.round(running.progress * 100) } as React.CSSProperties} />
        <ActivityLabel label={jobLabel(running, projects[running.projectId])} where={remoteName ? (isGpuJob(running) ? remoteName : here.lower) : undefined} />
      </Link>
    );
  }
  if (queued.length) {
    const night = queued.some((j) => j.mode === "overnight");
    return (
      <Link to="/queue" className={cx("activity", night && "activity--night")} aria-current={loc.pathname === "/queue" ? "page" : undefined}>
        <span className={cx("pulse", night ? "pulse--night" : "pulse--idle")} />
        <span>{night ? `${queued.length} for tonight` : `${queued.length} queued`}</span>
      </Link>
    );
  }
  if (remoteName) {
    return (
      <Link to="/settings" className="activity" title={`Work runs on ${remoteName} at ${remote!.url}`}>
        <span className="pulse pulse--ok" />
        <span>{remoteName}</span>
      </Link>
    );
  }
  return null;
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
