/**
 * Copy about lengths, times and finals follows the recipe the engine runs, not LTX 2.5's numbers. On the 8 GB tier a
 * shot is 2 s, the shot list takes minutes, and the "same take" final is the draft upscaled to 2x, which adds no
 * detail. A real run on an RTX 2080 SUPER found the app saying "4 to 12 seconds", "written in seconds" and "sharper",
 * and a header saying "6 s" for a 5 s cut.
 */
import type { Event, Job, Onboarding, Project, TierSummary } from "@nightshift/contract";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NightshiftClient } from "@/api/client";
import { EngineProvider } from "@/store/engine";
import { App } from "./App";

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

// The filmstrip draws on a canvas and the references keep object URLs, which jsdom lacks.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
URL.revokeObjectURL ??= () => undefined;

const iso = () => new Date().toISOString();
const MATCH = { vendor: "nvidia", unifiedMemory: false, minVramGb: 8, minRamGb: 16, maxVramGb: 24 } as const;

/** As the engine summarizes the shipped recipes. */
const NVIDIA_8: TierSummary = {
  tier: "nvidia-8",
  label: "NVIDIA 8-16 GB",
  match: MATCH,
  downloadGb: 55.8,
  recommended: true,
  steps: ["still", "video_draft", "video_final_same_take", "voice", "music", "text"],
  estimates: {
    still: { peakGb: 6.8, seconds: 150, measured: true },
    video_draft: { peakGb: 7.2, seconds: 60, measured: true },
    video_final_same_take: { peakGb: 0.3, seconds: 5, measured: true },
    voice: { peakGb: 4.5, seconds: 30, measured: true },
    music: { peakGb: 6.7, seconds: 45, measured: true },
    text: { peakGb: 5.4, seconds: 480, measured: true },
  },
  sameTake: { method: "upscale", scale: 2 },
  longestShotSec: 2.04,
  referenceImageLimit: 0,
};
const SPARK: TierSummary = {
  ...NVIDIA_8,
  tier: "unified-128-cuda",
  match: { vendor: "nvidia", unifiedMemory: true, minVramGb: 96, minRamGb: 96 },
  estimates: {
    still: { peakGb: 32.9, seconds: 31.4, measured: true },
    video_draft: { peakGb: 43.9, seconds: 56.2, measured: true },
    video_final_same_take: { peakGb: 46.2, seconds: 121.6, measured: true },
    text: { peakGb: 6.8, seconds: 10.4, measured: true },
  },
  sameTake: { method: "rerender", scale: 2 },
  longestShotSec: 4.04,
  referenceImageLimit: 3,
};

const PID = "prj_rain";
function rainRider(extra: Partial<Project> = {}): Project {
  const shots = [1, 2, 3].map((n) => ({ id: `shot_${n}`, index: n - 1, prompt: `Shot ${n} of a red motorcycle in the rain`, durationSec: 2.04, stillAssetId: `ast_still_${n}`, locked: false }));
  return {
    id: PID,
    name: "Rain Rider",
    template: "cinematic_shot",
    aspect: "16:9",
    brief: { idea: "A red motorcycle in the rain", sequence: "three" },
    shots,
    takes: [],
    assets: shots.map((s) => ({ id: s.stillAssetId, kind: "image" as const, path: `assets/${s.stillAssetId}.png`, createdAt: iso() })),
    timeline: null,
    createdAt: iso(),
    updatedAt: iso(),
    ...extra,
  };
}

/** Each shot with a picked draft. */
function withDrafts(p: Project): Project {
  return {
    ...p,
    shots: p.shots.map((s) => ({ ...s, chosenDraftId: `take_${s.id}` })),
    takes: p.shots.map((s) => ({ id: `take_${s.id}`, shotId: s.id, rung: "draft" as const, seed: 1, videoAssetId: `ast_draft_${s.id}`, jobId: `job_${s.id}` })),
    assets: [...p.assets, ...p.shots.map((s) => ({ id: `ast_draft_${s.id}`, kind: "video" as const, path: `assets/draft_${s.id}.mp4`, durationSec: 2.04, createdAt: iso() }))],
  };
}

