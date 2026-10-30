import { useEffect, useState } from "react";
import { HashRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams } from "react-router";
import { useEngine, useEngineState, useProject } from "@/store/engine";
import { Button, Toaster, cx } from "@/ui/primitives";
import { Mark } from "@/ui/Mark";
import { Sidebar } from "./Sidebar";
import { Toolbar } from "./Toolbar";
import { useSidebar } from "./useSidebar";
import { Onboarding } from "@/features/onboarding/Onboarding";
import { Home } from "@/features/home/Home";
import { NewProject } from "@/features/newproject/NewProject";
import { Storyboard } from "@/features/storyboard/Storyboard";
import { Takes } from "@/features/takes/Takes";
import { Finals } from "@/features/finals/Finals";
import { Editor } from "@/features/editor/Editor";
import { MediaPage } from "@/features/media/MediaPage";
import { SettingsPage } from "@/features/settings/Settings";
import { QueuePage } from "@/features/queue/QueuePanel";
import { DevPanel } from "@/features/dev/DevPanel";
import { isDevMock } from "@/api/config";

export function App() {
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  );
}

/** A project's two areas, in nav order: Cmd+1 Media, Cmd+2 Editor. */
const stageKeys = ["media", "editor"] as const;

function Shell() {
  const state = useEngineState();
  const { reload } = useEngine();
  const loc = useLocation();
  const nav = useNavigate();
  const [devOpen, setDevOpen] = useState(false);
  const sidebar = useSidebar();
  const params = useProjectIdFromPath(loc.pathname);
  const project = useProject(params);
  const phase = state.status?.phase;
  const ready = phase === "ready";
  const onSetup = loc.pathname.startsWith("/setup");
  const onboarded = state.onboarding?.done === true;
  // Before setup is done, every phase but ready belongs to setup. After it, only a machine with nothing to run on, an
  // install, or a broken setup goes back there. A restart or a dropped connection leaves you where you were.
  const needsSetup = !ready && (!onboarded || phase === "not_installed" || phase === "installing" || phase === "error");
  // The engine went away after the app had loaded. The app stays as it was, under the "can't reach" screen.
  const lost = state.unreachable && state.status !== null;

  // Keyboard: Cmd+N new project, Cmd+, settings, Cmd+1 Media, Cmd+2 Editor, Cmd+\ sidebar, M mock panel, Escape closes.
  const toggleSidebar = sidebar.toggle;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      const cmd = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") setDevOpen(false);
      if (!typing && isDevMock() && (e.key === "m" || e.key === "M") && !cmd) setDevOpen((v) => !v);
      // The sidebar toggles from anywhere it shows, even while typing: Cmd+\ means nothing in a field.
      if (cmd && !e.altKey && !e.shiftKey && e.key === "\\" && !onSetup && !lost && !document.querySelector("dialog[open]")) {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      if (!cmd || e.altKey || onSetup || !ready || lost) return;
      if (e.key === "n" && !e.shiftKey) {
        e.preventDefault();
        nav("/new");
      } else if (e.key === ",") {
        e.preventDefault();
        nav("/settings");
      } else if (params && /^[1-2]$/.test(e.key) && !e.shiftKey) {
        e.preventDefault();
        nav(`/p/${params}/${stageKeys[Number(e.key) - 1]}`);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav, params, onSetup, ready, lost, toggleSidebar]);

  // Route guards: setup when it is needed; once the engine says setup is done, never the setup screens on a ready engine.
  useEffect(() => {
    if (!state.loaded || state.unreachable) return;
    if (needsSetup && !onSetup) nav("/setup", { replace: true });
    if (ready && onSetup && onboarded) nav("/", { replace: true });
  }, [state.loaded, state.unreachable, needsSetup, ready, onSetup, onboarded, nav]);

  if (!state.loaded) {
    return (
      <div className="app app--single">
        <div className="pane">
          <div className="titlebar drag" />
          <Splash />
        </div>
      </div>
    );
  }

  if (state.unreachable && !lost) {
    return (
      <div className="app app--single">
        <div className="pane">
          <div className="titlebar drag" />
          <Unreachable onRetry={() => void reload()} />
        </div>
        {isDevMock() && devOpen && <DevPanel onClose={() => setDevOpen(false)} />}
        {isDevMock() && <DevHotspot onOpen={() => setDevOpen(true)} />}
      </div>
    );
  }

  const devPanel = isDevMock() && devOpen && <DevPanel onClose={() => setDevOpen(false)} />;
  return (
    <>
      <div className={cx("app", onSetup ? "app--single" : sidebar.collapsed && "app--collapsed", sidebar.moving && "app--sidebar-moving")} inert={lost}>
        {!onSetup && <Sidebar collapsed={sidebar.collapsed} onToggle={sidebar.toggle} />}
        <div className="pane">
          {!onSetup && <Toolbar project={project} onDev={() => setDevOpen((v) => !v)} sidebarCollapsed={sidebar.collapsed} onToggleSidebar={sidebar.toggle} />}
          <div className="main">
            <Routes>
              {/* Redirect during render: a ready engine whose setup is done never shows the setup screens. */}
              <Route path="/setup" element={ready && onboarded ? <Navigate to="/" replace /> : <Onboarding onDev={() => setDevOpen(true)} />} />
              <Route path="/" element={<Home />} />
              <Route path="/new" element={<NewProject />} />
              <Route path="/queue" element={<QueuePage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/p/:id" element={<ProjectOutlet />}>
                <Route index element={<ProjectIndexRedirect />} />
                <Route path="media" element={<MediaPage />} />
                <Route path="editor" element={<Editor />} />
                {/* Out of the nav. Kept for old links, the What if? story editor and old quick shots. */}
                <Route path="storyboard" element={<Storyboard />} />
                <Route path="takes" element={<Takes />} />
                <Route path="finals" element={<Finals />} />
              </Route>
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
        </div>
        {!lost && devPanel}
        <Toaster />
      </div>
      {lost && (
        <div className="app app--single app--over">
          <div className="pane">
            <div className="titlebar drag" />
            <Unreachable onRetry={() => void reload()} />
          </div>
          {devPanel}
          {isDevMock() && <DevHotspot onOpen={() => setDevOpen(true)} />}
        </div>
      )}
    </>
  );
}

function useProjectIdFromPath(pathname: string): string | undefined {
  const m = /^\/p\/([^/]+)/.exec(pathname);
  return m?.[1];
}

function ProjectOutlet() {
  const { id } = useParams();
  const project = useProject(id);
  const { refreshProject } = useEngine();
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (project || !id) return;
    refreshProject(id).catch(() => setMissing(true));
  }, [id, project, refreshProject]);
  if (!project) {
    if (missing) return <Navigate to="/" replace />;
    return <div className="screen" />;
  }
  return <Outlet />;
}

