/**
 * The browser demo (`VITE_NIGHTSHIFT_API=demo`): the in-browser engine replays real renders where it has them, starts
 * with the Nocturne ad, keeps its own state apart from the dev mock, and draws placeholders for anything new.
 */
import { projectBoards, type Project } from "@nightshift/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { placeOnTimeline, soundOff, takeOffTimeline } from "@/features/media/items";
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

/** Exports the project and waits for the film. */
function exportFilm(engine: MockEngine, pid: string) {
  engine.exportVideo(pid, { aspect: "16:9", quality: "standard" });
  drain(engine);
}

/** Where the project's newest asset loads from. */
const lastAsset = (engine: MockEngine, pid: string) => engine.assetUrl(pid, engine.getProject(pid).assets.at(-1)?.id ?? "");

/** The song or voice tracks the cut plays. */
const sound = (engine: MockEngine, pid: string, role: "music" | "voice") => [...new Set(engine.getProject(pid).timeline?.audio.filter((a) => a.role === role).map((a) => a.assetId))];

describe("the browser demo", () => {
  it("starts with the Nocturne ad, its real files served from public/demo", () => {
    const engine = new MockEngine("demo");
    const [ad] = engine.listProjects();
    expect(ad?.name).toBe("Nocturne ad");
    expect(ad?.shots).toHaveLength(5);
    expect(ad?.shots.every((s) => s.chosenFinalId)).toBe(true);
    for (const asset of ad!.assets.filter((a) => a.kind !== "latent")) expect(url(engine, ad!, asset.id)).toMatch(/^\/demo\/nocturne\/[a-z0-9-]+\.(jpg|mp4|m4a)$/);
    // Its recorded cut is kept: the five finals cut to 3 s by hand, the music and the title cards.
    expect(ad?.timeline?.clips.map((c) => c.out - c.in)).toEqual([3, 3, 3, 3, 3]);
    expect(ad?.timeline?.audio.map((a) => a.role)).toEqual(["music"]);
    expect(ad?.timeline?.overlays?.map((o) => o.kind)).toEqual(["title", "end_card"]);
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
    const ad = engine.listProjects()[0]!;
    const shot = ad.shots[0]!;
    engine.final(ad.id, shot.id, { draftId: shot.chosenDraftId!, kind: "same_take", mode: "now" });
    drain(engine);
    const p = engine.getProject(ad.id);
    const finals = p.takes.filter((t) => t.shotId === shot.id && t.rung === "final");
    expect(url(engine, p, finals.at(-1)?.videoAssetId)).toBe("/demo/nocturne/final-1.mp4");

    const second = ad.shots[1]!;
    engine.draft(ad.id, second.id);
    drain(engine);
    const drafts = engine.getProject(ad.id).takes.filter((t) => t.shotId === second.id && t.rung === "draft");
    expect(drafts.map((t) => url(engine, p, t.videoAssetId))).toEqual(["/demo/nocturne/draft-2-1.mp4", "/demo/nocturne/draft-2-2.mp4", "/demo/nocturne/draft-2-1.mp4"]);
  });

  it("exports the recorded film while the cut is as recorded, and a placeholder once the user changes it", () => {
    const engine = new MockEngine("demo");
    ready(engine);
    const ad = engine.listProjects()[0]!;
    engine.exportVideo(ad.id, { aspect: "16:9", quality: "standard" });
    drain(engine);
    const film = engine.getProject(ad.id).assets.at(-1);
    expect(url(engine, ad, film?.id)).toBe("/demo/nocturne/export.mp4");
    expect(engine.listJobs().find((j) => j.step === "export")?.message).toBe("The film this project exported on the DGX Spark, made smaller for the web.");

    // A different pick: the cut was edited by hand, so it holds, and its export is a placeholder.
    const shot = ad.shots[1]!;
    const other = ad.takes.find((t) => t.shotId === shot.id && t.rung === "draft" && t.id !== shot.chosenDraftId)!;
    engine.updateProject(ad.id, { shots: ad.shots.map((s) => (s.id === shot.id ? { ...s, chosenDraftId: other.id } : s)) });
    engine.exportVideo(ad.id, { aspect: "16:9", quality: "standard" });
    drain(engine);
    const after = engine.getProject(ad.id);
    expect(after.timeline?.clips).toEqual(ad.timeline?.clips);
    expect(url(engine, after, after.assets.at(-1)?.id)).toMatch(/^mock:/);
  });

  it("opens the Nocturne ad as one board, and a new card there leaves its recorded cut and film alone", () => {
    const engine = new MockEngine("demo");
    ready(engine);
    const ad = engine.listProjects()[0]!;
    const [board, ...others] = projectBoards(ad);
    expect(others).toEqual([]);
    expect(board?.name).toBe("Shots");
    expect(board?.items.slice(0, ad.shots.length)).toEqual(ad.shots.map((s) => s.id));
    // The uploads (the headphones and Rae) and the song are cards too. The ad has no voice.
    expect(board?.items.slice(ad.shots.length).map((item) => ad.assets.find((a) => a.id === item)?.role)).toEqual(["reference", "reference", "music"]);

    const job = engine.make(ad.id, { tool: "image", prompt: "Headphones on a stand" });
    drain(engine);
    expect(engine.getProject(ad.id).timeline?.clips.map((c) => c.shotId)).not.toContain(job.shotId);
    engine.exportVideo(ad.id, { aspect: "16:9", quality: "standard" });
    drain(engine);
    const after = engine.getProject(ad.id);
    expect(url(engine, after, after.assets.at(-1)?.id)).toBe("/demo/nocturne/export.mp4");
  });

  it("a new version of a recorded shot keeps the ad's hand-edited cut, and only the recorded picks export the recorded film", () => {
    const engine = new MockEngine("demo");
    ready(engine);
    const ad = engine.listProjects()[0]!;
    const recorded = structuredClone(ad.timeline);
    expect(recorded?.edited).toBe(true);
    const shot = ad.shots[0]!;
    engine.draft(ad.id, shot.id, { tool: { kind: "effect", effect: "freeze" } });
    drain(engine);
    // A cut edited by hand holds its clips, as the engine's does; the film is no longer the recorded one.
    expect(engine.getProject(ad.id).timeline?.clips).toEqual(recorded?.clips);
    exportFilm(engine, ad.id);
    expect(lastAsset(engine, ad.id)).toMatch(/^mock:/);

    const p = engine.getProject(ad.id);
    engine.updateProject(ad.id, { shots: p.shots.map((s) => (s.id === shot.id ? { ...s, chosenDraftId: shot.chosenDraftId, chosenFinalId: shot.chosenFinalId, useStill: false } : s)) });
    exportFilm(engine, ad.id);
    expect(lastAsset(engine, ad.id)).toBe("/demo/nocturne/export.mp4");

    // A card sent to the timeline and taken off again leaves the clips as they were recorded too.
    const made = engine.make(ad.id, { tool: "image", prompt: "Headphones on a stand" }).shotId!;
    drain(engine);
    engine.updateProject(ad.id, placeOnTimeline(engine.getProject(ad.id), [made]));
    expect(engine.getProject(ad.id).timeline?.clips.map((c) => c.shotId)).toContain(made);
    engine.updateProject(ad.id, takeOffTimeline(engine.getProject(ad.id), made));
    expect(engine.getProject(ad.id).timeline?.clips).toEqual(recorded?.clips);
    exportFilm(engine, ad.id);
    expect(lastAsset(engine, ad.id)).toBe("/demo/nocturne/export.mp4");

    // And it stays so after the page reloads.
    vi.advanceTimersByTime(500);
    expect(new MockEngine("demo").getProject(ad.id).timeline?.clips).toEqual(recorded?.clips);
  });

  it("an uploaded song or voiceover is the one the ad's cut and film use, until the recorded sound is back", () => {
    const engine = new MockEngine("demo");
    ready(engine);
    const ad = engine.listProjects()[0]!;
    const recordedSong = ad.timeline!.audio.find((a) => a.role === "music")!.assetId;
    const song = engine.uploadAsset(ad.id, "data:audio/wav;base64,AAAA", "audio", { role: "music", durationSec: 20 });
    expect(sound(engine, ad.id, "music")).toEqual([song.id]);
    exportFilm(engine, ad.id);
    expect(lastAsset(engine, ad.id)).toMatch(/^mock:/);

    engine.updateProject(ad.id, placeOnTimeline(engine.getProject(ad.id), [recordedSong]));
    expect(sound(engine, ad.id, "music")).toEqual([recordedSong]);
    exportFilm(engine, ad.id);
    expect(lastAsset(engine, ad.id)).toBe("/demo/nocturne/export.mp4");

    // A voiceover the ad never had joins the cut; taking it off again gives back the recorded film.
    const voice = engine.uploadAsset(ad.id, "data:audio/wav;base64,AAAA", "audio", { role: "voice", durationSec: 6 });
    expect(sound(engine, ad.id, "voice")).toEqual([voice.id]);
    expect(sound(engine, ad.id, "music")).toEqual([recordedSong]);
    exportFilm(engine, ad.id);
    expect(lastAsset(engine, ad.id)).toMatch(/^mock:/);
    engine.updateProject(ad.id, soundOff(engine.getProject(ad.id), "voice"));
    expect(sound(engine, ad.id, "voice")).toEqual([]);
    exportFilm(engine, ad.id);
    expect(lastAsset(engine, ad.id)).toBe("/demo/nocturne/export.mp4");
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
    expect(localStorage.getItem("nightshift.demo.state.v2")).toContain("Demo only");
    const dev = new MockEngine("dev");
    expect(dev.listProjects().map((p) => p.name)).toEqual([]);
    expect(new MockEngine("demo").listProjects().map((p) => p.name)).toContain("Demo only");
  });
});
