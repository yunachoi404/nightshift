/**
 * Setup as every window sees it: whether it is done comes from the engine, never from this browser, and the First shot
 * step only asks the engine for its sample. A new window or profile, an engine restart, a second window and a remount
 * must never make a project or submit a job from the UI.
 */
import type { Event, HardwareProfile, Job, Onboarding, OnboardingSample, Project, RuntimeStatus, Settings, TierSummary } from "@nightshift/contract";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type NightshiftClient } from "@/api/client";
import { EngineProvider } from "@/store/engine";
import { App } from "./App";

vi.mock("@/api/config", () => ({
  isMock: () => false,
  getClient: () => {
    throw new Error("each test gives the app its own client");
  },
}));

const iso = () => new Date().toISOString();
const READY: Pick<RuntimeStatus, "phase" | "comfyui"> = { phase: "ready", comfyui: { running: true, url: "http://127.0.0.1:8188", version: "0.3" } };
const DOWN: RuntimeStatus["comfyui"] = { running: false, url: null, version: null };
const HW: HardwareProfile = { os: "macos", arch: "arm64", cpu: "Apple M4 Max", ramGb: 128, freeDiskGb: 900, gpus: [{ vendor: "apple", name: "Apple M4 Max", vramGb: 128, unifiedMemory: true }], source: "detected" };
/** What only an engine may start for the sample: a project and its jobs. */
const MAKES = ["createProject", "storyboard", "still", "draft"];

function project(id: string, name: string, extra: Partial<Project> = {}): Project {
  return { id, name, template: "cinematic_shot", aspect: "16:9", brief: {}, shots: [], takes: [], assets: [], timeline: null, createdAt: iso(), updatedAt: iso(), ...extra };
}

function job(id: string, projectId: string, step: Job["step"], status: Job["status"], shotId?: string): Job {
  return { id, projectId, step, mode: "now", status, progress: status === "done" ? 1 : 0.3, outputAssetIds: [], createdAt: iso(), ...(shotId ? { shotId } : {}) };
}

/**
 * An engine as the UI sees it, in memory, shared by any number of windows. Its sample route works like the real one:
 * the sample is made once. Every call from every window is recorded.
 */
class FakeEngine {
  status: RuntimeStatus = { ...READY, tier: "apple-64", memoryUsedGb: null, mode: "local" };
  settings: Settings = { tier: "apple-64", memoryLimitGb: null, overnight: { enabled: false, startAt: "23:00", endAt: "07:00" }, remote: null };
  onboarding: Onboarding = { done: false, sampleProjectId: null };
  tiers: TierSummary[] = [];
  projects: Project[] = [];
  jobs: Job[] = [];
  samplesMade = 0;
  calls: Array<{ method: string; args: unknown[] }> = [];
  private reachable = true;
  private windows = new Set<{ onEvent: (e: Event) => void; onConnection?: (connected: boolean) => void }>();

  called(method: string) {
    return this.calls.filter((c) => c.method === method);
  }

  made() {
    return this.calls.filter((c) => MAKES.includes(c.method));
  }

  setStatus(patch: Partial<RuntimeStatus>) {
    this.status = { ...this.status, ...patch };
    this.emit({ type: "runtime", status: this.status });
  }

  /** The engine stops: every window's event stream drops and every call fails. */
  stop() {
    this.reachable = false;
    for (const w of this.windows) w.onConnection?.(false);
  }

  /** The engine is back. */
  start(status: Partial<RuntimeStatus> = {}) {
    this.reachable = true;
    this.status = { ...this.status, ...status };
    for (const w of this.windows) w.onConnection?.(true);
  }

