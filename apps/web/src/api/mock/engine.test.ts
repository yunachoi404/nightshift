/**
 * The in-browser mock engine (dev mode, `?api=mock`) picks finals like the real engine: a new pick gets that draft's
 * final or none, a final that finishes after its draft lost the pick does not take over, and picking that draft again
 * brings its final back. A new draft is the pick when it lands. See media.test.ts for boards, the tools and versions.
 */
import { MAIN_BOARD_ID, projectBoards, type Asset, type FinalKind, type Project, type Shot } from "@nightshift/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockEngine } from "./engine";

const iso = () => new Date().toISOString();
const PID = "prj_ferry";

function ferry(): Project {
  const video = (id: string): Asset => ({ id, kind: "video", path: `assets/${id}.mp4`, durationSec: 4, createdAt: iso() });
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
    assets: [{ id: "ast_still", kind: "image", path: "assets/ast_still.png", createdAt: iso() }, video("ast_take_1"), video("ast_take_2"), video("ast_final_1")],
    timeline: null,
    createdAt: iso(),
    updatedAt: iso(),
  };
}

let engine: MockEngine;

beforeEach(() => {
  vi.useFakeTimers();
  engine = new MockEngine();
  engine.state.runtime = { ...engine.state.runtime, phase: "ready" };
  // The real DGX Spark recipe: it has both finals, same take and remaster.
  engine.state.settings = { ...engine.state.settings, tier: "unified-128-cuda" };
  engine.state.projects = [ferry()];
});
afterEach(() => vi.useRealTimers());

/** Picks a draft as the Takes page does; "stale" still names the shot's current final. */
function pick(draftId: string, copy: "stale" | "lean" = "lean") {
  const shots = engine.getProject(PID).shots.map(({ chosenFinalId, ...s }): Shot => ({ ...s, ...(copy === "stale" && chosenFinalId ? { chosenFinalId } : {}), chosenDraftId: draftId }));
  return shown(engine.updateProject(PID, { shots }));
}

function finish(draftId: string, kind: FinalKind) {
  const job = engine.final(PID, "shot_1", { draftId, kind, mode: "now" });
  vi.advanceTimersByTime(150);
  engine.finishRunningNow();
  return engine.getProject(PID).takes.find((t) => t.jobId === job.id)!.id;
}

const shown = (p: Project = engine.getProject(PID)) => [p.shots[0]!.chosenDraftId, p.shots[0]!.chosenFinalId];

describe("mock engine picks", () => {
  it("picking Take 2 and then Take 1 again brings Take 1's final back", () => {
    for (const copy of ["stale", "lean"] as const) {
      expect(pick("take_2", copy)).toEqual(["take_2", undefined]);
      expect(pick("take_1", copy)).toEqual(["take_1", "final_1"]);
    }
    // A pick that leaves the final out keeps it while the draft stays the same.
    expect(pick("take_1", "lean")).toEqual(["take_1", "final_1"]);
  });

  it("a final that finishes after its draft lost the pick waits for that draft, then shows as its newest", () => {
    pick("take_2");
    const later = finish("take_1", "remaster");
    expect(shown()).toEqual(["take_2", undefined]);
    expect(pick("take_1")).toEqual(["take_1", later]);
    expect(engine.getProject(PID).takes.filter((t) => t.rung === "final").map((t) => t.id)).toEqual(["final_1", later]);
  });
});

describe("mock engine: a project made before boards", () => {
  it("opens as one board of its shot, and a new draft takes the pick from the final until Take 1 is picked again", () => {
    const p = engine.getProject(PID);
    expect(projectBoards(p)).toEqual([{ id: MAIN_BOARD_ID, name: "Shots", items: ["shot_1"] }]);
    engine.updateProject(PID, { name: "Ferry at dusk" });
    expect(engine.getProject(PID).timeline?.clips.map((c) => c.assetId)).toEqual(["ast_final_1"]);

    const job = engine.draft(PID, "shot_1");
    vi.advanceTimersByTime(150);
    engine.finishRunningNow();
    const made = engine.getProject(PID).takes.find((t) => t.jobId === job.id)!;
    expect(shown()).toEqual([made.id, undefined]);
    expect(engine.getProject(PID).timeline?.clips.map((c) => c.assetId)).toEqual([made.videoAssetId]);
    expect(pick("take_1")).toEqual(["take_1", "final_1"]);
    expect(engine.getProject(PID).timeline?.clips.map((c) => c.assetId)).toEqual(["ast_final_1"]);
  });
});

describe("mock engine: another app on the GPU", () => {
  it("the dev control puts otherGpuUse on the status and the event stream, and takes it off again", () => {
    engine.state.runtime = { ...engine.state.runtime, comfyui: { running: true, url: "mock://comfyui", version: "mock" } };
    const seen: unknown[] = [];
    engine.subscribe((e) => e.type === "runtime" && seen.push(e.status.otherGpuUse));
    expect(engine.status().otherGpuUse).toBeUndefined();
    engine.setDev({ faults: { ...engine.dev.faults, gpuShared: true } });
    expect(engine.status().otherGpuUse).toEqual({ usedGb: 3.5, apps: ["python"] });
    engine.setDev({ faults: { ...engine.dev.faults, gpuShared: false } });
    expect(engine.status().otherGpuUse).toBeUndefined();
    expect(seen).toEqual([{ usedGb: 3.5, apps: ["python"] }, undefined]);
  });

  it("never on a GPU computer on the network, like the engine", () => {
    engine.state.runtime = { ...engine.state.runtime, comfyui: { running: true, url: "http://127.0.0.1:8190", version: "0.41.3" } };
    engine.state.settings = { ...engine.state.settings, remote: { url: "http://spark:8190", name: "NVIDIA GB10" } };
    engine.setDev({ faults: { ...engine.dev.faults, gpuShared: true } });
    expect(engine.status().otherGpuUse).toBeUndefined();
  });
});

describe("mock engine: finals for the night", () => {
  it("are grouped by the model they load and run one group after the other, as the engine runs them", () => {
    const queue = (draftId: string, kind: FinalKind) => engine.final(PID, "shot_1", { draftId, kind, mode: "overnight" });
    const same1 = queue("take_1", "same_take");
    const remaster = queue("take_1", "remaster");
    const same2 = queue("take_2", "same_take");
    expect([same1, remaster, same2].map((j) => [j.model, j.nightGroup])).toEqual([
      ["LTX-2.5", same1.nightGroup],
      ["MiniMax H3", remaster.nightGroup],
      ["LTX-2.5", same1.nightGroup],
    ]);
    expect(remaster.nightGroup).toBeGreaterThan(same1.nightGroup!);
    engine.setDev({ simulateNight: true });
    const ran: string[] = [];
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(150);
      const running = engine.listJobs().find((j) => j.status === "running")!;
      ran.push(running.id);
      // An LTX final queued once its group has started waits for the next turn, after the remaster.
      if (i === 0) expect(queue("take_2", "same_take").nightGroup).toBeGreaterThan(remaster.nightGroup!);
      engine.finishRunningNow();
    }
    expect(ran).toEqual([same1.id, same2.id, remaster.id]);
  });
});
