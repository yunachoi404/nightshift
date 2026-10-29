import { useCallback, useEffect, useState } from "react";

/** The user's choice. "system" follows the OS; the inline script in index.html resolves it before first paint. */
export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const KEY = "nightshift.theme";
const listeners = new Set<(mode: ThemeMode) => void>();
const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

export function readThemeMode(): ThemeMode {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === "system") return media?.matches ? "dark" : "light";
  return mode;
}

function paint(mode: ThemeMode) {
  document.documentElement.dataset.theme = resolveTheme(mode);
}

export function applyThemeMode(mode: ThemeMode): void {
  if (mode === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, mode);
  paint(mode);
  // The desktop shell switches the window material and native controls to match.
  void window.nightshiftDesktop?.setTheme?.(mode).catch(() => undefined);
  for (const l of listeners) l(mode);
}

/** Apply the saved choice at boot and follow the system while the choice is "system". */
export function initTheme(): void {
  const mode = readThemeMode();
  paint(mode);
  void window.nightshiftDesktop?.setTheme?.(mode).catch(() => undefined);
  media?.addEventListener("change", () => {
    if (readThemeMode() === "system") paint("system");
  });
}

export function useThemeMode(): [ThemeMode, (m: ThemeMode) => void] {
  const [mode, setMode] = useState<ThemeMode>(() => readThemeMode());
  useEffect(() => {
    listeners.add(setMode);
    return () => {
      listeners.delete(setMode);
    };
  }, []);
  const set = useCallback((m: ThemeMode) => applyThemeMode(m), []);
  return [mode, set];
}