  client(): NightshiftClient {
    const answer = <T,>(method: string, args: unknown[], fn: () => T): Promise<T> => {
      this.calls.push({ method, args });
      if (!this.reachable) return Promise.reject(new ApiError("Could not reach the engine.", 0, "unreachable"));
      return Promise.resolve().then(() => structuredClone(fn()));
    };
    const known: Partial<NightshiftClient> = {
      kind: "http",
      status: () => answer("status", [], () => this.status),
      settings: () => answer("settings", [], () => this.settings),
      onboarding: () => answer("onboarding", [], () => this.onboarding),
      tiers: () => answer("tiers", [], () => this.tiers),
      hardware: () => answer("hardware", [], () => HW),
      listProjects: () => answer("listProjects", [], () => this.projects),
      listJobs: () => answer("listJobs", [], () => this.jobs),
      getProject: (id) =>
        answer("getProject", [id], () => {
          const p = this.projects.find((x) => x.id === id);
          if (!p) throw new ApiError(`No project ${id}`, 404);
          return p;
        }),
      startSample: (body) => answer("startSample", [body], () => this.sample(body?.again === true)),
      finishOnboarding: () =>
        answer("finishOnboarding", [], () => {
          this.onboarding = { ...this.onboarding, done: true };
          this.emit({ type: "onboarding", onboarding: this.onboarding });
          return this.onboarding;
        }),
      assetUrl: (pid, aid) => `/api/projects/${pid}/assets/${aid}`,
      events: (onEvent, onConnection) => {
        const w = { onEvent, ...(onConnection ? { onConnection } : {}) };
        this.windows.add(w);
        queueMicrotask(() => this.reachable && onConnection?.(true));
        return () => void this.windows.delete(w);
      },
    };
    // Anything else is recorded and never answers, so a test sees every call the UI makes.
    return new Proxy(known as NightshiftClient, {
      get: (target, key) => {
        if (typeof key !== "string" || key in target || key === "then") return Reflect.get(target, key);
        return (...args: unknown[]) => {
          this.calls.push({ method: key, args });
          return new Promise(() => undefined);
        };
      },
    });
  }

  private emit(e: Event) {
    for (const w of this.windows) w.onEvent(e);
  }

  private sample(again: boolean): OnboardingSample {
    const id = this.onboarding.sampleProjectId;
    if (!again && (id !== null || this.onboarding.done)) return { onboarding: this.onboarding, project: this.projects.find((p) => p.id === id) ?? null };
    this.samplesMade++;
    const p = project(`prj_sample_${this.samplesMade}`, "First shot");
    const text = job(`job_text_${this.samplesMade}`, p.id, "text", "running");
    this.projects.push(p);
    this.jobs.push(text);
    this.onboarding = { ...this.onboarding, sampleProjectId: p.id };
    this.emit({ type: "project", project: p });
    this.emit({ type: "job", job: text });
    this.emit({ type: "onboarding", onboarding: this.onboarding });
    return { onboarding: this.onboarding, project: p };
  }
}

/** A window (a new profile: nothing in this browser) on the engine, opened at `hash`. */
function open(engine: FakeEngine, hash: string) {
  window.location.hash = hash;
  return render(
    <EngineProvider client={engine.client()}>
      <App />
    </EngineProvider>,
  );
}

