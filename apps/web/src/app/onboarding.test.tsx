/**
 * Setup as every window sees it: whether it is done comes from the engine, never from this browser, and the First shot
 * step only asks the engine for its sample. A new window or profile, an engine restart, a second window and a remount
 * must never make a project or submit a job from the UI.
 */
import type { Event, HardwareProfile, InstallPlan, Job, Onboarding, OnboardingSample, Project, RuntimeStatus, Settings, TierSummary } from "@nightshift/contract";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type NightshiftClient } from "@/api/client";
import { EngineProvider } from "@/store/engine";
import { initializeDesktop } from "@/lib/desktop";
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
  /** The install plan for any tier `plans` has none for. */
  plan: InstallPlan = { tier: "apple-64", downloads: [], alreadyPresent: [], totalDownloadGb: 20, freeDiskGb: 900, fits: true };
  /** Install plans by tier. */
  plans: Record<string, InstallPlan> = {};
  /** What a scan for models on this computer answers: the plan with what it found, or an error. */
  scan: (body: { tier: string; folders?: string[] }) => InstallPlan | Error = (body) => ({ ...this.plan, tier: body.tier, scan: { at: iso(), folders: body.folders ?? [], searched: [], unreadable: [] } });
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

  /** An install's progress, as the engine sends it to every window. */
  progress(progress: Extract<Event, { type: "install" }>["progress"]) {
    this.emit({ type: "install", progress });
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
      installPlan: (tier) => answer("installPlan", [tier], () => this.plans[tier] ?? { ...this.plan, tier }),
      scanModels: (body) =>
        answer("scanModels", [body], () => {
          const result = this.scan(body);
          if (result instanceof Error) throw result;
          this.plans[body.tier] = result;
          return result;
        }),
      // Like the engine: the tier is saved only once it is installed, so a first install has none in settings.
      install: (body) => answer("install", [body], () => this.setStatus({ phase: "installing", tier: body.tier, comfyui: DOWN, error: undefined })),
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

  describe("while it renders", () => {
    // The 8 GB setup's times: a three-shot list 480 s (208 s for one shot), a still 150 s, a draft 60 s.
    const nvidia8: TierSummary = {
      tier: "apple-64",
      label: "8 GB",
      match: { vendor: "nvidia", unifiedMemory: false, minVramGb: 8, minRamGb: 16 },
      downloadGb: 56,
      recommended: true,
      estimates: { text: { peakGb: 5.4, seconds: 480, measured: true }, still: { peakGb: 6.8, seconds: 150, measured: true }, video_draft: { peakGb: 7.2, seconds: 60, measured: true } },
    };
    /** The step the empty frame marks as under way. */
    const current = () => document.querySelector(".ob__shot [aria-current='step']")?.textContent;

    it("says about how long it all takes on this machine, and the empty frame names the step under way", async () => {
      const engine = new FakeEngine();
      engine.tiers = [nvidia8];
      open(engine, "#/setup");
      await screen.findByText(/Writing the shot/);
      expect(await screen.findByText("About 7 minutes on this machine")).toBeTruthy();
      expect(current()).toBe("Shot list");
    });

    it("once the shot list is written, says what is left", async () => {
      const engine = new FakeEngine();
      engine.tiers = [nvidia8];
      const shot = { id: "shot_1", index: 0, prompt: "A lighthouse in a storm", durationSec: 2, locked: false };
      engine.projects = [project("prj_sample", "First shot", { shots: [shot] })];
      engine.onboarding = { done: false, sampleProjectId: "prj_sample" };
      // The still has run for 90 of its 150 s; the draft's 60 s come after.
      const still = { ...job("job_still", "prj_sample", "still", "running", "shot_1"), startedAt: new Date(Date.now() - 90_000).toISOString() };
      engine.jobs = [job("job_text", "prj_sample", "text", "done"), still];
      open(engine, "#/setup");
      expect(await screen.findByText("About 2 minutes left")).toBeTruthy();
      expect(current()).toBe("Still");
      expect(screen.getByText(/Shot list/).closest("li")!.className).toContain("ob__stp--done");
    });

    it("a sample that starts with its template's shot list still shows the shot list under way until its job is done", async () => {
      const engine = new FakeEngine();
      const shot = { id: "shot_1", index: 0, prompt: "A lighthouse in a storm", durationSec: 4, locked: false };
      engine.projects = [project("prj_sample", "First shot", { shots: [shot] })];
      engine.onboarding = { done: false, sampleProjectId: "prj_sample" };
      engine.jobs = [job("job_text", "prj_sample", "text", "running")];
      open(engine, "#/setup");
      await screen.findByText(/Writing the shot/);
      expect(current()).toBe("Shot list");
    });

    it("says no time where the setup has none", async () => {
      const engine = new FakeEngine();
      open(engine, "#/setup");
      await screen.findByText(/Writing the shot/);
      expect(screen.queryByText(/on this machine|left$/)).toBeNull();
      expect(current()).toBe("Shot list");
    });
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
    // The slider says what its number is: memory Nightshift may use, not the room left over.
    expect(screen.getByText(/The most memory Nightshift may use/)).toBeTruthy();
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

describe("a first install that fails", () => {
  it("says why, tries again with the tier and memory limit the user chose, and goes back to the setup card on them", async () => {
    const engine = new FakeEngine();
    engine.status = { ...engine.status, phase: "not_installed", tier: null, comfyui: DOWN };
    engine.settings = { ...engine.settings, tier: null };
    engine.tiers = [{ tier: "apple-64", label: "Apple 64 GB", match: { vendor: "apple", unifiedMemory: true, minVramGb: 64, minRamGb: 64 }, downloadGb: 20, recommended: true, defaultMemoryLimitGb: 96 }];
    open(engine, "#/setup");
    fireEvent.click(await screen.findByRole("button", { name: /Get started/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }, { timeout: 3000 }));
    const slider = (await screen.findByRole("slider", { name: "Memory limit" })) as HTMLInputElement;
    await waitFor(() => expect(slider.value).toBe("96"));
    fireEvent.change(slider, { target: { value: "110" } });
    fireEvent.click(await screen.findByRole("button", { name: "Download 20 GB" }));
    await screen.findByRole("heading", { name: "Downloading your setup" });

    // What the engine reports when an install fails with nothing to fall back to.
    act(() => engine.setStatus({ phase: "error", tier: "apple-64", error: "HTTP 404 for github.com/Comfy-Org/ComfyUI/archive/refs/tags/v0.41.3.tar.gz" }));
    await screen.findByRole("heading", { name: "The download stopped" });
    expect(screen.getByText("HTTP 404 for github.com/Comfy-Org/ComfyUI/archive/refs/tags/v0.41.3.tar.gz")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Downloading your setup" });
    expect(engine.called("install").map((c) => c.args[0])).toEqual([
      { tier: "apple-64", memoryLimitGb: 110 },
      { tier: "apple-64", memoryLimitGb: 110 },
    ]);

    const disk = "Not enough disk space: 20 GB to download, 12 GB free on the data drive.";
    act(() => engine.setStatus({ phase: "error", tier: "apple-64", error: disk }));
    await screen.findByRole("heading", { name: "The download stopped" });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    // The setup card, on the setup and limit the user chose, and why the last try stopped.
    await screen.findByRole("heading", { name: "This machine can do all of it" });
    expect(screen.getByText("Setup stopped")).toBeTruthy();
    expect(screen.getByText(disk)).toBeTruthy();
    expect((screen.getByRole("slider", { name: "Memory limit" }) as HTMLInputElement).value).toBe("110");
    // Further back is the hardware step, and the choice holds through it.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("heading", { name: DETECT });
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }, { timeout: 3000 }));
    await waitFor(() => expect((screen.getByRole("slider", { name: "Memory limit" }) as HTMLInputElement).value).toBe("110"));
    fireEvent.click(await screen.findByRole("button", { name: "Download 20 GB" }));
    await screen.findByRole("heading", { name: "Downloading your setup" });
    expect(engine.called("install").map((c) => c.args[0])).toEqual([
      { tier: "apple-64", memoryLimitGb: 110 },
      { tier: "apple-64", memoryLimitGb: 110 },
      { tier: "apple-64", memoryLimitGb: 110 },
    ]);
  });

  it("tries again with exactly what Download installed, on the setup's defaults", async () => {
    // A setup with no default limit of its own starts the card at 80% of memory. Try again must ask for that too, not
    // leave the limit to the engine.
    const engine = new FakeEngine();
    engine.status = { ...engine.status, phase: "not_installed", tier: null, comfyui: DOWN };
    engine.settings = { ...engine.settings, tier: null };
    engine.tiers = [{ tier: "apple-64", label: "Apple 64 GB", match: { vendor: "apple", unifiedMemory: true, minVramGb: 64, minRamGb: 64 }, downloadGb: 20, recommended: true }];
    open(engine, "#/setup");
    fireEvent.click(await screen.findByRole("button", { name: /Get started/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }, { timeout: 3000 }));
    await waitFor(() => expect((screen.getByRole("slider", { name: "Memory limit" }) as HTMLInputElement).value).toBe("102"));
    fireEvent.click(await screen.findByRole("button", { name: "Download 20 GB" }));
    await screen.findByRole("heading", { name: "Downloading your setup" });
    act(() => engine.setStatus({ phase: "error", tier: "apple-64", error: "Lost the connection while downloading." }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Downloading your setup" });
    expect(engine.called("install").map((c) => c.args[0])).toEqual([
      { tier: "apple-64", memoryLimitGb: 102 },
      { tier: "apple-64", memoryLimitGb: 102 },
    ]);
  });
});

describe("a window opened in the middle of an install", () => {
  it("counts the files on disk, not the ones the plan lists before the current one", async () => {
    const engine = new FakeEngine();
    engine.status = { ...engine.status, phase: "installing", tier: "apple-64", comfyui: DOWN };
    engine.settings = { ...engine.settings, tier: null };
    const file = (id: string, sizeGb: number) => ({ id, folder: "diffusion_models", filename: `${id}.safetensors`, url: "https://example.com/m", sizeGb, license: { name: "MIT", url: "https://example.com/l" } });
    // Two files came down before this window opened; the plan now lists only what is left.
    engine.plan = { ...engine.plan, alreadyPresent: ["image", "text"], downloads: [file("video", 1), file("vae", 1), file("voice", 10)] };
    open(engine, "#/setup");
    await screen.findByRole("heading", { name: "Downloading your setup" });
    act(() => engine.progress({ modelId: "video", doneGb: 15, totalGb: 25, message: "Downloading video.safetensors" }));
    expect(await screen.findByText("15 GB of 25 GB, 2 of 5 files")).toBeTruthy();
  });
});

describe("the download line", () => {
  const file = (id: string, filename: string, sizeGb: number, name?: string) => ({ id, ...(name ? { name } : {}), folder: "diffusion_models", filename, url: "https://example.com/m", sizeGb, license: { name: "MIT", url: "https://example.com/l" } });

  it("names the file in plain words with its size, and keeps the raw file name for the tooltip", async () => {
    const engine = new FakeEngine();
    engine.status = { ...engine.status, phase: "installing", tier: "nvidia-8", comfyui: DOWN };
    engine.settings = { ...engine.settings, tier: null };
    engine.plan = {
      ...engine.plan,
      downloads: [
        file("k6", "diffusion_pytorch_model.safetensors", 6.38, "Kandinsky 6 Lite, video model"),
        file("qwen", "qwen_2.5_vl_7b_fp8_scaled.safetensors", 9.38, "Qwen2.5-VL 7B, video prompt reader"),
        file("cfg", "config.json", 0.00002, "Breeze TTS 2, settings"),
        file("old", "old_model.safetensors", 2),
      ],
    };
    open(engine, "#/setup");
    await screen.findByRole("heading", { name: "Downloading your setup" });

    act(() => engine.progress({ modelId: "k6", doneGb: 1, totalGb: 18, message: "Downloading Kandinsky 6 Lite, video model" }));
    const line = await screen.findByText("Downloading Kandinsky 6 Lite, video model, 6.4 GB");
    expect(line.getAttribute("title")).toBe("diffusion_pytorch_model.safetensors");
    expect(screen.queryByText(/diffusion_pytorch_model/)).toBeNull();

    // A settings file of a few kilobytes has no size worth showing.
    act(() => engine.progress({ modelId: "cfg", doneGb: 7, totalGb: 18, message: "Downloading Breeze TTS 2, settings" }));
    expect((await screen.findByText("Downloading Breeze TTS 2, settings")).getAttribute("title")).toBe("config.json");

    // A recipe written before files had names: the engine's own words.
    act(() => engine.progress({ modelId: "old", doneGb: 8, totalGb: 18, message: "Downloading old_model.safetensors" }));
    expect(await screen.findByText("Downloading old_model.safetensors")).toBeTruthy();
  });
});

describe("other setups", () => {
  const apple64: TierSummary = { tier: "apple-64", label: "Apple 64 GB", match: { vendor: "apple", unifiedMemory: true, minVramGb: 64, minRamGb: 64 }, downloadGb: 122, recommended: true };
  const apple16: TierSummary = { tier: "apple-16", label: "Apple 16-32 GB", match: { vendor: "apple", unifiedMemory: true, minVramGb: 16, maxVramGb: 64, minRamGb: 16 }, downloadGb: 63, recommended: false };
  const plan = (tier: string, totalDownloadGb: number, fits: boolean): InstallPlan => ({ tier, downloads: [], alreadyPresent: [], totalDownloadGb, freeDiskGb: 73, fits });

  it("offer the lighter setup on a bigger Mac whose disk can't hold the recommended one", async () => {
    // A real 128 GB M4 Max with 73 GB free: the 122 GB setup didn't fit, and the 63 GB one was greyed out as
    // "For a different kind of machine" while the notice said to pick a lighter setup.
    const engine = new FakeEngine();
    engine.status = { ...engine.status, phase: "not_installed", tier: null, comfyui: DOWN };
    engine.settings = { ...engine.settings, tier: null };
    engine.tiers = [
      apple64,
      apple16,
      // Within 5% of the 128 GB this Mac reports, as the engine matches requirements; and one far beyond it.
      { ...apple64, tier: "apple-134", match: { ...apple64.match, minVramGb: 134, minRamGb: 134 }, downloadGb: 140, recommended: false },
      { ...apple64, tier: "apple-192", match: { ...apple64.match, minVramGb: 192, minRamGb: 192 }, downloadGb: 160, recommended: false },
    ];
    engine.plans = { "apple-64": plan("apple-64", 122, false), "apple-16": plan("apple-16", 63, true) };
    open(engine, "#/setup");
    fireEvent.click(await screen.findByRole("button", { name: /Get started/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }, { timeout: 3000 }));
    expect(await screen.findByText("Not enough free disk space")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Other setups/ }));
    const setups = screen.getByRole("radiogroup", { name: "Other setups" });
    const lighter = within(setups).getByRole("radio", { name: /lighter/ }) as HTMLButtonElement;
    expect(lighter.disabled).toBe(false);
    expect(lighter.textContent).toContain("Fewer gigabytes, softer renders");
    expect((within(setups).getByRole("radio", { name: /140 GB/ }) as HTMLButtonElement).disabled).toBe(false);
    const tooBig = within(setups).getByRole("radio", { name: /160 GB/ }) as HTMLButtonElement;
    expect(tooBig.disabled).toBe(true);
    expect(tooBig.textContent).toContain("Needs 192 GB of graphics memory");

    fireEvent.click(lighter);
    const download = (await screen.findByRole("button", { name: "Download 63 GB" })) as HTMLButtonElement;
    expect(download.disabled).toBe(false);
    expect(screen.queryByText("Not enough free disk space")).toBeNull();
  });

  it("open on the setup installed here at its limit when it must be set up again, not on the recommended one", async () => {
    // After an update changed a node pack, a Mac set up with the 63 GB setup at 24 GB opened on the 122 GB setup at
    // 58 GB, which does not fit its disk.
    const engine = new FakeEngine();
    engine.status = { ...engine.status, phase: "not_installed", tier: "apple-16", comfyui: DOWN, error: "Node pack(s) MOSS-Image are missing. Install again to fetch them." };
    engine.settings = { ...engine.settings, tier: "apple-16", memoryLimitGb: 24 };
    engine.tiers = [apple64, { ...apple16, defaultMemoryLimitGb: 102 }];
    engine.plans = { "apple-64": plan("apple-64", 98, false), "apple-16": plan("apple-16", 0.1, true) };
    open(engine, "#/setup");
    fireEvent.click(await screen.findByRole("button", { name: /Get started/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }, { timeout: 3000 }));
    expect(await screen.findByRole("heading", { name: "A lighter setup" })).toBeTruthy();
    expect(screen.getByText("Setup needs to run again")).toBeTruthy();
    expect(screen.getByText("Node pack(s) MOSS-Image are missing. Install again to fetch them.")).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("slider", { name: "Memory limit" }) as HTMLInputElement).value).toBe("24"));
    expect(await screen.findByRole("button", { name: "Download 100 MB" })).toBeTruthy();
    expect(screen.queryByText("Not enough free disk space")).toBeNull();
  });

  it("after an install that stops, come back to the setup and limit the user chose, and say why", async () => {
    // On a real Mac the first install failed in a second. Setup came back on the 122 GB setup at the default 102 GB
    // limit with no word of what went wrong, and the disk notice for that setup read as the reason. The engine now
    // reports a failure as an error (the next test); an install that stops without failing still ends not installed.
    const engine = new FakeEngine();
    engine.status = { ...engine.status, phase: "not_installed", tier: null, comfyui: DOWN };
    engine.settings = { ...engine.settings, tier: null };
    engine.tiers = [apple64, { ...apple16, defaultMemoryLimitGb: 102 }];
    engine.plans = { "apple-64": plan("apple-64", 122, false), "apple-16": plan("apple-16", 63, true) };
    open(engine, "#/setup");
    fireEvent.click(await screen.findByRole("button", { name: /Get started/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }, { timeout: 3000 }));
    fireEvent.click(await screen.findByRole("button", { name: /Other setups/ }));
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Other setups" })).getByRole("radio", { name: /lighter/ }));
    const slider = (await screen.findByRole("slider", { name: "Memory limit" })) as HTMLInputElement;
    await waitFor(() => expect(slider.value).toBe("102"));
    fireEvent.change(slider, { target: { value: "24" } });
    fireEvent.click(await screen.findByRole("button", { name: "Download 63 GB" }));
    expect(engine.called("install")[0]?.args).toEqual([{ tier: "apple-16", memoryLimitGb: 24 }]);

    act(() => engine.setStatus({ phase: "installing", tier: "apple-16" }));
    await screen.findByText("Downloading your setup");
    const why = "uv pip install --python exited with 2: error: File not found: `/Users/me/Library/Application`";
    act(() => engine.setStatus({ phase: "not_installed", tier: "apple-16", error: why }));
    expect(await screen.findByText("Setup stopped")).toBeTruthy();
    expect(screen.getByText(why)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "A lighter setup" })).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("slider", { name: "Memory limit" }) as HTMLInputElement).value).toBe("24"));
    expect(screen.getByRole("button", { name: "Download 63 GB" })).toBeTruthy();
  });

  it("after an install that fails, try again and go back with the setup and limit the user chose", async () => {
    // The same Mac on today's engine: the failure is an error, with Try again and Back.
    const engine = new FakeEngine();
    engine.status = { ...engine.status, phase: "not_installed", tier: null, comfyui: DOWN };
    engine.settings = { ...engine.settings, tier: null };
    engine.tiers = [apple64, { ...apple16, defaultMemoryLimitGb: 102 }];
    engine.plans = { "apple-64": plan("apple-64", 122, false), "apple-16": plan("apple-16", 63, true) };
    open(engine, "#/setup");
    fireEvent.click(await screen.findByRole("button", { name: /Get started/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }, { timeout: 3000 }));
    fireEvent.click(await screen.findByRole("button", { name: /Other setups/ }));
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Other setups" })).getByRole("radio", { name: /lighter/ }));
    const slider = (await screen.findByRole("slider", { name: "Memory limit" })) as HTMLInputElement;
    await waitFor(() => expect(slider.value).toBe("102"));
    fireEvent.change(slider, { target: { value: "24" } });
    fireEvent.click(await screen.findByRole("button", { name: "Download 63 GB" }));
    await screen.findByRole("heading", { name: "Downloading your setup" });

    const why = "uv pip install --python exited with 2: error: File not found: `/Users/me/Library/Application`";
    act(() => engine.setStatus({ phase: "error", tier: "apple-16", error: why }));
    await screen.findByRole("heading", { name: "The download stopped" });
    expect(screen.getByText(why)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Downloading your setup" });

    act(() => engine.setStatus({ phase: "error", tier: "apple-16", error: why }));
    await screen.findByRole("heading", { name: "The download stopped" });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "A lighter setup" })).toBeTruthy();
    expect(screen.getByText("Setup stopped")).toBeTruthy();
    expect(screen.getByText(why)).toBeTruthy();
    expect((screen.getByRole("slider", { name: "Memory limit" }) as HTMLInputElement).value).toBe("24");
    fireEvent.click(screen.getByRole("button", { name: /Other setups/ }));
    expect(within(screen.getByRole("radiogroup", { name: "Other setups" })).getByRole("radio", { name: /lighter/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(await screen.findByRole("button", { name: "Download 63 GB" }));
    await screen.findByRole("heading", { name: "Downloading your setup" });
    expect(engine.called("install").map((c) => c.args[0])).toEqual([
      { tier: "apple-16", memoryLimitGb: 24 },
      { tier: "apple-16", memoryLimitGb: 24 },
      { tier: "apple-16", memoryLimitGb: 24 },
    ]);
  });

  it("in a window opened on a failed install, try again and go back with the setup the engine was asked for", async () => {
    // A reload, or a second window: this window never saw the choice, so it goes by the tier the engine reports and
    // the setup's default limit. It has not read the hardware either, so Back starts there.
    const why = "HTTP 404 for github.com/Comfy-Org/ComfyUI/archive/refs/tags/v0.41.3.tar.gz";
    const failed = () => {
      const engine = new FakeEngine();
      engine.status = { ...engine.status, phase: "error", tier: "apple-16", comfyui: DOWN, error: why };
      engine.settings = { ...engine.settings, tier: null };
      engine.tiers = [apple64, { ...apple16, defaultMemoryLimitGb: 102 }];
      engine.plans = { "apple-64": plan("apple-64", 122, false), "apple-16": plan("apple-16", 63, true) };
      return engine;
    };

    const first = failed();
    const { unmount } = open(first, "#/setup");
    await screen.findByRole("heading", { name: "The download stopped" });
    expect(screen.getByText(why)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Downloading your setup" });
    expect(first.called("install").map((c) => c.args[0])).toEqual([{ tier: "apple-16", memoryLimitGb: 102 }]);
    unmount();

    const again = failed();
    open(again, "#/setup");
    await screen.findByRole("heading", { name: "The download stopped" });
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("heading", { name: DETECT });
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }, { timeout: 3000 }));
    expect(await screen.findByRole("heading", { name: "A lighter setup" })).toBeTruthy();
    expect(screen.getByText("Setup stopped")).toBeTruthy();
    await waitFor(() => expect((screen.getByRole("slider", { name: "Memory limit" }) as HTMLInputElement).value).toBe("102"));
    fireEvent.click(await screen.findByRole("button", { name: "Download 63 GB" }));
    await screen.findByRole("heading", { name: "Downloading your setup" });
    expect(again.called("install").map((c) => c.args[0])).toEqual([{ tier: "apple-16", memoryLimitGb: 102 }]);
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

  it("is a quiet choice on the welcome of a browser on a real engine, kept in this browser", async () => {
    const engine = new FakeEngine();
    engine.status = { ...engine.status, phase: "not_installed", tier: null, comfyui: DOWN };
    open(engine, "#/setup");
    await screen.findByRole("button", { name: /Get started/ });
    expect(screen.getByText("Setup is mostly one large download.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Look around first, with sample renders" }));
    // The page reloads into the in-browser demo; the engine is not asked for anything.
    expect(localStorage.getItem("nightshift.api")).toBe("demo");
    expect(engine.called("install")).toEqual([]);
  });

  it("in the Mac app, relaunches into the demo, which opens on the machine step with a way back", async () => {
    const setDemo = vi.fn(async () => undefined);
    const bridge = (mode: "local" | "mock") => ({ platform: "darwin", titlebarHeight: 52, getStatus: async () => ({ engineUrl: "http://127.0.0.1:9000", mode, canSwitchDemo: true }), revealProject: async () => undefined, revealExport: async () => undefined, openExternal: async () => undefined, setDemo });
    try {
      window.nightshiftDesktop = bridge("local");
      await initializeDesktop();
      const real = new FakeEngine();
      real.status = { ...real.status, phase: "not_installed", tier: null, comfyui: DOWN };
      const first = open(real, "#/setup");
      fireEvent.click(await screen.findByRole("button", { name: "Look around first, with sample renders" }));
      expect(setDemo).toHaveBeenLastCalledWith(true);
      first.unmount();

      // The app opens again in the demo: it skips the welcome it just showed.
      window.nightshiftDesktop = bridge("mock");
      await initializeDesktop();
      const demo = new FakeEngine();
      demo.status = { ...demo.status, phase: "not_installed", tier: null, comfyui: DOWN, mode: "mock" };
      open(demo, "#/setup");
      await screen.findByRole("heading", { name: DETECT });
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      await screen.findByText("Sample renders. Nothing is downloaded.");
      fireEvent.click(screen.getByRole("button", { name: "Set up for real instead" }));
      expect(setDemo).toHaveBeenLastCalledWith(false);
    } finally {
      delete window.nightshiftDesktop;
      await initializeDesktop();
    }
  });

  it("goes on with the lightest setup on a machine too small for any", async () => {
    const engine = new FakeEngine();
    engine.status = { ...engine.status, phase: "not_installed", tier: null, comfyui: DOWN, mode: "mock" };
    engine.settings = { ...engine.settings, tier: null };
    const tier = (id: string, vendor: "apple" | "nvidia", minVramGb: number, downloadGb: number): TierSummary => ({ tier: id, label: id, match: { vendor, unifiedMemory: vendor === "apple", minVramGb, minRamGb: minVramGb }, downloadGb, recommended: false });
    // The fake engine reads an M4 Max; these setups all ask for more than it has.
    engine.tiers = [tier("apple-huge", "apple", 512, 300), tier("apple-big", "apple", 256, 200), tier("nvidia-small", "nvidia", 8, 50)];
    open(engine, "#/setup");
    fireEvent.click(await screen.findByRole("button", { name: /Get started/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }, { timeout: 3000 }));
    await screen.findByRole("heading", { name: "This machine can't run Nightshift yet" });
    expect(screen.getByText(/The demo can still show you around/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue with sample renders" }));
    await waitFor(() => expect(engine.called("install").map((c) => c.args[0])).toEqual([{ tier: "apple-big", memoryLimitGb: null }]));
  });
});