/** A project opens on its media. */
function ProjectIndexRedirect() {
  const { id } = useParams();
  return <Navigate to={`/p/${id}/media`} replace />;
}

function Splash() {
  return (
    <div className="screen">
      <Mark size={64} label="Nightshift" />
    </div>
  );
}

function Unreachable({ onRetry }: { onRetry: () => void }) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = window.setInterval(onRetry, 4000);
    return () => window.clearInterval(t);
  }, [onRetry]);
  return (
    <div className="screen">
      <div className="screen__box">
        <Mark size={64} />
        <h1 className="screen__title" style={{ marginTop: 8 }}>
          Can't reach the engine
        </h1>
        <p className="screen__text">The part of Nightshift that runs on your machine isn't answering. If you just opened the app, give it a few seconds. Otherwise quit and open Nightshift again.</p>
        <div style={{ marginTop: 6 }}>
          <Button
            variant="primary"
            busy={busy}
            onClick={() => {
              setBusy(true);
              onRetry();
              window.setTimeout(() => setBusy(false), 800);
            }}
          >
            Try again
          </Button>
        </div>
        <p className="t-small t-muted">Retrying on its own every few seconds.</p>
      </div>
    </div>
  );
}

function DevHotspot({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="btn btn--quiet btn--s" style={{ position: "fixed", right: 12, top: 12 }}>
      Mock
    </button>
  );
}