const where = () => window.location.hash.replace(/^#/, "") || "/";
const settle = () => act(() => new Promise((r) => setTimeout(r, 50)));
const DETECT = /Looking at your machine|Here's what you've got/;

describe("setup is the engine's fact", () => {
  it("a new window on a set-up engine opens the studio, even while the engine is still starting", async () => {
    const engine = new FakeEngine();
    engine.onboarding = { done: true, sampleProjectId: "prj_sample" };
    engine.projects = [project("prj_sample", "First shot"), project("prj_film", "My film")];
    engine.status = { ...engine.status, phase: "starting", comfyui: DOWN };
    open(engine, "#/");
    await screen.findByRole("heading", { name: "Projects" });
    await settle();
    expect(where()).toBe("/");

    act(() => engine.setStatus(READY));
    await settle();
    expect(where()).toBe("/");
    expect(screen.getAllByText("My film").length).toBeGreaterThan(0);
    expect(engine.called("startSample")).toEqual([]);
    expect(engine.made()).toEqual([]);
  });

  it("a new window opened on the setup screen of a set-up, ready engine goes to the studio", async () => {
    const engine = new FakeEngine();
    engine.onboarding = { done: true, sampleProjectId: null };
    open(engine, "#/setup");
    await screen.findByRole("heading", { name: "Projects" });
    expect(where()).toBe("/");
    expect(engine.called("startSample")).toEqual([]);
    expect(engine.made()).toEqual([]);
  });

  it("an engine that is not set up still sends a new window to setup while it starts", async () => {
    const engine = new FakeEngine();
    engine.status = { ...engine.status, phase: "starting", comfyui: DOWN };
    open(engine, "#/");
    await screen.findByRole("heading", { name: "Starting the engine" });
    expect(where()).toBe("/setup");
  });

  it("after setup, a machine with nothing to run on goes back to setup, and a ready engine returns to the studio without a sample", async () => {
    const engine = new FakeEngine();
    engine.onboarding = { done: true, sampleProjectId: "prj_sample" };
    engine.projects = [project("prj_sample", "First shot")];
    engine.status = { ...engine.status, phase: "not_installed", tier: null, comfyui: DOWN };
    engine.settings = { ...engine.settings, tier: null };
    open(engine, "#/settings");
    // Setup done before: the welcome is skipped.
    await screen.findByRole("heading", { name: DETECT });
    expect(where()).toBe("/setup");

    act(() => engine.setStatus({ ...READY, tier: "apple-64" }));
    await screen.findByRole("heading", { name: "Projects" });
    expect(where()).toBe("/");
    expect(engine.called("startSample")).toEqual([]);
    expect(engine.made()).toEqual([]);
  });
});

describe("the First shot step", () => {
  it("asks the engine for the sample and makes nothing itself", async () => {
    const engine = new FakeEngine();
    open(engine, "#/setup");
    await screen.findByRole("heading", { name: "Your first shot" });
    const status = await screen.findByText(/Writing the shot/);
    expect(status.textContent).not.toMatch(/writing/);
    expect(engine.called("startSample").map((c) => c.args[0])).toEqual([{}]);
    expect(engine.samplesMade).toBe(1);
    expect(engine.made()).toEqual([]);
  });

  it("an engine restart while on it shows the same sample and starts nothing new", async () => {
    const engine = new FakeEngine();
    open(engine, "#/setup");
    await screen.findByText(/Writing the shot/);

    act(() => engine.stop());
    await screen.findByRole("heading", { name: "Can't reach the engine" }, { timeout: 4000 });
    // The setup screen stays underneath, as it was.
    expect(where()).toBe("/setup");
    expect(screen.getByRole("heading", { name: "Your first shot" })).toBeTruthy();

    act(() => engine.start({ phase: "starting", comfyui: DOWN }));
    await screen.findByRole("heading", { name: "Starting the engine" });
    expect(screen.queryByRole("heading", { name: "Can't reach the engine" })).toBeNull();
    act(() => engine.setStatus(READY));
    await screen.findByText(/Writing the shot/);
    await waitFor(() => expect(engine.called("startSample")).toHaveLength(2));
    expect(engine.samplesMade).toBe(1);
    expect(where()).toBe("/setup");
    expect(engine.made()).toEqual([]);
  });

  it("two windows on one engine get one sample, and leaving setup in one leaves it in both", async () => {
    const engine = new FakeEngine();
    open(engine, "#/setup");
    open(engine, "#/setup");
    await waitFor(() => expect(engine.called("startSample")).toHaveLength(2));
    await waitFor(() => expect(screen.getAllByText(/Writing the shot/)).toHaveLength(2));
    expect(engine.samplesMade).toBe(1);

    fireEvent.click(screen.getAllByRole("button", { name: "Skip ahead" })[0]!);
    await waitFor(() => expect(screen.getAllByRole("heading", { name: "Projects" })).toHaveLength(2));
    expect(where()).toBe("/");
    expect(engine.onboarding.done).toBe(true);
    expect(engine.made()).toEqual([]);
  });

  it("a remount asks the engine again and never submits the draft again", async () => {
    const engine = new FakeEngine();
    const shot = { id: "shot_1", index: 0, prompt: "A lighthouse in a storm", durationSec: 4, locked: false, stillAssetId: "ast_still" };
    const still = { id: "ast_still", kind: "image" as const, path: "assets/ast_still.png", createdAt: iso() };
    engine.projects = [project("prj_sample", "First shot", { shots: [shot], assets: [still] })];
    engine.onboarding = { done: false, sampleProjectId: "prj_sample" };
    // The engine queued the draft after the still. It has not made a take yet.
    engine.jobs = [job("job_text", "prj_sample", "text", "done"), job("job_still", "prj_sample", "still", "done", "shot_1"), job("job_draft", "prj_sample", "video_draft", "running", "shot_1")];

    const first = open(engine, "#/setup");
    await screen.findByText(/Making the motion draft/);
    first.unmount();
    open(engine, "#/setup");
    await screen.findByText(/Making the motion draft/);
    await settle();
    expect(engine.called("startSample")).toHaveLength(2);
    expect(engine.samplesMade).toBe(0);
    expect(engine.made()).toEqual([]);
  });

  it("a deleted sample is not made again until the user asks for it", async () => {
    const engine = new FakeEngine();
    engine.onboarding = { done: false, sampleProjectId: "prj_gone" };
    open(engine, "#/setup");
    await screen.findByText("The sample shot was deleted");
    expect(engine.samplesMade).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Make it again" }));
    await screen.findByText(/Writing the shot/);
    expect(engine.called("startSample").map((c) => c.args[0])).toEqual([{}, { again: true }]);
    expect(engine.samplesMade).toBe(1);
    expect(engine.made()).toEqual([]);
  });
});

describe("setting up again", () => {
  it("says why, and keeps the memory limit the user chose, not the tier's default", async () => {
    const engine = new FakeEngine();
    engine.onboarding = { done: true, sampleProjectId: null };
    engine.projects = [project("prj_film", "My film")];
    // An install that needs updating sends a set-up machine back to setup.
    engine.status = { ...engine.status, phase: "not_installed", tier: "apple-64", comfyui: DOWN, error: "ComfyUI's Python packages need an update. Install again to update them." };
    engine.settings = { ...engine.settings, memoryLimitGb: 120 };
    engine.tiers = [{ tier: "apple-64", label: "Apple 64 GB", match: { vendor: "apple", unifiedMemory: true, minVramGb: 64, minRamGb: 64 }, downloadGb: 50, recommended: true, defaultMemoryLimitGb: 96 }];
    open(engine, "#/setup");
    expect(await screen.findByText("ComfyUI's Python packages need an update. Install again to update them.")).toBeTruthy();
    // The hardware tiles reveal one by one before Continue shows.
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }, { timeout: 3000 }));
    const slider = (await screen.findByRole("slider", { name: "Memory limit" })) as HTMLInputElement;
    await waitFor(() => expect(slider.value).toBe("120"));
    expect(screen.getByText("Setup needs to run again")).toBeTruthy();
  });
});

