/**
 * The mock engine's media, as the real engine keeps it: new projects start from their preset on one board, the tools
 * make new cards that wait on a board out of the cut, in their own shape when asked, an edit redraws a card from an
 * image, every new version becomes its card's pick, and the soundtrack picks the song and the voice the cut uses.
 */
import { MAIN_BOARD_ID, projectBoards, type Asset, type Project, type Shot } from "@nightshift/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { placeOnTimeline, restore, shotHistory, soundOff, takeOffTimeline } from "@/features/media/items";
import { parseMockUrl } from "@/media/placeholder";
import { mockTier } from "./data";
import { MockEngine, MockHttpError } from "./engine";

let engine: MockEngine;

function ready(tier = "unified-128-cuda") {
  engine.state.runtime = { ...engine.state.runtime, phase: "ready", tier };
  engine.state.settings = { ...engine.state.settings, tier };
}

beforeEach(() => {
  vi.useFakeTimers();
  engine = new MockEngine();
  ready();
});
afterEach(() => vi.useRealTimers());

/** Runs the queue until it is empty, as the engine's tick would. */
function drain() {
  for (let i = 0; i < 40; i++) {
    vi.advanceTimersByTime(150);
    if (!engine.state.jobs.some((j) => j.status === "queued" || j.status === "running")) return;
    engine.finishRunningNow();
  }
}

/** The status and message of a call that should fail. */
function failure(call: () => unknown): [number, string] | undefined {
  try {
    call();
  } catch (e) {
    if (e instanceof MockHttpError) return [e.status, e.message];
    throw e;
  }
  return undefined;
}

const project = (pid: string) => engine.getProject(pid);
const shotOf = (pid: string, shotId: string | undefined) => project(pid).shots.find((s) => s.id === shotId)!;
const cutShots = (pid: string) => project(pid).timeline?.clips.map((c) => c.shotId) ?? [];
const clipAsset = (pid: string, shotId: string) => project(pid).timeline?.clips.find((c) => c.shotId === shotId)?.assetId;

function blank(name = "Mine"): Project {
  return engine.createProject({ name, template: "blank", aspect: "16:9", brief: {} });
}

/** An uploaded photo on the project's canvas. */
function upload(pid: string, boardId?: string): Asset {
  return engine.uploadAsset(pid, "data:image/png;base64,AAAA", "image", { role: "reference" }, boardId);
}

