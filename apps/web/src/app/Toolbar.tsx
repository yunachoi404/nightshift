import type { Project } from "@nightshift/contract";
import { templates } from "@nightshift/contract";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { useJobs } from "@/store/engine";
import { Button, Segmented, cx } from "@/ui/primitives";
import { isDevMock } from "@/api/config";
import { projectStage, timelineShots, totalDuration } from "@/features/project/helpers";
import { plural, shortDuration } from "@/lib/format";
import { SidebarToggle } from "./Sidebar";
import { modKey } from "./useSidebar";
import { useCompute } from "./ComputePopover";
import { useCloseNewProject } from "@/features/newproject/close";

/** A project's two areas. The old storyboard, takes and finals pages belong to Media. */
type Stage = "media" | "editor";

export function Toolbar({ project, backTo, onDev, sidebarCollapsed, onToggleSidebar }: { project?: Project; backTo?: Project; onDev: () => void; sidebarCollapsed: boolean; onToggleSidebar: () => void }) {
  const loc = useLocation();
  const nav = useNavigate();
  const jobs = useJobs();
  const compute = useCompute();
  const stage: Stage = /^\/p\/[^/]+\/editor/.test(loc.pathname) ? "editor" : "media";

  // The sidebar's head carries the name; the toolbar says it only while the sidebar is hidden.
  let title = sidebarCollapsed ? "Nightshift" : "";
  // The subtitle's parts, most important last. Narrow windows drop the first ones (see .toolbar__sub in app.css).
  let sub: string[] = [];
  if (project) {
    title = project.name;
    const t = templates.find((x) => x.id === project.template);
    const s = projectStage(project, jobs, compute.away);
    const cut = timelineShots(project).length;
    sub = [t?.name, cut ? `${plural(cut, "shot")}, ${shortDuration(totalDuration(project))}` : null, s.label].filter((x): x is string => !!x);
  }
  const home = loc.pathname === "/";
  const creating = loc.pathname === "/new";
  // Settings and the queue name themselves in their page titles; the toolbar keeps the app's name, as on Home.
  // The queue and settings lead back to the project you came from.
  const back = !project && backTo && (loc.pathname === "/queue" || loc.pathname === "/settings") ? backTo : undefined;

  return (
    <header className={cx("toolbar drag", home && "toolbar--home")}>
      <div className="toolbar__left">
        {sidebarCollapsed && <SidebarToggle collapsed onToggle={onToggleSidebar} />}
        {back && (
          <Link to={`/p/${back.id}`} className="toolbar__back" title={`Back to ${back.name}`}>
            <ChevronLeft aria-hidden />
            <span className="toolbar__back-label">Back to {back.name}</span>
          </Link>
        )}
        {/* New project says where it sits: under Projects. */}
        {creating && (
          <nav className="toolbar__crumbs" aria-label="Breadcrumb">
            <Link to="/" className="toolbar__crumb">
              Projects
            </Link>
            <ChevronRight className="toolbar__crumb-sep" aria-hidden />
            <span className="toolbar__crumb toolbar__crumb--here" aria-current="page">
              New project
            </span>
          </nav>
        )}
        {/* With the way back shown, the page's own title says where you are. */}
        {!back && !creating && title && (
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
        )}
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
      {/* Where renders run lives at the foot of the sidebar. The right end holds what the page needs: the search on
          Projects, the way out of New project. */}
      <div className="toolbar__right">
        {home && <ProjectSearch />}
        {creating && <CloseNewProject />}
        {isDevMock() && (
          <Button variant="toolbar" size="s" onClick={onDev} title="Mock engine controls (press M)">
            Mock
          </Button>
        )}
      </div>
    </header>
  );
}

/** Searches the projects by name. The words live in the address (?q=), so Back returns to the same results. Cmd+K. */
function ProjectSearch() {
  const [params, setParams] = useSearchParams();
  const field = useRef<HTMLInputElement>(null);
  const q = params.get("q") ?? "";
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "k") return;
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault();
      field.current?.focus();
      field.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const setQuery = (value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set("q", value);
        else next.delete("q");
        return next;
      },
      { replace: true },
    );
  return (
    <label className="search">
      <Search className="search__icon" aria-hidden />
      <input
        ref={field}
        id="project-search"
        type="search"
        className="search__field"
        aria-label="Search projects"
        placeholder="Search projects"
        autoComplete="off"
        spellCheck={false}
        value={q}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          // Escape clears the words first, then leaves the field.
          e.preventDefault();
          if (q) setQuery("");
          else e.currentTarget.blur();
        }}
      />
      <kbd className="kbd search__keys" aria-hidden>
        {modKey()}K
      </kbd>
    </label>
  );
}

/** Leaves New project the way Escape does. */
function CloseNewProject() {
  const close = useCloseNewProject();
  return (
    <button type="button" className="toolbar__close" aria-label="Close" title="Close (Esc)" onClick={close}>
      <kbd className="kbd" aria-hidden>
        Esc
      </kbd>
      <X aria-hidden />
    </button>
  );
}