describe("the setup card", () => {
  const noRemaster: TierSummary = {
    tier: "apple-64",
    label: "Apple 64 GB",
    match: { vendor: "apple", unifiedMemory: true, minVramGb: 64, minRamGb: 64 },
    downloadGb: 50,
    recommended: true,
    steps: ["still", "video_draft", "video_final_same_take", "voice", "music", "text"],
    estimates: { still: { peakGb: 27, seconds: 50, measured: false } },
  };
  /** The Remaster time on the card: what it reads, and its tooltip. */
  const remaster = async () => {
    const label = await screen.findByText("Remaster", { selector: ".ob__time span" });
    const value = label.parentElement!.querySelector("b")!;
    return [value.textContent, value.getAttribute("title")];
  };

  it("reads None for a remaster this machine cannot do, with Not on this machine as its tooltip, on a first setup and a second", async () => {
    const first = new FakeEngine();
    first.status = { ...first.status, phase: "not_installed", tier: null, comfyui: DOWN };
    first.settings = { ...first.settings, tier: null };
    first.tiers = [noRemaster];
    const { unmount } = open(first, "#/setup");
    fireEvent.click(await screen.findByRole("button", { name: /Get started/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }, { timeout: 3000 }));
    expect(await remaster()).toEqual(["None", "Not on this machine"]);
    expect(screen.queryByText("Not on this machine")).toBeNull();
    unmount();

    const again = new FakeEngine();
    again.onboarding = { done: true, sampleProjectId: null };
    again.projects = [project("prj_film", "My film")];
    again.status = { ...again.status, phase: "not_installed", tier: "apple-64", comfyui: DOWN, error: "ComfyUI's Python packages need an update. Install again to update them." };
    again.tiers = [noRemaster];
    open(again, "#/setup");
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }, { timeout: 3000 }));
    expect(await remaster()).toEqual(["None", "Not on this machine"]);
    expect(screen.queryByText("Not on this machine")).toBeNull();
  });
});

