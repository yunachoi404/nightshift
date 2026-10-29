/**
 * Picking takes as the UI does it: a pick tells the engine which draft, never which final, and the Takes rail and the
 * Finals page show the final the engine answers with. Picking Take 2 and then Take 1 again brings Take 1's final back.
 */
import { finalFor, type Asset, type Event, type Project, type Shot } from "@nightshift/contract";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NightshiftClient, ProjectPatch } from "@/api/client";
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

const iso = () => new Date().toISOString();
const PID = "prj_ferry";

/** One shot with two drafts. Take 1 is picked and has a same-take final. */
function ferry(): Project {
  const video = (id: string): Asset => ({ id, kind: "video", path: `takes/${id}.mp4`, durationSec: 4, createdAt: iso() });
  return {
    id: PID,
    name: "Ferry",
    template: "cinematic_shot",
    aspect: "16:9",
    brief: {},
    shots: [{ id: "shot_1", index: 0, prompt: "A ferry leaves the pier at dusk", durationSec: 4, stillAssetId: "ast_still", chosenDraftId: "take_1", chosenFinalId: "final_1", locked: false }],
    takes: [
      { id: "take_1", shotId: "shot_1", rung: "draft", seed: 1, videoAssetId: "ast_take_1", jobId: "job_1" },
      { id: "take_2", shotId: "shot_1", rung: "draft", seed: 2, videoAssetId: "ast_take_2", jobId: "job_2" },
      { id: "final_1", shotId: "shot_1", rung: "final", finalKind: "same_take", parentTakeId: "take_1", seed: 1, videoAssetId: "ast_final_1", jobId: "job_3" },
    ],
    assets: [{ id: "ast_still", kind: "image", path: "stills/ast_still.png", createdAt: iso() }, video("ast_take_1"), video("ast_take_2"), video("ast_final_1")],
    timeline: null,
    createdAt: iso(),
    updatedAt: iso(),
  };
}

/** A set-up engine with that project. Its PATCH works like the real one; every patch is recorded. */
class FakeEngine {
  project = ferry();
  patches: ProjectPatch[] = [];

  client(): NightshiftClient {
    const answer = <T,>(fn: () => T): Promise<T> => Promise.resolve().then(() => structuredClone(fn()));
    const known: Partial<NightshiftClient> = {
      kind: "http",
      status: () => answer(() => ({ phase: "ready" as const, tier: "apple-64" as const, comfyui: { running: true, url: "http://127.0.0.1:8188", version: "0.3" }, memoryUsedGb: null, mode: "local" as const })),
      settings: () => answer(() => ({ tier: "apple-64" as const, memoryLimitGb: null, overnight: { enabled: false, startAt: "23:00", endAt: "07:00" }, remote: null })),
      onboarding: () => answer(() => ({ done: true, sampleProjectId: null })),
      tiers: () => answer(() => []),
      listProjects: () => answer(() => [this.project]),
      listJobs: () => answer(() => []),
      getProject: () => answer(() => this.project),
      updateProject: (_id, patch) => answer(() => this.update(patch)),
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

  /** The engine's shot merge: a link left out keeps its value, and a new pick gets that draft's final. */
  private update(patch: ProjectPatch): Project {
    this.patches.push(structuredClone(patch));
    const shots = patch.shots?.map((incoming): Shot => {
      const now = this.project.shots.find((s) => s.id === incoming.id)!;
      const { chosenFinalId: named, ...shot } = { ...incoming, chosenDraftId: incoming.chosenDraftId ?? now.chosenDraftId };
      const finalId = shot.chosenDraftId !== now.chosenDraftId ? finalFor(this.project.takes, shot.chosenDraftId, named)?.id : (named ?? now.chosenFinalId);
      return finalId ? { ...shot, chosenFinalId: finalId } : shot;
    });
    if (shots) this.project = { ...this.project, shots };
    return this.project;
  }
}

function open(engine: FakeEngine, hash: string) {
  window.location.hash = hash;
  return render(
    <EngineProvider client={engine.client()}>
      <App />
    </EngineProvider>,
  );
}

const go = (hash: string) => act(() => void (window.location.hash = hash));
const finalsPicture = () => document.querySelector(".fn-row__thumb video")?.getAttribute("src");

describe("picking takes", () => {
  it("picking Take 2 and then Take 1 again shows Take 1's final again, and a pick never names a final", async () => {
    const engine = new FakeEngine();
    open(engine, `#/p/${PID}/takes?shot=shot_1`);
    const rail = await screen.findByRole("navigation", { name: "Shots" });
    await within(rail).findByText("Final ready");

    fireEvent.click(screen.getByRole("button", { name: "Take 2" }));
    await within(rail).findByText("Take 2 picked");
    go(`#/p/${PID}/finals`);
    await screen.findByRole("heading", { name: "Finals" });
    expect(screen.getByText("Take 2 picked")).toBeTruthy();
    expect(screen.queryByText("Final, same take")).toBeNull();
    expect(screen.queryByRole("button", { name: "Share reveal" })).toBeNull();
    expect(finalsPicture()).toBe(`/api/projects/${PID}/assets/ast_take_2`);

    go(`#/p/${PID}/takes?shot=shot_1`);
    fireEvent.click(await screen.findByRole("button", { name: "Take 1" }));
    await within(await screen.findByRole("navigation", { name: "Shots" })).findByText("Final ready");
    go(`#/p/${PID}/finals`);
    await screen.findByRole("heading", { name: "Finals" });
    expect(screen.getByText("Final, same take")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Share reveal" })).toBeTruthy();
    expect(finalsPicture()).toBe(`/api/projects/${PID}/assets/ast_final_1`);

    // Each pick says which draft, and leaves the final to the engine.
    expect(engine.patches.map((p) => p.shots?.map((s) => [s.chosenDraftId, "chosenFinalId" in s]))).toEqual([[["take_2", false]], [["take_1", false]]]);
    expect(engine.project.takes.map((t) => t.id)).toEqual(["take_1", "take_2", "final_1"]);
  });
});
