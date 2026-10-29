import { desktopEngineUrl } from "@/lib/desktop";
import { createHttpClient } from "./http";
import { createMockClient } from "./mock/client";
import type { NightshiftClient } from "./client";

/**
 * Which engine the UI talks to. One setting:
 *   - `VITE_NIGHTSHIFT_API=mock` or unset in dev: the in-browser mock, with its controls (press M).
 *   - `VITE_NIGHTSHIFT_API=demo`: the browser demo. The same in-browser engine with real sample renders and no controls.
 *     The static build for GitHub Pages uses it (`pnpm build:pages`).
 *   - `VITE_NIGHTSHIFT_API=` (empty) or unset in a build: same origin (the engine serves the UI).
 *   - `VITE_NIGHTSHIFT_API=http://127.0.0.1:7788`: a specific engine.
 * `?api=mock`, `?api=demo` or `?api=http://host:port` in the URL overrides it and sticks in localStorage until
 * `?api=reset`. "Look around first" in a browser on a real engine sets `demo` the same way (store/demo.ts).
 */
export const API_KEY = "nightshift.api";

export function resolveApiBase(): string {
  const desktopBase = desktopEngineUrl();
  if (desktopBase !== null) return desktopBase;
  const params = new URLSearchParams(window.location.search);
  const override = params.get("api");
  if (override === "reset") localStorage.removeItem(API_KEY);
  else if (override) localStorage.setItem(API_KEY, override);
  const stored = localStorage.getItem(API_KEY);
  if (stored) return stored;
  return buildApiBase();
}

/** What this build talks to when nothing overrides it. */
export function buildApiBase(): string {
  const env = (import.meta.env.VITE_NIGHTSHIFT_API as string | undefined) ?? undefined;
  if (env !== undefined) return env;
  return import.meta.env.DEV ? "mock" : "";
}

let instance: NightshiftClient | null = null;
let base: string | null = null;

export function getClient(): NightshiftClient {
  if (instance) return instance;
  base = resolveApiBase();
  instance = base === "mock" || base === "demo" ? createMockClient(base === "demo" ? "demo" : "dev") : createHttpClient(base);
  return instance;
}

/** The UI runs on an in-browser engine: nothing is rendered or written to disk. */
export function isMock(): boolean {
  return getClient().kind === "mock";
}

/** The in-browser mock for building the UI, with its controls panel. The browser demo has no controls. */
export function isDevMock(): boolean {
  return isMock() && base !== "demo";
}

/** The browser demo: the in-browser engine with real sample renders, for people trying Nightshift. */
export function isBrowserDemo(): boolean {
  return isMock() && base === "demo";
}
