import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom has no media queries; the theme store reads one when it loads.
window.matchMedia ??= (query: string) =>
  ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false }) as MediaQueryList;

// Node 25 and later have a localStorage of their own that is undefined without --localstorage-file, and it hides
// jsdom's. Each test file gets an empty one in memory.
if (!globalThis.localStorage) {
  const items = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return items.size;
    },
    key: (i) => [...items.keys()][i] ?? null,
    getItem: (k) => items.get(k) ?? null,
    setItem: (k, v) => void items.set(k, String(v)),
    removeItem: (k) => void items.delete(k),
    clear: () => items.clear(),
  };
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.location.hash = "";
});

// Nor layout observers; media frames watch their size with one.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Nor media playback; take frames play their videos.
HTMLMediaElement.prototype.play = () => Promise.resolve();
HTMLMediaElement.prototype.pause = () => undefined;
HTMLMediaElement.prototype.load = () => undefined;
