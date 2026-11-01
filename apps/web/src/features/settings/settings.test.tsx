/**
 * Settings as the dogfood night met it. The night window's times could not be typed: every keystroke saved and
 * re-rendered the field, so typing 3, 2, 5 gave 05:12. They save once now, when the field is left, and say so. The page
 * no longer says everything stays on this machine while renders run on another, or promises a nerd mode.
 */
import type { Event, Settings, TierSummary } from "@nightshift/contract";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NightshiftClient } from "@/api/client";
import { App } from "@/app/App";
import { EngineProvider } from "@/store/engine";
import { TimeField } from "./Settings";

vi.mock("@/api/config", () => ({
  API_KEY: "nightshift.api",
  buildApiBase: () => "",
  isMock: () => false,
  isDevMock: () => false,
  isBrowserDemo: () => false,
  getClient: () => {
    throw new Error("the test gives the app its own client");
  },
}));

const TIER = {
  tier: "unified-128-cuda",
  label: "Spark",
  match: { vendor: "nvidia", minRamGb: 128, minVramGb: 0, unifiedMemory: true },
  downloadGb: 90,
  recommended: true,
  steps: ["still", "video_draft", "video_final_same_take", "video_final_remaster", "voice", "music", "text", "effect_end_frame"],
  models: { still: "Krea 2 Turbo", video_draft: "LTX-2.5", video_final_same_take: "LTX-2.5", video_final_remaster: "MiniMax H3", music: "YuE2-3B", text: "Qwen3-VL 4B", effect_end_frame: "FLUX.2 Klein 4B" },
  referenceStillModel: "FLUX.2 Klein 4B",
  estimates: {},
} as unknown as TierSummary;

class Engine {
  patches: Array<Partial<Settings>> = [];
  settings: Settings;
  constructor(remote = false) {
    this.settings = {
      tier: "unified-128-cuda",
      memoryLimitGb: null,
      overnight: { enabled: true, startAt: "05:12", endAt: "07:00" },
      remote: remote ? { url: "http://spark:8190", name: "spark", tier: "unified-128-cuda" } : null,
    } as Settings;
  }
  client(remote = false): NightshiftClient {
    const answer = <T,>(fn: () => T): Promise<T> => Promise.resolve().then(() => structuredClone(fn()));
    const known: Partial<NightshiftClient> = {
      kind: "http",
      status: () => answer(() => ({ phase: "ready" as const, tier: "unified-128-cuda" as const, comfyui: { running: true, url: "http://spark:8190", version: "0.41.3" }, memoryUsedGb: null, mode: remote ? ("remote" as const) : ("local" as const) })),
      settings: () => answer(() => this.settings),
      updateSettings: (patch) =>
        answer(() => {
          this.patches.push(structuredClone(patch));
          return (this.settings = { ...this.settings, ...patch });
        }),
      hardware: () => answer(() => ({ os: "linux" as const, arch: "arm64", cpu: "Grace", ramGb: 128, gpus: [{ vendor: "nvidia" as const, name: "NVIDIA GB10", vramGb: 128, unifiedMemory: true }], freeDiskGb: 900, source: "detected" as const })),
      onboarding: () => answer(() => ({ done: true, sampleProjectId: null })),
      tiers: () => answer(() => [TIER]),
      listProjects: () => answer(() => []),
      listJobs: () => answer(() => []),
      events: (_onEvent: (e: Event) => void, onConnection) => {
        queueMicrotask(() => onConnection?.(true));
        return () => undefined;
      },
    };
    return new Proxy(known as NightshiftClient, {
      get: (target, key) => (typeof key !== "string" || key in target || key === "then" ? Reflect.get(target, key) : () => new Promise(() => undefined)),
    });
  }
}

function openSettings(engine: Engine, remote = false) {
  window.location.hash = "#/settings";
  render(
    <EngineProvider client={engine.client(remote)}>
      <App />
    </EngineProvider>,
  );
}

describe("a night window time", () => {
  it("keeps what is typed, and saves once, when the field is left", async () => {
    const saves: string[] = [];
    const save = vi.fn(async (v: string) => {
      saves.push(v);
    });
    render(<TimeField label="Overnight start" value="05:12" onSave={save} />);
    const field = screen.getByLabelText("Overnight start") as HTMLInputElement;
    // The browser fills the hour, then the minutes, a value at each step. None of them saves or is undone.
    fireEvent.focus(field);
    for (const v of ["03:12", "03:02", "03:25"]) {
      fireEvent.change(field, { target: { value: v } });
      expect(field.value).toBe(v);
    }
    expect(save).not.toHaveBeenCalled();
    await act(async () => fireEvent.blur(field));
    expect(saves).toEqual(["03:25"]);
  });

  it("saves on Enter, and a time typed only in part goes back to the saved one", async () => {
    const save = vi.fn(async () => undefined);
    render(<TimeField label="Overnight end" value="07:00" onSave={save} />);
    const field = screen.getByLabelText("Overnight end") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "09:00" } });
    await act(async () => fireEvent.keyDown(field, { key: "Enter" }));
    expect(save).toHaveBeenCalledWith("09:00");
    save.mockClear();
    fireEvent.change(field, { target: { value: "" } });
    await act(async () => fireEvent.blur(field));
    expect(save).not.toHaveBeenCalled();
    expect(field.value).toBe("07:00");
  });
});

describe("the settings page", () => {
  it("saves the night window when the field is left, and says it saved", async () => {
    const engine = new Engine();
    openSettings(engine);
    const start = (await screen.findByLabelText("Overnight start")) as HTMLInputElement;
    fireEvent.change(start, { target: { value: "03:12" } });
    fireEvent.change(start, { target: { value: "03:25" } });
    expect(engine.patches).toEqual([]);
    await act(async () => fireEvent.blur(start));
    await waitFor(() => expect(engine.patches).toEqual([{ overnight: { enabled: true, startAt: "03:25", endAt: "07:00" } }]));
    const toast = (await screen.findByText("Night shift saved")).closest(".toast") as HTMLElement;
    expect(toast.textContent).toContain("Finals for tonight run from 3:25 am to 7 am");
    expect(start.value).toBe("03:25");
  });

  it("names the models this setup runs, and promises nothing", async () => {
    openSettings(new Engine());
    await screen.findByText("Under the hood");
    expect(screen.queryByText(/nerd mode/i)).toBeNull();
    expect(screen.getByText("Images from references").closest(".group__row")?.textContent).toContain("FLUX.2 Klein 4B");
    expect(screen.getByText("Remasters").closest(".group__row")?.textContent).toContain("MiniMax H3");
    expect(screen.getByText("Everything here stays on this machine")).toBeTruthy();
  });

  it("on a GPU computer, says the renders run there", async () => {
    openSettings(new Engine(true), true);
    expect(await screen.findByText("Your projects and settings stay on this machine. Renders run on spark.")).toBeTruthy();
    expect(screen.queryByText("Everything here stays on this machine")).toBeNull();
  });
});