function client(tier: TierSummary, projects: Project[], onboarding: Onboarding = { done: true, sampleProjectId: null }): NightshiftClient {
  const answer = <T,>(fn: () => T): Promise<T> => Promise.resolve().then(() => structuredClone(fn()));
  const known: Partial<NightshiftClient> = {
    kind: "http",
    status: () => answer(() => ({ phase: "ready" as const, tier: tier.tier, comfyui: { running: true, url: "http://127.0.0.1:8188", version: "0.41.3" }, memoryUsedGb: null, mode: "local" as const })),
    settings: () => answer(() => ({ tier: tier.tier, memoryLimitGb: null, overnight: { enabled: false, startAt: "23:00", endAt: "07:00" }, remote: null })),
    onboarding: () => answer(() => onboarding),
    tiers: () => answer(() => [tier]),
    listProjects: () => answer(() => projects),
    listJobs: () => answer((): Job[] => []),
    getProject: (id) => answer(() => projects.find((p) => p.id === id)!),
    startSample: () => answer(() => ({ onboarding, project: projects.find((p) => p.id === onboarding.sampleProjectId) ?? null })),
    draft: (projectId, shotId) => answer((): Job => ({ id: `job_draft_${shotId}`, projectId, shotId, step: "video_draft", mode: "now", status: "queued", progress: 0, outputAssetIds: [], createdAt: iso() })),
    final: (projectId, shotId) => answer((): Job => ({ id: `job_final_${shotId}`, projectId, shotId, step: "video_final_same_take", mode: "now", status: "queued", progress: 0, outputAssetIds: [], createdAt: iso() })),
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

function open(hash: string, c: NightshiftClient) {
  window.location.hash = hash;
  return render(
    <EngineProvider client={c}>
      <App />
    </EngineProvider>,
  );
}

describe("finals copy follows how the recipe finishes a take", () => {
  it("on the 8 GB tier says the final is the take upscaled to 2x, and never that it is sharper", async () => {
    const { unmount } = open(`#/p/${PID}/finals`, client(NVIDIA_8, [withDrafts(rainRider())]));
    await screen.findByText(/The takes you picked, upscaled to 2x\./);
    const sameTake = within(screen.getByRole("radiogroup", { name: "Kind of final" })).getAllByRole("radio")[0]!;
    expect(sameTake.textContent).toContain("The exact take you picked, upscaled to 2x. Same motion, same framing. It adds no detail.");
    expect(document.body.textContent).not.toMatch(/sharper|full.quality/i);
    unmount();
  });

  it("on an LTX 2.5 tier keeps saying the final renders the take again, sharper", async () => {
    const { unmount } = open(`#/p/${PID}/finals`, client(SPARK, [withDrafts(rainRider())]));
    const sameTake = within(await screen.findByRole("radiogroup", { name: "Kind of final" })).getAllByRole("radio")[0]!;
    expect(sameTake.textContent).toContain("Renders the exact take you picked at full quality. Same motion, same framing, sharper.");
    expect(screen.getByText(/Full-quality renders of the takes you picked\./)).toBeTruthy();
    unmount();
  });

  it("the First shot step on the 8 GB tier says the final upscales the draft, not that it sharpens it", async () => {
    const sample = withDrafts(rainRider({ id: "prj_sample", name: "First shot", shots: rainRider().shots.slice(0, 1) }));
    const { unmount } = open("#/setup", client(NVIDIA_8, [sample], { done: false, sampleProjectId: sample.id }));
    await screen.findByRole("heading", { name: "Your machine made this" });
    expect(screen.getByText(/A final upscales the take you like to 2x, now or overnight\./)).toBeTruthy();
    expect(screen.getByText(/The final upscales it to 2x\./)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/sharpens/);
    unmount();
  });
});

/** New project opens on Blank. The cinematic shot is one click away. */
async function pickCinematic() {
  fireEvent.click(await screen.findByRole("radio", { name: /^Cinematic shot/ }));
}

describe("new project copy follows the recipe's shot length", () => {
  it("on the 8 GB tier: 2 s shots, and the seeded shot list adds them up", async () => {
    const { unmount } = open("#/new", client(NVIDIA_8, []));
    await pickCinematic();
    await screen.findByText(/You get a short film-grade shot, or a three-shot sequence, 2 to 6 seconds\./);
    const length = screen.getByRole("radiogroup", { name: "Length" });
    expect(within(length).getByRole("radio", { name: "One shot, about 2 seconds" })).toBeTruthy();
    expect(screen.getByText("1 shot, about 2 seconds. Nothing renders yet.")).toBeTruthy();
    fireEvent.click(within(length).getByRole("radio", { name: "Three shots, about 6 seconds" }));
    expect(await screen.findByText("3 shots, about 6 seconds. Nothing renders yet.")).toBeTruthy();
    unmount();
  });

  it("on the Spark: 4 s shots", async () => {
    const { unmount } = open("#/new", client(SPARK, []));
    await pickCinematic();
    await screen.findByText(/a three-shot sequence, 4 to 12 seconds\./);
    const length = screen.getByRole("radiogroup", { name: "Length" });
    expect(within(length).getByRole("radio", { name: "One shot, 4 seconds" })).toBeTruthy();
    expect(within(length).getByRole("radio", { name: "Three shots, about 12 seconds" })).toBeTruthy();
    expect(screen.getByText("1 shot, 4 seconds. Nothing renders yet.")).toBeTruthy();
    unmount();
  });

  it("offers to start a cinematic shot from a photo only where the setup can render from photos", async () => {
    const spark = open("#/new", client(SPARK, []));
    await pickCinematic();
    expect(await screen.findByText("Start from a photo")).toBeTruthy();
    spark.unmount();

    // On the 8 GB tier the photo would become a reference no still can use.
    const small = open("#/new", client(NVIDIA_8, []));
    await pickCinematic();
    await screen.findByText(/2 to 6 seconds\./);
    expect(screen.queryByText("Start from a photo")).toBeNull();
    expect(screen.getByText(/this setup cannot render from photos/)).toBeTruthy();
    small.unmount();
  });
});

describe("the drafts toast", () => {
  it("says how long each draft takes from the recipe's estimate: about a minute on the 8 GB tier", async () => {
    const { unmount } = open(`#/p/${PID}/storyboard`, client(NVIDIA_8, [rainRider()]));
    fireEvent.click(await screen.findByRole("button", { name: "Make drafts" }));
    expect(await screen.findByText("About a minute each. Watch them land in Takes.")).toBeTruthy();
    unmount();
  });
});

describe("toasts and counts read as sentences", () => {
  it("the finish toast starts with a capital: \"A few seconds in all.\"", async () => {
    // A real Mac run showed "Finishing 1 shot" over "a few seconds in all. You can keep working."
    const oneShot = withDrafts(rainRider({ shots: rainRider().shots.slice(0, 1) }));
    const { unmount } = open(`#/p/${PID}/finals`, client(NVIDIA_8, [oneShot]));
    fireEvent.click(await screen.findByRole("button", { name: "Finish now" }));
    expect(await screen.findByText("A few seconds in all. You can keep working.")).toBeTruthy();
    unmount();
  });

  it("the editor says 1 line with word timings, not 1 lines", async () => {
    const captions = [{ start: 0.6, end: 1.5, text: "The last tram home.", words: [{ start: 0.6, end: 1.5, text: "The last tram home." }] }];
    const cut = { clips: [{ shotId: "shot_1", assetId: "ast_still_1", start: 0, in: 0, out: 2.04 }], audio: [], captions, style: {} };
    const { unmount } = open(`#/p/${PID}/editor`, client(NVIDIA_8, [rainRider({ timeline: cut })]));
    expect(await screen.findByText(/^1 line with word timings\./)).toBeTruthy();
    unmount();
  });
});

describe("the project header", () => {
  it("says how long the cut runs, not the shots added up: three 2 s drafts dissolve into a 5 s film", async () => {
    const cut = { clips: [0, 1.49, 2.98].map((start, i) => ({ shotId: `shot_${i + 1}`, assetId: `ast_still_${i + 1}`, start, in: 0, out: 1.995 })), audio: [], captions: [], style: {} };
    const { unmount } = open(`#/p/${PID}/storyboard`, client(NVIDIA_8, [rainRider({ timeline: cut })]));
    expect(await screen.findByText("3 shots, 5 s")).toBeTruthy();
    expect(screen.queryByText(/6 s/)).toBeNull();
    unmount();
  });

  it("adds up the shots before there is a cut", async () => {
    const { unmount } = open(`#/p/${PID}/storyboard`, client(NVIDIA_8, [rainRider()]));
    expect(await screen.findByText("3 shots, 6 s")).toBeTruthy();
    unmount();
  });
});
