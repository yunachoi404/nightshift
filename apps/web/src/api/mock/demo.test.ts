/**
 * The browser demo (`VITE_NIGHTSHIFT_API=demo`): the in-browser engine replays real renders where it has them, starts
 * with The Croissant ad, keeps its own state apart from the dev mock, and draws placeholders for anything new.
 */
import type { Project } from "@nightshift/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockEngine } from "./engine";
import { firstShot } from "./samples";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Runs the queue until it is empty, as the engine's tick would. */
function drain(engine: MockEngine) {
  for (let i = 0; i < 40; i++) {
    vi.advanceTimersByTime(150);
    if (!engine.state.jobs.some((j) => j.status === "queued" || j.status === "running")) return;
    engine.finishRunningNow();
  }
}

function ready(engine: MockEngine, tier = "unified-128-cuda") {
  engine.state.runtime = { ...engine.state.runtime, phase: "ready", tier };
  engine.state.settings = { ...engine.state.settings, tier };
}

const url = (engine: MockEngine, p: Project, assetId: string | undefined) => engine.assetUrl(p.id, assetId ?? "");

describe("the browser demo", () => {
  it("starts with The Croissant ad, its real files served from public/demo", () => {
    const engine = new MockEngine("demo");
    const [croissant] = engine.listProjects();
    expect(croissant?.name).toBe("The Croissant ad");
    expect(croissant?.shots).toHaveLength(5);
    expect(croissant?.shots.every((s) => s.chosenFinalId)).toBe(true);
    for (const asset of croissant!.assets.filter((a) => a.kind !== "latent")) expect(url(engine, croissant!, asset.id)).toMatch(/^\/demo\/croissant\/[a-z0-9-]+\.(jpg|mp4|m4a)$/);
    // Its recorded cut is kept: the voice in pieces, the trims and the title cards.
    expect(croissant?.timeline?.audio.filter((a) => a.role === "voice")).toHaveLength(6);
    expect(croissant?.timeline?.overlays?.map((o) => o.kind)).toEqual(["title", "end_card"]);
    expect(engine.onboarding().done).toBe(false);
  });

  it("makes the First shot from the real lighthouse still and draft", () => {
    const engine = new MockEngine("demo");
    ready(engine);
    const { project } = engine.startSample(false);
    drain(engine);
    const p = engine.getProject(project!.id);
    const shot = p.shots[0]!;
    expect(shot.prompt).toBe(firstShot.prompt);
    expect(url(engine, p, shot.stillAssetId)).toBe("/demo/first-shot/still.jpg");
    const draft = p.takes.find((t) => t.id === shot.chosenDraftId);
    expect(url(engine, p, draft?.videoAssetId)).toBe("/demo/first-shot/draft.mp4");
  });

  it("finishes a recorded take as its real final, and a new take of it is its other real take", () => {
    const engine = new MockEngine("demo");
    ready(engine);
    const croissant = engine.listProjects()[0]!;
    const shot = croissant.shots[0]!;
    engine.final(croissant.id, shot.id, { draftId: shot.chosenDraftId!, kind: "same_take", mode: "now" });
    drain(engine);
    const p = engine.getProject(croissant.id);
    const finals = p.takes.filter((t) => t.shotId === shot.id && t.rung === "final");
    expect(url(engine, p, finals.at(-1)?.videoAssetId)).toBe("/demo/croissant/final-1.mp4");

    const second = croissant.shots[1]!;
    engine.draft(croissant.id, second.id);
    drain(engine);
    const drafts = engine.getProject(croissant.id).takes.filter((t) => t.shotId === second.id && t.rung === "draft");
    expect(drafts.map((t) => url(engine, p, t.videoAssetId))).toEqual(["/demo/croissant/draft-2-1.mp4", "/demo/croissant/draft-2-2.mp4", "/demo/croissant/draft-2-1.mp4"]);
  });

  it("exports the recorded film while the cut is as recorded, and a placeholder once the user changes it", () => {
    const engine = new MockEngine("demo");
    ready(engine);
    const croissant = engine.listProjects()[0]!;
    engine.exportVideo(croissant.id, { aspect: "16:9", quality: "standard" });
    drain(engine);
    const film = engine.getProject(croissant.id).assets.at(-1);
    expect(url(engine, croissant, film?.id)).toBe("/demo/croissant/export.mp4");
    expect(engine.listJobs().find((j) => j.step === "export")?.message).toMatch(/exported on the DGX Spark/);

    // A different pick: the cut is laid out again, and its export is a placeholder.
    const shot = croissant.shots[1]!;
    const other = croissant.takes.find((t) => t.shotId === shot.id && t.rung === "draft" && t.id !== shot.chosenDraftId)!;
    engine.updateProject(croissant.id, { shots: croissant.shots.map((s) => (s.id === shot.id ? { ...s, chosenDraftId: other.id } : s)) });
    engine.exportVideo(croissant.id, { aspect: "16:9", quality: "standard" });
    drain(engine);
    const after = engine.getProject(croissant.id);
    expect(after.timeline?.audio.filter((a) => a.role === "voice")).toHaveLength(6);
    expect(url(engine, after, after.assets.at(-1)?.id)).toMatch(/^mock:/);
  });

  it("draws placeholders for a prompt it has no render of", () => {
    const engine = new MockEngine("demo");
    ready(engine);
    const p = engine.createProject({ name: "Mine", template: "cinematic_shot", aspect: "16:9", brief: { idea: "A cat on a skateboard" } });
    engine.storyboard(p.id);
    drain(engine);
    const made = engine.getProject(p.id);
    expect(made.shots.length).toBeGreaterThan(0);
    for (const shot of made.shots) expect(url(engine, made, shot.stillAssetId)).toMatch(/^mock:/);
  });

  it("keeps its state apart from the dev mock", () => {
    const demo = new MockEngine("demo");
    demo.createProject({ name: "Demo only", template: "cinematic_shot", aspect: "16:9", brief: {} });
    vi.advanceTimersByTime(500);
    expect(localStorage.getItem("nightshift.demo.state.v1")).toContain("Demo only");
    const dev = new MockEngine("dev");
    expect(dev.listProjects().map((p) => p.name)).toEqual([]);
    expect(new MockEngine("demo").listProjects().map((p) => p.name)).toContain("Demo only");
  });
});