describe("models already on this computer", () => {
  const lic = { name: "MIT", url: "https://example.com/l" };
  const file = (id: string, name: string, sizeGb: number) => ({ id, name, folder: "diffusion_models", filename: `${id}.safetensors`, url: "https://example.com/m", sizeGb, license: lic });
  const tier: TierSummary = { tier: "nvidia-8", label: "NVIDIA 8 GB", match: { vendor: "apple", unifiedMemory: true, minVramGb: 16, minRamGb: 16 }, downloadGb: 56, recommended: true };
  const before: InstallPlan = { tier: "nvidia-8", downloads: [file("still", "MOSS-Image, image model", 5.4), file("video", "Kandinsky 6 Lite, video model", 6.4), file("voice", "Breeze TTS 2, voice model", 4.9)], alreadyPresent: [], totalDownloadGb: 16.7, freeDiskGb: 900, fits: true };
  const found: InstallPlan = {
    ...before,
    downloads: [file("voice", "Breeze TTS 2, voice model", 4.9)],
    alreadyPresent: ["still", "video"],
    totalDownloadGb: 4.9,
    reused: [
      { id: "still", name: "MOSS-Image, image model", path: "/home/me/ComfyUI/models/diffusion_models/still.safetensors", sizeGb: 5.4, checked: false },
      { id: "video", name: "Kandinsky 6 Lite, video model", path: "/home/me/.cache/huggingface/hub/models--k--k6/snapshots/4c48/transformer/video.safetensors", sizeGb: 6.4, checked: false },
    ],
    scan: { at: new Date().toISOString(), folders: [], searched: ["/home/me/ComfyUI/models", "/home/me/.cache/huggingface/hub"], unreadable: ["/home/me/locked"] },
  };

  function setup() {
    const engine = new FakeEngine();
    engine.status = { ...engine.status, phase: "not_installed", tier: null, comfyui: DOWN };
    engine.settings = { ...engine.settings, tier: null };
    engine.tiers = [tier];
    engine.plans = { "nvidia-8": before };
    return engine;
  }
  const toCard = async () => {
    fireEvent.click(await screen.findByRole("button", { name: /Get started/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }, { timeout: 3000 }));
    await screen.findByText("Models you already have");
  };

  it("a scan says what it found in plain words, lists the files, and the download shrinks to the rest", async () => {
    const engine = setup();
    engine.scan = () => found;
    open(engine, "#/setup");
    await toCard();
    expect(await screen.findByRole("button", { name: "Download 17 GB" })).toBeTruthy();
    expect(screen.getByText(/Already use ComfyUI\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Scan for models" }));
    expect(await screen.findByText("Found 2 of 3 model files on this computer.")).toBeTruthy();
    expect(screen.getByText(/12 GB less to download/)).toBeTruthy();
    expect(screen.getByText(/checks each file against its checksum before it uses it/)).toBeTruthy();
    expect(screen.getByText("Looked in 2 folders")).toBeTruthy();
    expect(screen.getByText(/Couldn't read 1 folder, \/home\/me\/locked/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download 5 GB" })).toBeTruthy();
    expect(engine.called("scanModels").map((c) => c.args[0])).toEqual([{ tier: "nvidia-8" }]);

    fireEvent.click(screen.getByRole("button", { name: "Show the 2 files" }));
    expect(screen.getByText("Kandinsky 6 Lite, video model")).toBeTruthy();
    // A long folder keeps its first and last folders, cut between two of them; the whole path is the tooltip.
    const where = screen.getByTitle(found.reused![1]!.path);
    expect(where.textContent).toBe("/home/me/.cache/huggingface/hub/…/snapshots/4c48/transformer");
  });

  it("adds a folder the user types, says when there is no such folder, and remembers the folders added", async () => {
    const engine = setup();
    engine.scan = (body) => (body.folders?.[0] === "/nope" ? new ApiError("There is no folder at /nope", 400) : { ...found, scan: { ...found.scan!, folders: body.folders ?? [] } });
    open(engine, "#/setup");
    await toCard();
    fireEvent.click(screen.getByRole("button", { name: "Add a folder" }));
    const field = screen.getByRole("textbox", { name: "Folder with models" });
    fireEvent.change(field, { target: { value: "/nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Scan" }));
    expect(await screen.findByText("There is no folder at /nope")).toBeTruthy();
    fireEvent.change(field, { target: { value: "/mnt/big/ComfyUI" } });
    fireEvent.click(screen.getByRole("button", { name: "Scan" }));
    expect(await screen.findByText("Found 2 of 3 model files on this computer.")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Folder with models" })).toBeNull();
    expect(screen.queryByText("There is no folder at /nope")).toBeNull();
    expect(screen.getByText("Also looks in /mnt/big/ComfyUI")).toBeTruthy();
    expect(engine.called("scanModels").at(-1)!.args[0]).toEqual({ tier: "nvidia-8", folders: ["/mnt/big/ComfyUI"] });
    // Scan again searches the same folders: the engine keeps them.
    fireEvent.click(screen.getByRole("button", { name: "Scan again" }));
    await waitFor(() => expect(engine.called("scanModels").at(-1)!.args[0]).toEqual({ tier: "nvidia-8" }));
  });

  it("in the Mac app, the system's folder picker chooses the folder", async () => {
    const engine = setup();
    const pickFolder = vi.fn(async () => "/Volumes/Models/ComfyUI");
    window.nightshiftDesktop = { platform: "darwin", titlebarHeight: 52, getStatus: async () => ({ engineUrl: "" }), revealProject: async () => undefined, revealExport: async () => undefined, openExternal: async () => undefined, pickFolder };
    try {
      open(engine, "#/setup");
      await toCard();
      fireEvent.click(screen.getByRole("button", { name: "Choose a folder" }));
      await waitFor(() => expect(engine.called("scanModels").at(-1)?.args[0]).toEqual({ tier: "nvidia-8", folders: ["/Volumes/Models/ComfyUI"] }));
      expect(pickFolder).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("textbox", { name: "Folder with models" })).toBeNull();
    } finally {
      delete window.nightshiftDesktop;
    }
  });

  it("says when a file used from another folder is gone, or did not match its checksum", async () => {
    const engine = setup();
    engine.plans = {
      "nvidia-8": {
        ...found,
        downloads: [file("still", "MOSS-Image, image model", 5.4), file("voice", "Breeze TTS 2, voice model", 4.9)],
        alreadyPresent: ["video"],
        reused: [found.reused![1]!],
        reuseSkipped: [
          { id: "still", name: "MOSS-Image, image model", path: "/home/me/ComfyUI/models/diffusion_models/still.safetensors", reason: "missing" },
          { id: "voice", name: "Breeze TTS 2, voice model", path: "/home/me/ComfyUI/models/tts/voice.safetensors", reason: "mismatch" },
        ],
      },
    };
    open(engine, "#/setup");
    await toCard();
    expect(await screen.findByText("A model found in another folder is gone")).toBeTruthy();
    expect(screen.getByText(/MOSS-Image, image model is on the download list again. Scan again if you moved it./)).toBeTruthy();
    expect(screen.getByText("Breeze TTS 2, voice model: the file on this computer did not match its checksum, so it is downloaded.")).toBeTruthy();
    expect(screen.getByText("Found 1 of 3 model files on this computer.")).toBeTruthy();
  });

  it("the download line says how many files come from this computer", async () => {
    const engine = setup();
    engine.status = { ...engine.status, phase: "installing", tier: "nvidia-8", comfyui: DOWN };
    engine.plans = { "nvidia-8": found };
    open(engine, "#/setup");
    await screen.findByRole("heading", { name: "Downloading your setup" });
    act(() => engine.progress({ modelId: null, doneGb: 0, totalGb: 4.9, message: "Checking MOSS-Image, image model, already on this computer (1 of 2), 40%" }));
    expect(await screen.findByText("Checking MOSS-Image, image model, already on this computer (1 of 2), 40%")).toBeTruthy();
    expect(await screen.findByText("Using 2 model files already on this computer, 12 GB less to download.")).toBeTruthy();
  });
});