describe("new projects", () => {
  it("a film starts with its preset's shot list on one board, and nothing is queued", () => {
    const p = engine.createProject({ name: "Rain", template: "cinematic_shot", aspect: "16:9", brief: { idea: "A red motorcycle in the rain", sequence: "three" } });
    expect(p.shots).toHaveLength(3);
    expect(p.shots.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(p.shots.every((s) => s.prompt && s.onTimeline === undefined && !s.stillAssetId)).toBe(true);
    expect(p.boards).toEqual([{ id: MAIN_BOARD_ID, name: "Shots", items: p.shots.map((s) => s.id) }]);
    expect(engine.listJobs()).toEqual([]);
  });

  it("no shot is longer than one draft of this setup makes", () => {
    ready("nvidia-8");
    const p = engine.createProject({ name: "Rain", template: "cinematic_shot", aspect: "16:9", brief: { idea: "Rain", sequence: "three" } });
    expect(p.shots.map((s) => s.durationSec)).toEqual([2.04, 2.04, 2.04]);
  });

  it("a blank project and a What if? film start empty on one board", () => {
    expect(blank().shots).toEqual([]);
    expect(blank().boards).toEqual([{ id: MAIN_BOARD_ID, name: "Board 1", items: [] }]);
    const film = engine.createProject({ name: "What if", template: "what_if", aspect: "9:16", brief: { idea: "What if cats ran the post office?" } });
    expect(film.shots).toEqual([]);
    expect(film.boards).toEqual([{ id: MAIN_BOARD_ID, name: "Film", items: [] }]);
    expect(engine.listJobs()).toEqual([]);
  });

  it("a blank project has no shot list to write", () => {
    expect(failure(() => engine.storyboard(blank().id))).toEqual([409, "A blank project has no shot list to write. Make shots with the tools."]);
  });
});

describe("the tools make new cards", () => {
  it("image: a still for a new shot that waits on the board, out of the cut", () => {
    const p = blank();
    const job = engine.make(p.id, { tool: "image", prompt: "A lighthouse at dawn" });
    expect(job.step).toBe("still");
    const shot = shotOf(p.id, job.shotId);
    expect(shot).toMatchObject({ prompt: "A lighthouse at dawn", onTimeline: false, durationSec: 4 });
    expect(projectBoards(project(p.id))[0]!.items).toEqual([shot.id]);
    drain();
    const done = shotOf(p.id, shot.id);
    expect(done.stillAssetId).toBeTruthy();
    expect(done.stillHistory).toEqual([{ assetId: done.stillAssetId, prompt: "A lighthouse at dawn", createdAt: expect.any(String) }]);
    expect(cutShots(p.id)).toEqual([]);
  });

  it("video from a prompt: a still first, then its draft when it lands", () => {
    const p = blank();
    const job = engine.make(p.id, { tool: "video", prompt: "Waves on the rocks", durationSec: 9, seed: 7 });
    expect(job.step).toBe("still");
    expect(shotOf(p.id, job.shotId)).toMatchObject({ cameraMove: "static", durationSec: 4.04 });
    drain();
    const shot = shotOf(p.id, job.shotId);
    const take = project(p.id).takes.find((t) => t.id === shot.chosenDraftId);
    expect(take).toMatchObject({ rung: "draft", seed: 7, imageAssetId: shot.stillAssetId });
    expect(engine.listJobs().map((j) => j.step)).toEqual(["still", "video_draft"]);
  });

  it("video from an image: a draft of a new shot whose still is the image", () => {
    const p = blank();
    const photo = upload(p.id);
    const job = engine.make(p.id, { tool: "video", imageAssetId: photo.id, move: "dolly_in" });
    expect(job.step).toBe("video_draft");
    expect(shotOf(p.id, job.shotId)).toMatchObject({ stillAssetId: photo.id, cameraMove: "dolly_in", prompt: "" });
  });

  it("effect and camera move: a draft with that tool, its clip painted like the quick shots'", () => {
    const p = blank();
    const photo = upload(p.id);
    const effect = engine.make(p.id, { tool: "effect", imageAssetId: photo.id, effect: "freeze", prompt: "The lake" });
    const move = engine.make(p.id, { tool: "camera_move", imageAssetId: photo.id, move: "crane_up" });
    expect([effect.step, move.step]).toEqual(["video_effect", "video_camera_move"]);
    expect(shotOf(p.id, move.shotId).cameraMove).toBe("crane_up");
    drain();
    const takes = project(p.id).takes;
    const effectTake = takes.find((t) => t.shotId === effect.shotId)!;
    const moveTake = takes.find((t) => t.shotId === move.shotId)!;
    expect(effectTake.tool).toEqual({ kind: "effect", effect: "freeze" });
    expect(moveTake.tool).toEqual({ kind: "camera_move", move: "crane_up" });
    expect(shotOf(p.id, effect.shotId).chosenDraftId).toBe(effectTake.id);
    const path = (t: typeof effectTake) => engine.assetUrl(p.id, t.videoAssetId!);
    expect(path(moveTake)).toMatch(/^mock:.*:draft:\d+:crane_up$/);
    expect(path(effectTake)).toMatch(/^mock:.*:draft:\d+:static$/);
  });

  it("files the new card at the end of the board it was made on, else the first", () => {
    const p = blank();
    engine.updateProject(p.id, { boards: [...projectBoards(p), { id: "board_b", name: "Ideas", items: [] }] });
    const onB = engine.make(p.id, { tool: "image", prompt: "One", boardId: "board_b" });
    const onFirst = engine.make(p.id, { tool: "image", prompt: "Two", boardId: "board_gone" });
    expect(project(p.id).boards?.map((b) => b.items)).toEqual([[onFirst.shotId], [onB.shotId]]);
  });

  it("says what is missing, as the engine does", () => {
    const p = blank();
    const photo = upload(p.id);
    expect(failure(() => engine.make(p.id, { tool: "image" }))).toEqual([400, "Write a prompt for the image."]);
    expect(failure(() => engine.make(p.id, { tool: "video" }))).toEqual([400, "Write a prompt, or start from an image."]);
    expect(failure(() => engine.make(p.id, { tool: "effect", effect: "freeze" }))).toEqual([400, "Choose an image for the effect."]);
    expect(failure(() => engine.make(p.id, { tool: "effect", imageAssetId: photo.id, effect: "melt_into_jelly" }))).toEqual([400, "Choose an effect from the gallery."]);
    expect(failure(() => engine.make(p.id, { tool: "camera_move", imageAssetId: photo.id }))).toEqual([400, "Choose a camera move from the gallery."]);
    expect(failure(() => engine.make(p.id, { tool: "video", imageAssetId: "ast_nope" }))?.[0]).toBe(404);
    expect(failure(() => engine.make(p.id, { tool: "image", prompt: "x", referenceIds: ["ref_nope"] }))?.[0]).toBe(400);
    ready("nvidia-8");
    expect(failure(() => engine.make(p.id, { tool: "effect", imageAssetId: photo.id, effect: "freeze" }))).toEqual([409, "The NVIDIA 8-16 GB with 16 GB+ RAM, measured on an RTX 2080 SUPER recipe has no video effect step."]);
    engine.state.runtime = { ...engine.state.runtime, phase: "installing" };
    expect(failure(() => engine.make(p.id, { tool: "image", prompt: "x" }))?.[0]).toBe(409);
    // Nothing failed halfway: no card was left behind.
    expect(project(p.id).shots).toEqual([]);
  });

  it("refuses the tools on a What if? film and on a quick shot, with the engine's words", () => {
    const expectRefused = (template: Project["template"], message: string) => {
      const p = engine.createProject({ name: "One film", template, aspect: "16:9", brief: { idea: "What if?" } });
      const photo = upload(p.id);
      expect(failure(() => engine.make(p.id, { tool: "image", prompt: "x" }))).toEqual([409, message]);
      expect(failure(() => engine.make(p.id, { tool: "video", imageAssetId: photo.id }))).toEqual([409, message]);
      expect(failure(() => engine.make(p.id, { tool: "effect", imageAssetId: photo.id, effect: "freeze" }))).toEqual([409, message]);
      expect(failure(() => engine.make(p.id, { tool: "camera_move", imageAssetId: photo.id, move: "crane_up" }))).toEqual([409, message]);
      expect(project(p.id).shots).toEqual(p.shots);
    };
    expectRefused("what_if", "A What if? film is one continuous shot. Start a new project to make more.");
    expectRefused("camera_move", "This project makes one shot from its photo. Start a new project to use the tools.");
    expectRefused("vfx_effect", "This project makes one shot from its photo. Start a new project to use the tools.");
    expect(engine.listJobs()).toEqual([]);
  });
});

describe("a card's own shape", () => {
  const picture = (pid: string, assetId: string | undefined) => parseMockUrl(engine.assetUrl(pid, assetId!));

  it("a card made in another shape keeps it, and its still, drafts and finals are drawn in it", () => {
    const p = blank();
    const tall = engine.make(p.id, { tool: "image", prompt: "A lighthouse at dawn", aspect: "9:16" }).shotId!;
    const wide = engine.make(p.id, { tool: "image", prompt: "A lighthouse at dusk" }).shotId!;
    expect(shotOf(p.id, tall).aspect).toBe("9:16");
    expect(shotOf(p.id, wide).aspect).toBeUndefined();
    drain();
    const still = project(p.id).assets.find((a) => a.id === shotOf(p.id, tall).stillAssetId)!;
    expect([still.width, still.height]).toEqual([576, 1024]);
    expect(picture(p.id, still.id)).toMatchObject({ w: 576, h: 1024 });
    expect(picture(p.id, shotOf(p.id, wide).stillAssetId)).toMatchObject({ w: 1024, h: 576 });

    engine.draft(p.id, tall);
    drain();
    const draft = project(p.id).takes.find((t) => t.id === shotOf(p.id, tall).chosenDraftId)!;
    expect(picture(p.id, draft.videoAssetId)).toMatchObject({ w: 288, h: 512, quality: "draft" });
    engine.final(p.id, tall, { draftId: draft.id, kind: "same_take", mode: "now" });
    drain();
    const final = project(p.id).takes.find((t) => t.id === shotOf(p.id, tall).chosenFinalId)!;
    expect(picture(p.id, final.videoAssetId)).toMatchObject({ w: 576, h: 1024, quality: "final" });
  });

  it("a video from an image takes the shape it was made in", () => {
    const p = blank();
    const job = engine.make(p.id, { tool: "video", imageAssetId: upload(p.id).id, aspect: "1:1" });
    drain();
    const take = project(p.id).takes.find((t) => t.shotId === job.shotId)!;
    expect(picture(p.id, take.videoAssetId)).toMatchObject({ w: 384, h: 384 });
  });
});

describe("image edits", () => {
  const picture = (pid: string, assetId: string | undefined) => parseMockUrl(engine.assetUrl(pid, assetId!));

  /** A card with a drawn still, on a blank project. */
  function drawn(prompt = "A lighthouse on a cliff over the sea") {
    const p = blank();
    const shotId = engine.make(p.id, { tool: "image", prompt }).shotId!;
    drain();
    return { pid: p.id, shotId, stillId: shotOf(p.id, shotId).stillAssetId! };
  }

  it("the edit tool makes a new card whose still is the image changed as the prompt says", () => {
    const { pid, shotId, stillId } = drawn();
    const job = engine.make(pid, { tool: "edit", imageAssetId: stillId, prompt: "  Make it night  " });
    expect(job.step).toBe("still");
    const card = shotOf(pid, job.shotId);
    // The image stays where it was: the new card has no still until the edit lands.
    expect(card).toMatchObject({ prompt: "Make it night", onTimeline: false });
    expect(card.stillAssetId).toBeUndefined();
    expect(projectBoards(project(pid))[0]!.items).toEqual([shotId, card.id]);

    // It runs the recipe's edit step, for as long as that step takes.
    vi.advanceTimersByTime(3000);
    expect(engine.listJobs().find((j) => j.id === job.id)).toMatchObject({ status: "running", message: "Editing the image" });
    drain();
    const done = shotOf(pid, card.id);
    expect(engine.listJobs().find((j) => j.id === job.id)).toMatchObject({ status: "done", message: "Edit ready", outputAssetIds: [done.stillAssetId] });
    expect(done.stillHistory).toEqual([{ assetId: done.stillAssetId, prompt: "Make it night", createdAt: expect.any(String) }]);
    expect(done.useStill).toBe(true);
    // The same scene in the light the instruction asks for, at the card's size.
    const before = picture(pid, stillId)!;
    expect(picture(pid, done.stillAssetId)).toEqual({ ...before, palette: 2 });
    expect(shotOf(pid, shotId).stillAssetId).toBe(stillId);
  });

  it("an edit that names no light still shows a change, and a photo's edit is drawn in the card's shape", () => {
    const { pid, stillId } = drawn();
    const job = engine.make(pid, { tool: "edit", imageAssetId: stillId, prompt: "Remove the boat" });
    const photo = engine.make(pid, { tool: "edit", imageAssetId: upload(pid).id, prompt: "Make it night", aspect: "9:16" });
    drain();
    const before = picture(pid, stillId)!;
    const after = picture(pid, shotOf(pid, job.shotId).stillAssetId)!;
    expect({ ...after, palette: before.palette }).toEqual(before);
    expect(after.palette).not.toBe(before.palette);
    expect(picture(pid, shotOf(pid, photo.shotId).stillAssetId)).toMatchObject({ w: 576, h: 1024, palette: 2, quality: "still" });
  });

  it("a card's still can be redrawn as an edit of an image, and its next draft moves the edit", () => {
    const { pid, shotId, stillId } = drawn();
    const job = engine.still(pid, shotId, { editFrom: stillId, prompt: "Golden hour light" });
    expect(job.step).toBe("still");
    drain();
    const shot = shotOf(pid, shotId);
    expect(shot.stillAssetId).not.toBe(stillId);
    expect(shot.stillHistory?.map((h) => [h.assetId, h.prompt])).toEqual([[stillId, "A lighthouse on a cliff over the sea"], [shot.stillAssetId, "Golden hour light"]]);
    expect(shot.prompt).toBe("A lighthouse on a cliff over the sea");
    expect(picture(pid, shot.stillAssetId)?.palette).toBe(1);

    engine.draft(pid, shotId);
    drain();
    const take = project(pid).takes.find((t) => t.id === shotOf(pid, shotId).chosenDraftId)!;
    expect(take.imageAssetId).toBe(shot.stillAssetId);
    expect(picture(pid, take.videoAssetId)).toMatchObject({ kind: picture(pid, stillId)!.kind, palette: 1 });
  });

  it("refuses an edit as the engine does, and leaves nothing behind", () => {
    const { pid, shotId, stillId } = drawn();
    const cards = project(pid).shots;
    const song = engine.uploadAsset(pid, "data:audio/wav;base64,AAAA", "audio", { role: "music" });
    expect(failure(() => engine.make(pid, { tool: "edit", prompt: "Make it night" }))).toEqual([400, "Choose an image from this project first."]);
    expect(failure(() => engine.make(pid, { tool: "edit", imageAssetId: stillId }))).toEqual([400, "Say how to change the image."]);
    expect(failure(() => engine.make(pid, { tool: "edit", imageAssetId: stillId, prompt: "   " }))).toEqual([400, "Say how to change the image."]);
    expect(failure(() => engine.still(pid, shotId, { editFrom: stillId }))).toEqual([400, "Say how to change the image."]);
    expect(failure(() => engine.still(pid, shotId, { editFrom: "ast_nope", prompt: "Make it night" }))).toEqual([404, "That image is not in this project."]);
    expect(failure(() => engine.still(pid, shotId, { editFrom: song.id, prompt: "Make it night" }))).toEqual([409, "Only an image can be edited. Choose a still or a photo."]);
    expect(failure(() => engine.still(pid, "sht_nope", { editFrom: stillId, prompt: "Make it night" }))).toEqual([404, "Shot not found"]);

    // Only a recipe with an image edit step (effect_end_frame) can edit.
    ready("nvidia-8");
    const label = mockTier("nvidia-8")!.label;
    expect(failure(() => engine.make(pid, { tool: "edit", imageAssetId: stillId, prompt: "Make it night" }))).toEqual([409, `The ${label} recipe cannot edit images.`]);
    expect(failure(() => engine.still(pid, shotId, { editFrom: stillId, prompt: "Make it night" }))).toEqual([409, `The ${label} recipe cannot edit images.`]);
    expect(project(pid).shots).toEqual(cards);
    expect(engine.listJobs().filter((j) => j.status === "queued")).toEqual([]);
  });

  it("refuses an edit on a What if? film and on a quick shot, with the engine's words", () => {
    for (const [template, message] of [
      ["what_if", "A What if? film is one continuous shot. Start a new project to make more."],
      ["camera_move", "This project makes one shot from its photo. Start a new project to use the tools."],
      ["vfx_effect", "This project makes one shot from its photo. Start a new project to use the tools."],
    ] as const) {
      const p = engine.createProject({ name: "One film", template, aspect: "16:9", brief: { idea: "What if?" } });
      const photo = upload(p.id);
      const shot: Shot = { id: "sht_one", index: 0, prompt: "One shot", durationSec: 4, locked: false, stillAssetId: photo.id };
      engine.updateProject(p.id, { shots: [shot] });
      expect(failure(() => engine.make(p.id, { tool: "edit", imageAssetId: photo.id, prompt: "Make it night" }))).toEqual([409, message]);
      expect(failure(() => engine.still(p.id, shot.id, { editFrom: photo.id, prompt: "Make it night" }))).toEqual([409, message]);
    }
    expect(engine.listJobs()).toEqual([]);
  });
});

describe("versions", () => {
  /** A shot on the timeline with a still and a draft. */
  function filmed() {
    const p = engine.createProject({ name: "Pier", template: "cinematic_shot", aspect: "16:9", brief: { idea: "A ferry leaves the pier" } });
    const shotId = p.shots[0]!.id;
    engine.still(p.id, shotId);
    drain();
    engine.draft(p.id, shotId);
    drain();
    return { pid: p.id, shotId };
  }

  it("a draft with a tool is an effect or a camera move on the shot's still", () => {
    const { pid, shotId } = filmed();
    const job = engine.draft(pid, shotId, { tool: { kind: "camera_move", move: "crane_up" } });
    expect(job.step).toBe("video_camera_move");
    expect(engine.draft(pid, shotId, { tool: { kind: "effect", effect: "freeze" } }).step).toBe("video_effect");
    expect(failure(() => engine.draft(pid, shotId, { tool: { kind: "effect", effect: "nope" } }))?.[0]).toBe(400);
    drain();
    const tools = project(pid).takes.filter((t) => t.shotId === shotId).map((t) => t.tool?.kind ?? "plain");
    expect(tools).toEqual(["plain", "camera_move", "effect"]);
  });

  it("every new version becomes the pick, and the cut shows it", () => {
    const { pid, shotId } = filmed();
    const first = shotOf(pid, shotId);
    expect(first.useStill).toBeUndefined();
    expect(clipAsset(pid, shotId)).toBe(project(pid).takes.find((t) => t.id === first.chosenDraftId)?.videoAssetId);

    // A new still: the history keeps the first one, and the cut shows the new still.
    engine.still(pid, shotId, { prompt: "The ferry at night" });
    drain();
    const redrawn = shotOf(pid, shotId);
    expect(redrawn.useStill).toBe(true);
    expect(redrawn.stillHistory?.map((h) => h.assetId)).toEqual([first.stillAssetId, redrawn.stillAssetId]);
    expect(redrawn.stillHistory?.[1]?.prompt).toBe("The ferry at night");
    expect(clipAsset(pid, shotId)).toBe(redrawn.stillAssetId);

    // A final of the picked draft follows it.
    engine.draft(pid, shotId);
    drain();
    const again = shotOf(pid, shotId);
    expect(again.useStill).toBeUndefined();
    expect(again.chosenDraftId).not.toBe(first.chosenDraftId);
    engine.final(pid, shotId, { draftId: again.chosenDraftId!, kind: "same_take", mode: "now" });
    drain();
    const finished = shotOf(pid, shotId);
    const final = project(pid).takes.find((t) => t.id === finished.chosenFinalId)!;
    expect(final.parentTakeId).toBe(again.chosenDraftId);
    expect(clipAsset(pid, shotId)).toBe(final.videoAssetId);
  });

  it("restoring an earlier still, draft or final is a PATCH, and the cut follows", () => {
    const { pid, shotId } = filmed();
    engine.final(pid, shotId, { draftId: shotOf(pid, shotId).chosenDraftId!, kind: "same_take", mode: "now" });
    drain();
    engine.still(pid, shotId);
    drain();
    engine.draft(pid, shotId, { tool: { kind: "effect", effect: "freeze" } });
    drain();
    const versions = () => shotHistory(project(pid), shotOf(pid, shotId));
    const pickBy = (rung: string, n = 0) => {
      const version = versions().filter((v) => v.rung === rung)[n]!;
      const shots = project(pid).shots.map((s): Shot => (s.id === shotId ? restore(s, version) : s));
      engine.updateProject(pid, { shots });
      return version;
    };
    const pickedNow = () => versions().find((v) => v.pick)!;
    expect(pickedNow().tool).toEqual({ kind: "effect", effect: "freeze" });

    const still = pickBy("still", 0);
    expect(pickedNow().key).toBe(still.key);
    expect(clipAsset(pid, shotId)).toBe(still.asset.id);

    const final = pickBy("final");
    expect(pickedNow().key).toBe(final.key);
    expect(shotOf(pid, shotId).useStill).toBe(false);
    expect(clipAsset(pid, shotId)).toBe(final.asset.id);

    const draft = pickBy("draft", 1);
    expect(pickedNow().key).toBe(draft.key);
    expect(shotOf(pid, shotId).chosenFinalId).toBeUndefined();
    expect(clipAsset(pid, shotId)).toBe(draft.asset.id);
  });

  it("a PATCH that leaves out what jobs set keeps it, and picking another draft shows that draft", () => {
    const { pid, shotId } = filmed();
    engine.still(pid, shotId);
    drain();
    const before = shotOf(pid, shotId);
    const lean = ({ stillHistory: _h, useStill: _u, onTimeline: _o, ...s }: Shot): Shot => s;
    engine.updateProject(pid, { shots: project(pid).shots.map((s) => (s.id === shotId ? { ...lean(s), prompt: "Edited" } : s)) });
    expect(shotOf(pid, shotId)).toMatchObject({ prompt: "Edited", useStill: true, stillHistory: before.stillHistory });

    const draftId = before.chosenDraftId!;
    engine.draft(pid, shotId);
    drain();
    engine.still(pid, shotId);
    drain();
    expect(shotOf(pid, shotId).useStill).toBe(true);
    engine.updateProject(pid, { shots: project(pid).shots.map((s) => (s.id === shotId ? { ...lean(s), chosenDraftId: draftId } : s)) });
    expect(shotOf(pid, shotId).useStill).toBeUndefined();
    expect(clipAsset(pid, shotId)).toBe(project(pid).takes.find((t) => t.id === draftId)?.videoAssetId);
  });
});

describe("the timeline", () => {
  it("a card from the tools is out of the cut until it is sent to the timeline, and back out when taken off", () => {
    const p = engine.createProject({ name: "Pier", template: "cinematic_shot", aspect: "16:9", brief: { idea: "A ferry" } });
    const filmShot = p.shots[0]!.id;
    engine.still(p.id, filmShot);
    const made = engine.make(p.id, { tool: "image", prompt: "Gulls over the water" }).shotId!;
    drain();
    expect(cutShots(p.id)).toEqual([filmShot]);

    engine.updateProject(p.id, placeOnTimeline(project(p.id), [made], 0));
    expect(cutShots(p.id)).toEqual([made, filmShot]);
    expect(shotOf(p.id, made).onTimeline).toBe(true);

    engine.updateProject(p.id, takeOffTimeline(project(p.id), made));
    expect(cutShots(p.id)).toEqual([filmShot]);
    expect(projectBoards(project(p.id))[0]!.items).toContain(made);
  });

  it("an export cuts only the timeline's shots", () => {
    const p = blank();
    const made = engine.make(p.id, { tool: "image", prompt: "Gulls" }).shotId!;
    drain();
    engine.exportVideo(p.id, { aspect: "16:9", quality: "standard" });
    drain();
    expect(project(p.id).timeline?.clips).toEqual([]);
    engine.updateProject(p.id, placeOnTimeline(project(p.id), [made]));
    expect(cutShots(p.id)).toEqual([made]);
  });

  it("a rewritten shot list keeps the cards waiting on a board, and draws stills only for the timeline", () => {
    const p = engine.createProject({ name: "Pier", template: "cinematic_shot", aspect: "16:9", brief: { idea: "A ferry", sequence: "three" } });
    const made = engine.make(p.id, { tool: "video", prompt: "Gulls" }).shotId!;
    engine.cancelJob(engine.listJobs()[0]!.id);
    engine.storyboard(p.id);
    drain();
    const after = project(p.id);
    expect(after.shots).toHaveLength(4);
    expect(after.shots.at(-1)).toMatchObject({ id: made, onTimeline: false, index: 3 });
    expect(shotOf(p.id, made).stillAssetId).toBeUndefined();
    expect(after.shots.filter((s) => s.onTimeline !== false).every((s) => s.stillAssetId)).toBe(true);
    // The rewritten shots took the old ones' places on the board.
    expect(after.boards?.[0]?.items).toEqual([...after.shots.slice(0, 3).map((s) => s.id), made]);
  });

  it("a rewritten shot list keeps the timeline's cards made with the tools, and their takes, before and past the new list", () => {
    const p = engine.createProject({ name: "Kettle", template: "product_ad", aspect: "16:9", brief: { productName: "The Kettle" } });
    const photo = upload(p.id);
    const effect = engine.make(p.id, { tool: "effect", imageAssetId: photo.id, effect: "freeze" }).shotId!;
    const move = engine.make(p.id, { tool: "camera_move", imageAssetId: photo.id, move: "crane_up" }).shotId!;
    drain();
    engine.updateProject(p.id, placeOnTimeline(project(p.id), [effect], 0));
    engine.updateProject(p.id, placeOnTimeline(project(p.id), [move]));
    const toolTakes = project(p.id).takes.filter((t) => t.tool).map((t) => t.id);
    expect(toolTakes).toHaveLength(2);
    const planned = p.shots.map((s) => s.id);

    engine.storyboard(p.id);
    drain();
    const cut = cutShots(p.id);
    expect(cut).toHaveLength(planned.length + 2);
    expect([cut[0], cut.at(-1)]).toEqual([effect, move]);
    expect(cut.filter((id) => planned.includes(id))).toEqual([]);
    expect(project(p.id).takes.filter((t) => toolTakes.includes(t.id))).toHaveLength(2);
    expect(shotOf(p.id, effect).chosenDraftId).toBe(toolTakes[0]);
    expect(projectBoards(project(p.id)).flatMap((b) => b.items)).toEqual(expect.arrayContaining([effect, move]));
  });

  it("a rewritten shot list keeps a shot with no prompt and a leftover shot with a still, and drops a leftover with neither", () => {
    const p = engine.createProject({ name: "Hi", template: "talking_intro", aspect: "16:9", brief: { script: "One. Two. Three. Four." } });
    const [a, b, c, d] = p.shots.map((s) => s.id);
    expect(d).toBeDefined();
    engine.updateProject(p.id, { shots: p.shots.map((s) => (s.id === b ? { ...s, prompt: "" } : s)) });
    engine.still(p.id, c!);
    drain();
    engine.updateProject(p.id, { brief: { script: "Only one." } });

    engine.storyboard(p.id);
    drain();
    const cut = cutShots(p.id);
    expect(cut).toHaveLength(3);
    expect(cut[0]).not.toBe(a);
    expect(cut.slice(1)).toEqual([b, c]);
    expect(project(p.id).shots.some((s) => s.id === d)).toBe(false);
  });

  it("on a hand-edited cut, a shot sent to the timeline comes in at its place and one taken off goes", () => {
    const p = engine.createProject({ name: "Pier", template: "cinematic_shot", aspect: "16:9", brief: { idea: "A ferry", sequence: "three" } });
    for (const s of p.shots) engine.still(p.id, s.id);
    const made = engine.make(p.id, { tool: "image", prompt: "Gulls" }).shotId!;
    drain();
    const tl = project(p.id).timeline!;
    engine.updateProject(p.id, { timeline: { ...tl, edited: true, clips: tl.clips.map((c, i) => (i === 0 ? { ...c, out: 2 } : c)) } });
    expect(project(p.id).timeline?.edited).toBe(true);
    const [a, b, c] = p.shots.map((s) => s.id);

    engine.updateProject(p.id, placeOnTimeline(project(p.id), [made], 1));
    const clips = project(p.id).timeline!.clips;
    expect(clips.map((x) => x.shotId)).toEqual([a, made, b, c]);
    // The first clip was trimmed to 2 s, so the next shot came in at 4 s, where the second clip was.
    expect(clips.map((x) => x.start)).toEqual([0, 4, 8, 12]);

    engine.updateProject(p.id, takeOffTimeline(project(p.id), b!));
    expect(project(p.id).timeline!.clips.map((x) => [x.shotId, x.start])).toEqual([[a, 0], [made, 4], [c, 8]]);
  });
});

describe("songs and voiceovers", () => {
  function cutSound(pid: string, role: "music" | "voice") {
    return project(pid).timeline?.audio.filter((a) => a.role === role).map((a) => a.assetId) ?? [];
  }

  it("a new song is a card on the board it was made for, and the one the cut uses", () => {
    const p = blank();
    engine.updateProject(p.id, { boards: [...projectBoards(p), { id: "board_sound", name: "Sound", items: [] }] });
    engine.audio(p.id, { role: "music", prompt: "Warm synths", boardId: "board_sound" });
    drain();
    const song = project(p.id).assets.find((a) => a.kind === "audio")!;
    expect(song.role).toBe("music");
    expect(project(p.id).boards?.find((b) => b.id === "board_sound")?.items).toEqual([song.id]);
    expect(cutSound(p.id, "music")).toEqual([song.id]);
  });

  it("none takes the song off the cut; a new one clears that and plays", () => {
    const p = blank();
    engine.audio(p.id, { role: "music", prompt: "Warm synths" });
    drain();
    engine.updateProject(p.id, soundOff(project(p.id), "music"));
    expect(project(p.id).soundtrack).toEqual({ music: null });
    expect(cutSound(p.id, "music")).toEqual([]);

    vi.advanceTimersByTime(5);
    engine.audio(p.id, { role: "music", prompt: "Cold strings" });
    drain();
    const newest = project(p.id).assets.filter((a) => a.kind === "audio").at(-1)!;
    expect(project(p.id).soundtrack).toBeUndefined();
    expect(cutSound(p.id, "music")).toEqual([newest.id]);

    // Picking the older song puts it back.
    const older = project(p.id).assets.find((a) => a.kind === "audio")!;
    engine.updateProject(p.id, placeOnTimeline(project(p.id), [older.id]));
    expect(cutSound(p.id, "music")).toEqual([older.id]);
  });

  it("taking the voice off the cut takes its captions too, and putting it back brings them back", () => {
    const p = blank();
    engine.audio(p.id, { role: "voice", text: "The gulls came back. Nobody knew why.", voice: "mara" });
    drain();
    const captions = project(p.id).timeline?.captions;
    expect(captions?.map((c) => c.text)).toEqual(["The gulls came back.", "Nobody knew why."]);

    engine.updateProject(p.id, soundOff(project(p.id), "voice"));
    expect(cutSound(p.id, "voice")).toEqual([]);
    expect(project(p.id).timeline?.captions).toEqual([]);

    const voice = project(p.id).assets.find((a) => a.role === "voice")!;
    engine.updateProject(p.id, placeOnTimeline(project(p.id), [voice.id]));
    expect(cutSound(p.id, "voice")).toEqual([voice.id]);
    expect(project(p.id).timeline?.captions).toEqual(captions);
  });

  it("with no voice, a product ad's captions are its script's, timed by estimate, and a film's are none", () => {
    const ad = engine.createProject({ name: "Kettle", template: "product_ad", aspect: "16:9", brief: { productName: "The Kettle", script: "Boils in a minute. Pours without a drip." } });
    const film = engine.createProject({ name: "Pier", template: "cinematic_shot", aspect: "16:9", brief: { idea: "A ferry" } });
    for (const p of [ad, film]) engine.still(p.id, p.shots[0]!.id);
    drain();
    expect(project(ad.id).timeline?.captions.map((c) => c.text)).toEqual(["Boils in a minute.", "Pours without a drip."]);
    expect(project(film.id).timeline?.captions).toEqual([]);
  });

  it("on a hand-edited cut, taking the voice off takes its captions too", () => {
    const p = engine.createProject({ name: "Pier", template: "cinematic_shot", aspect: "16:9", brief: { idea: "A ferry" } });
    engine.still(p.id, p.shots[0]!.id);
    engine.audio(p.id, { role: "voice", text: "The ferry leaves at dawn.", voice: "mara" });
    drain();
    const tl = project(p.id).timeline!;
    expect(tl.captions).toHaveLength(1);
    engine.updateProject(p.id, { timeline: { ...tl, edited: true, clips: tl.clips.map((c) => ({ ...c, out: 2 })) } });
    expect(project(p.id).timeline?.edited).toBe(true);

    engine.updateProject(p.id, soundOff(project(p.id), "voice"));
    expect(cutSound(p.id, "voice")).toEqual([]);
    expect(project(p.id).timeline?.captions).toEqual([]);
    expect(project(p.id).timeline?.clips.map((c) => c.out)).toEqual([2]);
  });

  it("an uploaded song is filed on its board and plays", () => {
    const p = blank();
    engine.updateProject(p.id, { soundtrack: { music: null } });
    const song = engine.uploadAsset(p.id, "data:audio/wav;base64,AAAA", "audio", { role: "music" }, MAIN_BOARD_ID);
    expect(project(p.id).boards?.[0]?.items).toEqual([song.id]);
    expect(project(p.id).soundtrack).toBeUndefined();
    expect(cutSound(p.id, "music")).toEqual([song.id]);
  });
});