describe("a dropped connection", () => {
  it("during setup keeps the step the user was on", async () => {
    const engine = new FakeEngine();
    engine.status = { ...engine.status, phase: "not_installed", tier: null, comfyui: DOWN };
    engine.settings = { ...engine.settings, tier: null };
    open(engine, "#/setup");
    fireEvent.click(await screen.findByRole("button", { name: /Get started/ }));
    await screen.findByRole("heading", { name: DETECT });

    act(() => engine.stop());
    await screen.findByRole("heading", { name: "Can't reach the engine" }, { timeout: 4000 });
    act(() => engine.start());
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Can't reach the engine" })).toBeNull());
    expect(screen.getByRole("heading", { name: DETECT })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Welcome to Nightshift" })).toBeNull();
  });

  it("after setup keeps the user where they were while the engine restarts", async () => {
    const engine = new FakeEngine();
    engine.onboarding = { done: true, sampleProjectId: null };
    engine.projects = [project("prj_film", "My film")];
    open(engine, "#/queue");
    await settle();
    expect(where()).toBe("/queue");

    act(() => engine.stop());
    await screen.findByRole("heading", { name: "Can't reach the engine" }, { timeout: 4000 });
    act(() => engine.start({ phase: "starting", comfyui: DOWN }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Can't reach the engine" })).toBeNull());
    act(() => engine.setStatus(READY));
    await settle();
    expect(where()).toBe("/queue");
    expect(engine.called("startSample")).toEqual([]);
  });
});

describe("the demo", () => {
  it("goes on from the GPU computer path with sample renders, as this Mac", async () => {
    const engine = new FakeEngine();
    engine.status = { ...engine.status, phase: "not_installed", tier: null, comfyui: DOWN, mode: "mock" };
    engine.settings = { ...engine.settings, tier: null };
    open(engine, "#/setup");
    fireEvent.click(await screen.findByRole("button", { name: /Get started/ }));
    await screen.findByRole("heading", { name: DETECT });
    await waitFor(() => expect(engine.called("hardware").length).toBeGreaterThan(0));
    await settle();

    fireEvent.click(screen.getByRole("radio", { name: "A GPU computer on my network" }));
    await screen.findByText("The demo can't connect to a GPU computer. Check still shows its hardware.");
    expect(screen.queryByRole("button", { name: /Use this computer/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Check" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Continue with sample renders" }));
    // The next step is the setup for this Mac. This fake engine has no setups, so it says so.
    await screen.findByRole("heading", { name: "Couldn't load the setups" });
    expect(engine.called("remoteUse")).toEqual([]);
  });
});
