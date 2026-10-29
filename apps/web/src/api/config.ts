import { desktopEngineUrl } from "@/lib/desktop";
import { createHttpClient } from "./http";
import { createMockClient } from "./mock/client";
import type { NightshiftClient } from "./client";

/**
 * Which engine the UI talks to. One setting:
 *   - `VITE_NIGHTSHIFT_API=mock` or unset in dev: the in-browser mock.
 *   - `VITE_NIGHTSHIFT_API=` (empty) or unset in a build: same origin (the engine serves the UI).
 *   - `VITE_NIGHTSHIFT_API=http://127.0.0.1:7788`: a specific engine.
 * `?api=mock` or `?api=http://host:port` in the URL overrides it and sticks in localStorage until `?api=reset`.
 */
export function resolveApiBase(): string {
  const desktopBase = desktopEngineUrl();
  if (desktopBase !== null) return desktopBase;
  const params = new URLSearchParams(window.location.search);
  const override = params.get("api");
  if (override === "reset") localStorage.removeItem("nightshift.api");
  else if (override) localStorage.setItem("nightshift.api", override);
  const stored = localStorage.getItem("nightshift.api");
  if (stored) return stored;
  const env = (import.meta.env.VITE_NIGHTSHIFT_API as string | undefined) ?? undefined;
  if (env !== undefined) return env;
  return import.meta.env.DEV ? "mock" : "";
}

let instance: NightshiftClient | null = null;

export function getClient(): NightshiftClient {
  if (instance) return instance;
  const base = resolveApiBase();
  instance = base === "mock" ? createMockClient() : createHttpClient(base);
  return instance;
}

export function isMock(): boolean {
  return getClient().kind === "mock";
}
