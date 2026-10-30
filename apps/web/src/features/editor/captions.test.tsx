/**
 * The caption track's chips. A chip is as long as its line is on screen, which is often shorter than its words: the
 * chip ends in an ellipsis (CSS, on the text's own box) and grows to the whole line on hover. Before, the text sat
 * on the flex chip itself, where an ellipsis never applies, so a chip cut its line off mid-word ("In a w").
 */
import type { Event, Project } from "@nightshift/contract";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NightshiftClient } from "@/api/client";
import { App } from "@/app/App";
import { EngineProvider } from "@/store/engine";

vi.mock("@/api/config", () => ({
  API_KEY: "nightshift.api",
  buildApiBase: () => "",
  isMock: () => false,
  isDevMock: () => false,
  isBrowserDemo: () => false,
  getClient: () => {
    throw new Error("each test gives the app its own client");
  },
}));

// The filmstrip draws on a canvas, which jsdom lacks.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;

const PID = "prj_nocturne";
const iso = () => new Date().toISOString();
const LINES = ["Three in the morning. The city sleeps. You don't.", "Nocturne.", "Nothing gets in. Just the music, all night long, made for the night."];

const project: Project = {
  id: PID,
  name: "Nocturne ad",
  template: "product_ad",
  aspect: "16:9",
  brief: {},
  shots: [{ id: "shot_1", index: 0, prompt: "Headphones turning in mid-air in a dark void", durationSec: 2.04, stillAssetId: "ast_still", locked: false }],
  takes: [],
  assets: [
    { id: "ast_still", kind: "image", path: "assets/ast_still.png", createdAt: iso() },
    { id: "ast_voice", kind: "audio", path: "assets/ast_voice.wav", durationSec: 2, createdAt: iso() },
  ],
  timeline: {
    clips: [{ shotId: "shot_1", assetId: "ast_still", start: 0, in: 0, out: 2.04 }],
    audio: [{ assetId: "ast_voice", role: "voice", start: 0, gain: 1 }],
    captions: LINES.map((text, i) => ({ start: 0.2 + i * 0.6, end: 0.7 + i * 0.6, text })),
    style: {},
  },
  createdAt: iso(),
  updatedAt: iso(),
};

function client(): NightshiftClient {
  const answer = <T,>(fn: () => T): Promise<T> => Promise.resolve().then(() => structuredClone(fn()));
  const known: Partial<NightshiftClient> = {
    kind: "http",
    status: () => answer(() => ({ phase: "ready" as const, tier: "nvidia-8" as const, comfyui: { running: true, url: "http://127.0.0.1:8188", version: "0.41.3" }, memoryUsedGb: null, mode: "local" as const })),
    settings: () => answer(() => ({ tier: "nvidia-8" as const, memoryLimitGb: null, overnight: { enabled: false, startAt: "23:00", endAt: "07:00" }, remote: null })),
    onboarding: () => answer(() => ({ done: true, sampleProjectId: null })),
    tiers: () => answer(() => []),
    listProjects: () => answer(() => [project]),
    listJobs: () => answer(() => []),
    getProject: () => answer(() => project),
    assetUrl: (pid, aid) => `/api/projects/${pid}/assets/${aid}`,
    events: (_onEvent: (e: Event) => void, onConnection) => {
      queueMicrotask(() => onConnection?.(true));
      return () => undefined;
    },
  };
  // Anything else never answers.
  return new Proxy(known as NightshiftClient, {
    get: (target, key) => (typeof key !== "string" || key in target || key === "then" ? Reflect.get(target, key) : () => new Promise(() => undefined)),
  });
}

describe("the caption track", () => {
  it("keeps each whole line in a box of its own that ends in an ellipsis, and the chip sized to its time", async () => {
    window.location.hash = `#/p/${PID}/editor`;
    render(
      <EngineProvider client={client()}>
        <App />
      </EngineProvider>,
    );
    for (const line of LINES) {
      const text = await screen.findByText(line);
      expect(text.className).toBe("tl__caption-text");
      const chip = text.parentElement!;
      expect(chip.className).toContain("tl__caption");
      // Half a second on the timeline, whatever the length of the words.
      expect(chip.style.getPropertyValue("--cap-w")).toMatch(/^\d+(\.\d+)?px$/);
    }
    // A chip in the timeline's right half grows to the left on hover, so the timeline never scrolls for it.
    const chips = LINES.map((line) => screen.getByText(line).parentElement!);
    expect(chips.map((c) => c.classList.contains("tl__caption--end"))).toEqual([false, false, true]);
  });
});
