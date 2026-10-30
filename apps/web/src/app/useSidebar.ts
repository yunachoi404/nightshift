import { useCallback, useEffect, useRef, useState } from "react";

const KEY = "nightshift.sidebar.collapsed";
/** How long the width animates (app.css, .app--sidebar-moving) plus a little slack. */
const MOVE_MS = 260;

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "true";
  } catch {
    return false;
  }
}

/** The modifier of the app's shortcuts as this platform writes it: ⌘ on a Mac, Ctrl+ elsewhere. */
export function modKey(): string {
  const mac = window.nightshiftDesktop ? window.nightshiftDesktop.platform === "darwin" : /Mac|iPhone|iPad/.test(navigator.userAgent);
  return mac ? "⌘" : "Ctrl+";
}

/** The sidebar's shortcut: Cmd+\ on a Mac, Ctrl+\ elsewhere. */
export function sidebarShortcut(): string {
  return `${modKey()}\\`;
}

/**
 * The left sidebar, open or collapsed, remembered on this machine. `moving` is on only while a toggle animates, so
 * the width never animates on load or on a window resize. Focus that sat in the sidebar or on a toggle follows to
 * the toggle that is still there.
 */
export function useSidebar() {
  const [collapsed, setCollapsed] = useState(read);
  const [moving, setMoving] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const refocus = useRef(false);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, collapsed ? "true" : "false");
    } catch {
      // Private windows may refuse storage; the choice then lasts for this session.
    }
    if (!refocus.current) return;
    refocus.current = false;
    document.querySelector<HTMLElement>(collapsed ? ".toolbar [data-sidebar-toggle]" : ".sidebar [data-sidebar-toggle]")?.focus();
  }, [collapsed]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const toggle = useCallback(() => {
    const active = document.activeElement;
    refocus.current = !!active && (!!active.closest("[data-sidebar-toggle]") || !!active.closest(".sidebar"));
    setCollapsed((c) => !c);
    setMoving(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMoving(false), MOVE_MS);
  }, []);

  return { collapsed, moving, toggle };
}
