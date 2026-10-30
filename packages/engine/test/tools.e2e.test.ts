/**
 * The project tools through the engine API (mock GPU), the way the Media page drives them: a new project only creates,
 * each tool makes a new card on a board, every new version of a card becomes its pick, and the cut uses only the cards
 * sent to the timeline. Every step request is recorded, so the tests see what each workflow would get.
 */
import { fallbackShots, JobSchema, MAIN_BOARD_ID, ProjectSchema, type Asset, type Board, type Job, type Project, type Shot } from "@nightshift/contract";
import { checkTools } from "@nightshift/editor";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { startEngine, type EngineHandle } from "../src/engine.js";
import { findFfmpeg, probeMedia } from "../src/media/ffmpeg.js";
import { placeholderScene } from "../src/media/png.js";
import { placeholderMusic } from "../src/media/wav.js";
import { defaultRecipesDir } from "../src/paths.js";
import { MockStepRunner } from "../src/runner/mock.js";
import type { StepRequest, StepRunner } from "../src/runner/types.js";
import { Api, BRIEFS } from "./flow.js";

const hasFfmpeg = !!(await findFfmpeg());
const canRender = hasFfmpeg && !!checkTools().chrome;
const dataDir = mkdtempSync(join(tmpdir(), "ns-tools-"));
const calls: StepRequest[] = [];
const mock = new MockStepRunner(0);
const runner: StepRunner = { run: (req, ctx) => (calls.push(structuredClone(req)), mock.run(req, ctx)) };

let engine: EngineHandle;
let api: Api;

beforeAll(async () => {
  engine = await startEngine({ port: 0, dataDir, mock: true, mockSpeed: 0, recipesDir: defaultRecipesDir(), runner, log: () => undefined });
  api = new Api(engine.url);
  await api.install("unified-128-cuda");
  // The mock install and the engine's start take longer than the default hook time on a busy machine.
}, 60_000);
afterAll(() => engine?.stop());

const create = (template: Project["template"], brief: Record<string, unknown> = {}, name = "Tools") =>
  api.call("POST", "/api/projects", ProjectSchema, { name, template, aspect: "16:9", brief });
const jobs = (pid: string) => api.call("GET", `/api/jobs?projectId=${pid}`, z.array(JobSchema));
const patch = (pid: string, body: unknown) => api.call("PATCH", `/api/projects/${pid}`, ProjectSchema, body);
const shotOf = (p: Project, id: string) => p.shots.find((s) => s.id === id)!;
const takesOf = (p: Project, shotId: string) => p.takes.filter((t) => t.shotId === shotId);
const photo = (pid: string, board?: string) => api.upload(pid, placeholderScene(640, 384, "harbor").toPng(), "harbor.png", "image/png", "reference", board);
/** Make a card with a tool and wait for everything it queued. */
async function make(pid: string, body: Record<string, unknown>): Promise<{ job: Job; project: Project; shot: Shot }> {
  const job = await api.job(`/api/projects/${pid}/make`, body);
  await api.settle(pid);
  const done = (await jobs(pid)).find((j) => j.id === job.id)!;
  expect(done.status, done.error).toBe("done");
  const project = await api.project(pid);
  return { job, project, shot: shotOf(project, job.shotId!) };
}
/** Send shots to the timeline, the way the Editor's drop does. */
const sendToTimeline = (p: Project, ...ids: string[]) => patch(p.id, { shots: p.shots.map((s) => (ids.includes(s.id) ? { ...s, onTimeline: true } : s)) });
/** The step requests a job sent, in order. */
const requestsOf = (job: Pick<Job, "id">) => calls.filter((c) => c.jobId === job.id);
/** The one request of a step a job sent. */
const requestOf = (job: Pick<Job, "id">, step: StepRequest["step"]) => {
  const found = requestsOf(job).filter((c) => c.step === step);
  expect(found, `${step} requests of ${job.id}`).toHaveLength(1);
  return found[0]!;
};
/** What a request was sized at: the workflow's width and height, and the shape the runner was told. */
const sized = (c: StepRequest) => ({ size: [c.values.width, c.values.height], aspect: c.hints.aspect, hinted: [c.hints.width, c.hints.height] });

describe("new projects only create", () => {
  it("a product ad starts with its shot list on a Shots board, and queues nothing", async () => {
    const { brief } = BRIEFS.product_ad;
    const p = await create("product_ad", brief);
    expect(p.shots.map((s) => s.prompt)).toEqual(fallbackShots("product_ad", brief).map((s) => s.prompt));
    expect(p.shots.length).toBeGreaterThan(1);
    expect(p.shots.every((s) => s.onTimeline === undefined && !s.stillAssetId)).toBe(true);
    expect(p.boards).toEqual([{ id: MAIN_BOARD_ID, name: "Shots", items: p.shots.map((s) => s.id) }]);
    expect(await jobs(p.id)).toEqual([]);
  });

  it("a blank project starts empty on one board, and has no shot list to write", async () => {
    const p = await create("blank");
    expect(p.shots).toEqual([]);
    expect(p.boards).toEqual([{ id: MAIN_BOARD_ID, name: "Board 1", items: [] }]);
    expect(await api.refused("POST", `/api/projects/${p.id}/storyboard`)).toEqual({ status: 409, error: "A blank project has no shot list to write. Make something with the tools." });
    expect(await jobs(p.id)).toEqual([]);
  });

  it("What if? and quick-shot projects keep their own flow: the tools refuse them in plain words", async () => {
    const whatIf = await create("what_if", BRIEFS.what_if.brief);
    expect(whatIf.shots).toEqual([]);
    expect(whatIf.boards).toEqual([{ id: MAIN_BOARD_ID, name: "Film", items: [] }]);
    expect((await api.refused("POST", `/api/projects/${whatIf.id}/make`, { tool: "image", prompt: "a moon" })).status).toBe(409);
    const quick = await create("vfx_effect", BRIEFS.vfx_effect.brief);
    expect((await api.refused("POST", `/api/projects/${quick.id}/make`, { tool: "image", prompt: "a moon" })).status).toBe(409);
  });
});

describe.skipIf(!hasFfmpeg)("the tools make cards", { timeout: 120_000 }, () => {
  it("an effect on an uploaded image is a new card on its board, picked, and out of the cut until it is sent there", async () => {
    let p = await create("blank");
    const boards: Board[] = [...p.boards!, { id: "board_mood", name: "Mood", items: [] }];
    p = await patch(p.id, { boards });
    const image = await photo(p.id, "board_mood");
    expect((await api.project(p.id)).boards!.find((b) => b.id === "board_mood")!.items).toEqual([image.id]);

    // Refused in plain words, before anything is stored.
    expect(await api.refused("POST", `/api/projects/${p.id}/make`, { tool: "effect", effect: "freeze" })).toEqual({ status: 400, error: "Choose an image from this project first." });
    expect(await api.refused("POST", `/api/projects/${p.id}/make`, { tool: "effect", effect: "sparkles", imageAssetId: image.id })).toEqual({ status: 400, error: "Choose an effect from the gallery." });
    expect(await api.refused("POST", `/api/projects/${p.id}/make`, { tool: "effect", effect: "freeze", imageAssetId: "asset_nope" })).toEqual({ status: 400, error: "Choose an image from this project first." });
    expect(await api.refused("POST", `/api/projects/${p.id}/make`, { tool: "camera_move", move: "barrel_roll", imageAssetId: image.id })).toEqual({ status: 400, error: "Unknown camera move: barrel_roll" });
    expect(await api.refused("POST", `/api/projects/${p.id}/make`, { tool: "image", prompt: "a kite", referenceIds: ["ref_nope"] })).toMatchObject({ status: 400 });
    expect((await api.project(p.id)).shots).toEqual([]);

    const { job, project, shot } = await make(p.id, { tool: "effect", effect: "freeze", imageAssetId: image.id, prompt: "a harbor crane", boardId: "board_mood" });
    expect(job.step).toBe("video_effect");
    expect(shot).toMatchObject({ onTimeline: false, stillAssetId: image.id, prompt: "a harbor crane", durationSec: 4 });
    const [take] = takesOf(project, shot.id);
    expect(take).toMatchObject({ rung: "draft", tool: { kind: "effect", effect: "freeze" }, imageAssetId: image.id });
    expect(take!.prompt).toContain("frost");
    expect(shot.chosenDraftId).toBe(take!.id);
    expect(project.boards!.find((b) => b.id === "board_mood")!.items).toEqual([image.id, shot.id]);
    expect(project.timeline?.clips ?? []).toEqual([]);

    // Sent to the timeline: one clip, the effect.
    const cut = await sendToTimeline(project, shot.id);
    expect(cut.timeline!.clips.map((c) => [c.shotId, c.assetId])).toEqual([[shot.id, take!.videoAssetId]]);

    // Finished as the same take: the final keeps the tool, and the shot shows it.
    await api.run(`/api/projects/${p.id}/shots/${shot.id}/final`, { draftId: take!.id, kind: "same_take", mode: "now" });
    const finished = await api.project(p.id);
    const final = finished.takes.find((t) => t.rung === "final")!;
    expect(final).toMatchObject({ parentTakeId: take!.id, tool: { kind: "effect", effect: "freeze" } });
    expect(shotOf(finished, shot.id).chosenFinalId).toBe(final.id);

    // Another take with the same tool is a new version, and the pick.
    await api.run(`/api/projects/${p.id}/shots/${shot.id}/draft`, { tool: { kind: "effect", effect: "freeze" } });
    const again = await api.project(p.id);
    const newest = takesOf(again, shot.id).filter((t) => t.rung === "draft").at(-1)!;
    expect(newest.id).not.toBe(take!.id);
    expect(newest.tool).toEqual({ kind: "effect", effect: "freeze" });
    expect(shotOf(again, shot.id)).toMatchObject({ chosenDraftId: newest.id });
    expect(shotOf(again, shot.id).chosenFinalId).toBeUndefined();
  });

  it("a camera move on a film shot is a new version, picked, with its tool; a redrawn still is the pick until a draft is restored", async () => {
    let p = await create("cinematic_shot", { idea: "a lighthouse on a cliff", sequence: "one" });
    expect(p.shots).toHaveLength(1);
    const shotId = p.shots[0]!.id;
    const base = `/api/projects/${p.id}/shots/${shotId}`;

    // The tools need a still to start from.
    expect(await api.refused("POST", `${base}/draft`, { tool: { kind: "camera_move", move: "crane_up" } })).toEqual({ status: 409, error: "Make a still for this shot first: the tool starts from it." });
    await api.run(`${base}/still`);
    p = await api.project(p.id);
    const first = shotOf(p, shotId);
    expect(first.stillHistory).toEqual([{ assetId: first.stillAssetId, prompt: first.prompt, createdAt: expect.any(String) }]);
    expect(first.useStill).toBe(true);

    await api.run(`${base}/draft`, {});
    expect(await api.refused("POST", `${base}/draft`, { tool: { kind: "camera_move", move: "barrel_roll" } })).toEqual({ status: 400, error: "Unknown camera move: barrel_roll" });
    expect(await api.refused("POST", `${base}/draft`, { tool: { kind: "effect", effect: "sparkles" } })).toEqual({ status: 400, error: "Choose an effect from the gallery." });
    const moveJob = await api.run(`${base}/draft`, { tool: { kind: "camera_move", move: "crane_up" } });
    expect(moveJob.step).toBe("video_camera_move");
    p = await api.project(p.id);
    const [plain, moved] = takesOf(p, shotId);
    expect(plain!.tool).toBeUndefined();
    expect(moved).toMatchObject({ tool: { kind: "camera_move", move: "crane_up" }, imageAssetId: first.stillAssetId });
    expect(moved!.prompt).toContain("Crane up");
    expect(shotOf(p, shotId)).toMatchObject({ chosenDraftId: moved!.id });
    expect(shotOf(p, shotId).useStill).toBeUndefined();
    expect(p.timeline!.clips[0]!.assetId).toBe(moved!.videoAssetId);

    // Redraw the still with a new prompt: it joins the history and is the pick.
    await api.run(`${base}/still`, { prompt: "the lighthouse from the sea" });
    p = await api.project(p.id);
    const redrawn = shotOf(p, shotId);
    expect(redrawn.stillHistory!.map((h) => [h.assetId, h.prompt])).toEqual([
      [first.stillAssetId, first.prompt],
      [redrawn.stillAssetId, "the lighthouse from the sea"],
    ]);
    expect(redrawn.stillAssetId).not.toBe(first.stillAssetId);
    expect(redrawn).toMatchObject({ useStill: true, chosenDraftId: moved!.id });
    expect(p.timeline!.clips[0]!.assetId).toBe(redrawn.stillAssetId);

    // Restore the plain draft: the still is no longer the pick, and the cut shows the draft.
    p = await patch(p.id, { shots: p.shots.map((s) => (s.id === shotId ? { ...s, chosenDraftId: plain!.id, useStill: false } : s)) });
    expect(shotOf(p, shotId)).toMatchObject({ chosenDraftId: plain!.id, useStill: false });
    expect(p.timeline!.clips[0]!.assetId).toBe(plain!.videoAssetId);

    // Restore the first still: the cut shows it, and the history is unchanged.
    p = await patch(p.id, { shots: p.shots.map((s) => (s.id === shotId ? { ...s, stillAssetId: first.stillAssetId, useStill: true } : s)) });
    expect(shotOf(p, shotId).stillHistory).toEqual(redrawn.stillHistory);
    expect(p.timeline!.clips[0]!.assetId).toBe(first.stillAssetId);

    // A copy that picks a draft and says nothing of the still shows the draft.
    const { useStill: _, ...lean } = shotOf(p, shotId);
    p = await patch(p.id, { shots: [{ ...lean, chosenDraftId: moved!.id }] });
    expect(shotOf(p, shotId).useStill).toBeUndefined();
    expect(p.timeline!.clips[0]!.assetId).toBe(moved!.videoAssetId);

    // A still set by hand must be an image of this project.
    expect((await api.refused("PATCH", `/api/projects/${p.id}`, { shots: p.shots.map((s) => ({ ...s, stillAssetId: moved!.videoAssetId })) })).status).toBe(400);
  });

  it("make image draws a new still card; make video without an image draws the still, then the draft by itself", async () => {
    const p = await create("blank");
    expect(await api.refused("POST", `/api/projects/${p.id}/make`, { tool: "image" })).toEqual({ status: 400, error: "Describe the image to make." });

    const image = await make(p.id, { tool: "image", prompt: "a red kite over the dunes" });
    expect(image.job.step).toBe("still");
    expect(image.shot).toMatchObject({ onTimeline: false, useStill: true, prompt: "a red kite over the dunes" });
    expect(image.shot.stillHistory).toEqual([{ assetId: image.shot.stillAssetId, prompt: "a red kite over the dunes", createdAt: expect.any(String) }]);
    expect(takesOf(image.project, image.shot.id)).toEqual([]);

    const video = await make(p.id, { tool: "video", prompt: "waves at night", move: "dolly_in" });
    expect(video.job.step).toBe("still");
    const steps = (await jobs(p.id)).filter((j) => j.shotId === video.shot.id).map((j) => [j.step, j.status]);
    expect(steps).toEqual(expect.arrayContaining([["still", "done"], ["video_draft", "done"]]));
    expect(steps).toHaveLength(2);
    const [draft] = takesOf(video.project, video.shot.id);
    expect(draft).toMatchObject({ rung: "draft", imageAssetId: video.shot.stillAssetId });
    expect(draft!.tool).toBeUndefined();
    expect(video.shot).toMatchObject({ chosenDraftId: draft!.id, cameraMove: "dolly_in", onTimeline: false });
    expect(video.shot.useStill).toBeUndefined();
    expect(video.project.boards).toEqual([{ id: MAIN_BOARD_ID, name: "Board 1", items: [image.shot.id, video.shot.id] }]);

    // Video from an image: the image is the shot's still, and the draft starts from it.
    const upload = await photo(p.id);
    const fromImage = await make(p.id, { tool: "video", imageAssetId: upload.id });
    expect(fromImage.job.step).toBe("video_draft");
    expect(fromImage.shot).toMatchObject({ stillAssetId: upload.id, cameraMove: "static" });
    expect(takesOf(fromImage.project, fromImage.shot.id)[0]).toMatchObject({ imageAssetId: upload.id });

    // None of them is in the cut until it is sent there.
    expect(fromImage.project.timeline?.clips ?? []).toEqual([]);
  });

  it("a shot list rewrite keeps the cards made with the tools, and the new shots take the old ones' places", async () => {
    let p = await create("cinematic_shot", { idea: "a lighthouse in a storm", sequence: "three" });
    expect(p.shots).toHaveLength(3);
    p = await patch(p.id, { boards: [{ ...p.boards![0]!, items: [p.shots[0]!.id] }, { id: "board_end", name: "Ending", items: [p.shots[1]!.id, p.shots[2]!.id] }] });
    const made = await make(p.id, { tool: "image", prompt: "a gull on the railing", boardId: "board_end" });
    const old = new Set(p.shots.map((s) => s.id));

    await api.run(`/api/projects/${p.id}/storyboard`);
    await api.settle(p.id);
    p = await api.project(p.id);
    expect(p.shots).toHaveLength(4);
    const fresh = p.shots.filter((s) => s.id !== made.shot.id);
    expect(fresh.every((s) => !old.has(s.id))).toBe(true);
    expect(shotOf(p, made.shot.id)).toMatchObject({ stillAssetId: made.shot.stillAssetId, onTimeline: false });
    expect(p.boards).toEqual([
      { id: MAIN_BOARD_ID, name: "Shots", items: [fresh[0]!.id] },
      { id: "board_end", name: "Ending", items: [fresh[1]!.id, fresh[2]!.id, made.shot.id] },
    ]);
    // Stills were drawn for the new shots of the cut only.
    const stills = (await jobs(p.id)).filter((j) => j.step === "still");
    expect(stills.filter((j) => j.shotId === made.shot.id)).toHaveLength(1);
    expect(fresh.every((s) => s.stillAssetId)).toBe(true);
    expect(p.timeline!.clips.map((c) => c.shotId)).toEqual(fresh.map((s) => s.id));
  });

  it("a shot list rewrite keeps the tool cards and images on the timeline in place, before and after the new shots, with their takes", async () => {
    let p = await create("cinematic_shot", { idea: "a harbor at dawn", sequence: "three" });
    const listed = p.shots.map((s) => s.id);
    const image = await photo(p.id);
    const effect = await make(p.id, { tool: "effect", effect: "freeze", imageAssetId: image.id, prompt: "a harbor crane" });
    const move = await make(p.id, { tool: "camera_move", move: "crane_up", imageAssetId: image.id, prompt: "the harbor from above" });
    p = await api.project(p.id);
    // The Editor's drops: the effect first, the shot list, the image as a shot of its own, the camera move last.
    const placed: Shot = { id: "sht_placed", index: 0, prompt: "", cameraMove: "static", durationSec: 4, stillAssetId: image.id, locked: false, onTimeline: true };
    const order = [effect.shot.id, ...listed, placed.id, move.shot.id];
    const all = [...p.shots, placed];
    const boards = p.boards!.map((b) => ({ ...b, items: b.items.flatMap((id) => (id === image.id ? [id, placed.id] : [id])) }));
    p = await patch(p.id, { shots: order.map((id) => ({ ...all.find((s) => s.id === id)!, onTimeline: true })), boards });
    // The shot list has nothing to show yet, so the cut is the cards.
    expect(p.timeline!.clips.map((c) => c.shotId)).toEqual([effect.shot.id, placed.id, move.shot.id]);
    const takes = p.takes;

    await api.run(`/api/projects/${p.id}/storyboard`);
    await api.settle(p.id);
    p = await api.project(p.id);
    const fresh = p.shots.filter((s) => ![effect.shot.id, placed.id, move.shot.id].includes(s.id));
    expect(fresh).toHaveLength(3);
    expect(fresh.some((s) => listed.includes(s.id))).toBe(false);
    expect(p.shots.map((s) => s.id)).toEqual([effect.shot.id, ...fresh.map((s) => s.id), placed.id, move.shot.id]);
    expect(p.timeline!.clips.map((c) => c.shotId)).toEqual(p.shots.map((s) => s.id));
    for (const card of [effect.shot, move.shot]) {
      expect(takesOf(p, card.id)).toEqual(takes.filter((t) => t.shotId === card.id));
      expect(shotOf(p, card.id)).toMatchObject({ chosenDraftId: card.chosenDraftId, stillAssetId: image.id });
    }
    expect(shotOf(p, placed.id)).toMatchObject({ prompt: "", stillAssetId: image.id });
    expect(p.boards!.flatMap((b) => b.items)).toEqual(expect.arrayContaining([effect.shot.id, placed.id, move.shot.id]));
    // Stills were drawn for the new shots only.
    const stills = (await jobs(p.id)).filter((j) => j.step === "still").map((j) => j.shotId);
    expect(stills.sort()).toEqual(fresh.map((s) => s.id).sort());
  });

  it("a song made for a board lands there, and a soundtrack of null keeps it out of the cut", async () => {
    let p = await create("blank");
    const image = await photo(p.id);
    const shot = await make(p.id, { tool: "video", imageAssetId: image.id });
    await sendToTimeline(shot.project, shot.shot.id);
    p = await patch(p.id, { boards: [...(await api.project(p.id)).boards!, { id: "board_sound", name: "Sound", items: [] }] });

    const song = await api.run(`/api/projects/${p.id}/audio`, { role: "music", prompt: "slow strings", durationSec: 10, boardId: "board_sound" });
    await api.settle(p.id);
    p = await api.project(p.id);
    const songId = song.outputAssetIds[0]!;
    expect(p.boards!.find((b) => b.id === "board_sound")!.items).toEqual([songId]);
    expect(p.timeline!.audio.map((a) => a.assetId)).toEqual([songId]);

    p = await patch(p.id, { soundtrack: { music: null } });
    expect(p.soundtrack).toEqual({ music: null });
    expect(p.timeline!.audio).toEqual([]);
    p = await patch(p.id, { soundtrack: { music: songId } });
    expect(p.timeline!.audio.map((a) => a.assetId)).toEqual([songId]);
    expect((await api.refused("PATCH", `/api/projects/${p.id}`, { soundtrack: { music: image.id } })).status).toBe(400);
    expect((await api.refused("PATCH", `/api/projects/${p.id}`, { boards: [...p.boards!, { id: "board_sound", name: "Again", items: [] }] })).status).toBe(400);

    // A new song is the one that plays: making it clears the pick.
    await patch(p.id, { soundtrack: { music: null } });
    const next = await api.run(`/api/projects/${p.id}/audio`, { role: "music", prompt: "warm piano", durationSec: 10 });
    await api.settle(p.id);
    p = await api.project(p.id);
    expect(p.soundtrack).toEqual({});
    expect(p.timeline!.audio.map((a) => a.assetId)).toEqual([next.outputAssetIds[0]]);
    expect(p.boards![0]!.items).toContain(next.outputAssetIds[0]);

    // A hand-edited cut keeps its clips and plays the picked song, or none.
    p = await patch(p.id, { timeline: { ...p.timeline!, edited: true } });
    expect(p.timeline!.edited).toBe(true);
    p = await patch(p.id, { soundtrack: { music: null } });
    expect(p.timeline).toMatchObject({ edited: true, audio: [] });
    p = await patch(p.id, { soundtrack: { music: songId } });
    expect(p.timeline!.audio.map((a) => [a.role, a.assetId])).toEqual([["music", songId]]);
    expect(p.timeline!.clips.map((c) => c.shotId)).toEqual([shot.shot.id]);
  });

  it("an uploaded song or voiceover is the one the cut plays, after a pick or with the sound off, and it is measured", async () => {
    let p = await create("blank");
    const image = await photo(p.id);
    const shot = await make(p.id, { tool: "video", imageAssetId: image.id });
    await sendToTimeline(shot.project, shot.shot.id);
    /** Upload a track the way Media does, wait for everything, and return its analysis job. */
    const upload = async (role: "music" | "voice", name: string): Promise<{ asset: Asset; analysis: Job }> => {
      const seen = new Set((await jobs(p.id)).map((j) => j.id));
      const asset = await api.upload(p.id, placeholderMusic(6, name), `${name}.wav`, "audio/wav", role);
      await api.settle(p.id);
      const analysis = (await jobs(p.id)).filter((j) => j.analysis && !seen.has(j.id));
      expect(analysis).toHaveLength(1);
      return { asset, analysis: analysis[0]! };
    };

    // Music off, then a song dropped on the canvas: it plays, and it is measured.
    p = await patch(p.id, { soundtrack: { music: null } });
    const first = await upload("music", "first song");
    expect(first.analysis.message).toMatch(/^Song measured/);
    p = await api.project(p.id);
    expect(p.soundtrack).toEqual({});
    expect(p.timeline!.audio.map((a) => [a.role, a.assetId])).toEqual([["music", first.asset.id]]);

    // An older song picked, then a song uploaded: the upload takes over.
    p = await patch(p.id, { soundtrack: { music: first.asset.id } });
    const second = await upload("music", "second song");
    expect(second.analysis.message).toMatch(/^Song measured/);
    p = await api.project(p.id);
    expect(p.soundtrack).toEqual({});
    expect(p.timeline!.audio.map((a) => a.assetId)).toEqual([second.asset.id]);

    // A voiceover with the voice off: it plays too, next to the song.
    p = await patch(p.id, { soundtrack: { voice: null } });
    const voice = await upload("voice", "a voiceover");
    p = await api.project(p.id);
    expect(p.soundtrack).toEqual({});
    expect(p.timeline!.audio.map((a) => [a.role, a.assetId]).sort()).toEqual([["music", second.asset.id], ["voice", voice.asset.id]]);

    // A hand-edited cut with the music off keeps its clips and gets the uploaded song.
    p = await patch(p.id, { timeline: { ...p.timeline!, edited: true } });
    p = await patch(p.id, { soundtrack: { music: null } });
    expect(p.timeline!.audio.map((a) => a.role)).toEqual(["voice"]);
    const third = await upload("music", "third song");
    expect(third.analysis.message).toBe("The song is on the edited cut");
    p = await api.project(p.id);
    expect(p.soundtrack).toEqual({});
    expect(p.timeline!.edited).toBe(true);
    expect(p.timeline!.audio.map((a) => [a.role, a.assetId]).sort()).toEqual([["music", third.asset.id], ["voice", voice.asset.id]]);
    expect(p.timeline!.clips.map((c) => c.shotId)).toEqual([shot.shot.id]);
  });
});

describe.skipIf(!hasFfmpeg)("image edits", { timeout: 120_000 }, () => {
  it("an edit of an image is a new card whose still is the image changed as the prompt says", async () => {
    const p = await create("blank");
    const image = await photo(p.id);

    // Refused in plain words, before anything is stored.
    const refused = (body: Record<string, unknown>) => api.refused("POST", `/api/projects/${p.id}/make`, { tool: "edit", ...body });
    expect(await refused({ imageAssetId: image.id })).toEqual({ status: 400, error: "Say how to change the image." });
    expect(await refused({ imageAssetId: image.id, prompt: "   " })).toEqual({ status: 400, error: "Say how to change the image." });
    expect(await refused({ prompt: "make it night" })).toEqual({ status: 400, error: "Choose an image from this project first." });
    expect(await refused({ prompt: "make it night", imageAssetId: "ast_nope" })).toEqual({ status: 400, error: "Choose an image from this project first." });
    expect((await api.project(p.id)).shots).toEqual([]);

    const { job, project, shot } = await make(p.id, { tool: "edit", imageAssetId: image.id, prompt: " make it night " });
    expect(job.step).toBe("still");
    expect((await jobs(p.id)).find((j) => j.id === job.id)!.message).toBe("Edit ready");
    expect(shot).toMatchObject({ prompt: "make it night", onTimeline: false, useStill: true });
    expect(shot.aspect).toBeUndefined();
    expect(shot.stillAssetId).toBeDefined();
    expect(shot.stillAssetId).not.toBe(image.id);
    expect(shot.stillHistory).toEqual([{ assetId: shot.stillAssetId, prompt: "make it night", createdAt: expect.any(String) }]);
    expect(takesOf(project, shot.id)).toEqual([]);
    expect(project.boards![0]!.items).toEqual([image.id, shot.id]);
    expect(project.timeline?.clips ?? []).toEqual([]);

    // One image edit (FLUX.2 Klein on this tier), given the image, the instruction, and the card's still size.
    expect(requestsOf(job).map((c) => c.step)).toEqual(["effect_end_frame"]);
    const edit = requestOf(job, "effect_end_frame");
    expect(edit.ref.workflow).toBe("look_edit_klein4b.api.json");
    expect(edit.values).toMatchObject({ image: expect.stringContaining(image.id), prompt: "make it night", seed: expect.any(Number) });
    expect(sized(edit)).toEqual({ size: [960, 576], aspect: "16:9", hinted: [960, 576] });
    // The image it was made from stays as it was.
    expect(project.assets.find((a) => a.id === image.id)).toEqual(image);
  });

  it("a card's still can be drawn again as an edit of any image of the project, and joins its history", async () => {
    let p = await create("cinematic_shot", { idea: "a lighthouse on a cliff", sequence: "one" });
    const shotId = p.shots[0]!.id;
    const base = `/api/projects/${p.id}/shots/${shotId}`;
    await api.run(`${base}/still`);
    await api.run(`${base}/draft`);
    p = await api.project(p.id);
    const first = shotOf(p, shotId);
    const draft = takesOf(p, shotId)[0]!;

    // Refused in plain words.
    expect(await api.refused("POST", `${base}/still`, { editFrom: "ast_nope", prompt: "make it snow" })).toEqual({ status: 404, error: "That image is not in this project." });
    expect(await api.refused("POST", `${base}/still`, { editFrom: draft.videoAssetId, prompt: "make it snow" })).toEqual({ status: 409, error: "Only an image can be edited. Choose a still or a photo." });
    expect(await api.refused("POST", `${base}/still`, { editFrom: first.stillAssetId })).toEqual({ status: 400, error: "Say how to change the image." });

    // An edit of the card's own still: the new still is the pick, with the instruction in its history.
    const job = await api.run(`${base}/still`, { editFrom: first.stillAssetId, prompt: "make it snow", seed: 7 });
    expect(job.message).toBe("Edit ready");
    const edit = requestOf(job, "effect_end_frame");
    expect(edit.values).toMatchObject({ image: expect.stringContaining(first.stillAssetId!), prompt: "make it snow", seed: 7 });
    expect(sized(edit)).toEqual({ size: [960, 576], aspect: "16:9", hinted: [960, 576] });
    p = await api.project(p.id);
    const edited = shotOf(p, shotId);
    expect(edited.stillHistory!.map((h) => [h.assetId, h.prompt])).toEqual([
      [first.stillAssetId, first.prompt],
      [edited.stillAssetId, "make it snow"],
    ]);
    expect(edited).toMatchObject({ prompt: first.prompt, useStill: true, chosenDraftId: draft.id });
    expect(p.timeline!.clips[0]!.assetId).toBe(edited.stillAssetId);

    // An uploaded photo works the same way.
    const upload = await photo(p.id);
    const again = await api.run(`${base}/still`, { editFrom: upload.id, prompt: "the lighthouse at night" });
    expect(requestOf(again, "effect_end_frame").values.image).toContain(upload.id);
    expect(shotOf(await api.project(p.id), shotId).stillHistory!.map((h) => h.prompt)).toEqual([first.prompt, "make it snow", "the lighthouse at night"]);
  });

  it("an edit needs a tier with an image edit step, and quick-shot projects refuse it as they refuse the tools", async () => {
    const p = await create("blank");
    const image = await photo(p.id);
    await api.install("apple-64");
    try {
      expect(await api.refused("POST", `/api/projects/${p.id}/make`, { tool: "edit", imageAssetId: image.id, prompt: "make it night" })).toEqual({
        status: 409,
        error: expect.stringMatching(/^The .+ recipe cannot edit images\.$/),
      });
    } finally {
      await api.install("unified-128-cuda");
    }
    expect((await api.project(p.id)).shots).toEqual([]);

    const quick = await create("vfx_effect", BRIEFS.vfx_effect.brief);
    const statue = await photo(quick.id);
    await patch(quick.id, { shots: [{ id: "sht_statue", index: 0, prompt: "a statue", durationSec: 4, locked: false }] });
    const refusal = { status: 409, error: "This project makes one shot from its photo. Start a new project to use the tools." };
    expect(await api.refused("POST", `/api/projects/${quick.id}/shots/sht_statue/still`, { editFrom: statue.id, prompt: "make it gold" })).toEqual(refusal);
    expect(await api.refused("POST", `/api/projects/${quick.id}/make`, { tool: "edit", imageAssetId: statue.id, prompt: "make it gold" })).toEqual(refusal);
    expect(await jobs(quick.id)).toEqual([]);
  });
});

describe.skipIf(!hasFfmpeg)("cards in their own shape", { timeout: 120_000 }, () => {
  it("every render of a card takes its own shape, and the project's other cards keep the project's", async () => {
    let p = await create("blank"); // 16:9
    const image = await photo(p.id);

    // A square card: its still, its draft and its finals are square, at each model's own size for 1:1.
    const square = await make(p.id, { tool: "image", prompt: "a square tile", aspect: "1:1" });
    expect(square.shot.aspect).toBe("1:1");
    expect(sized(requestOf(square.job, "still"))).toEqual({ size: [768, 768], aspect: "1:1", hinted: [768, 768] });
    const still = square.project.assets.find((a) => a.id === square.shot.stillAssetId)!;
    expect([still.width, still.height]).toEqual([768, 768]);
    const base = `/api/projects/${p.id}/shots/${square.shot.id}`;
    const draft = await api.run(`${base}/draft`, { seed: 5 });
    expect(sized(requestOf(draft, "video_draft"))).toEqual({ size: [512, 512], aspect: "1:1", hinted: [512, 512] });
    const take = takesOf(await api.project(p.id), square.shot.id)[0]!;
    // The same take renders the draft's latent again at twice its size; the remaster at its own square size.
    const same = await api.run(`${base}/final`, { draftId: take.id, kind: "same_take", mode: "now" });
    expect(requestOf(same, "video_final_same_take").hints).toMatchObject({ aspect: "1:1", width: 1024, height: 1024 });
    const remaster = await api.run(`${base}/final`, { draftId: take.id, kind: "remaster", mode: "now" });
    expect(sized(requestOf(remaster, "video_final_remaster"))).toEqual({ size: [960, 960], aspect: "1:1", hinted: [960, 960] });

    // A card made without a shape keeps the project's.
    const wide = await make(p.id, { tool: "image", prompt: "a wide street" });
    expect(wide.shot.aspect).toBeUndefined();
    expect(sized(requestOf(wide.job, "still"))).toEqual({ size: [960, 576], aspect: "16:9", hinted: [960, 576] });

    // An effect on a tall card: its end frame and its video are the wide card's sizes turned on their side.
    const wideEffect = await make(p.id, { tool: "effect", effect: "freeze", imageAssetId: image.id });
    const tallEffect = await make(p.id, { tool: "effect", effect: "freeze", imageAssetId: image.id, aspect: "9:16" });
    expect(tallEffect.shot.aspect).toBe("9:16");
    for (const step of ["effect_end_frame", "video_effect"] as const) {
      const [w, t] = [sized(requestOf(wideEffect.job, step)), sized(requestOf(tallEffect.job, step))];
      expect([w.aspect, t.aspect]).toEqual(["16:9", "9:16"]);
      expect(t.size).toEqual([...w.size].reverse());
      expect(t.hinted).toEqual(t.size);
    }

    // A camera move on a tall card: its layout and its move are tall.
    const move = await make(p.id, { tool: "camera_move", move: "crane_up", imageAssetId: image.id, aspect: "9:16" });
    for (const step of ["camera_layout", "video_camera_move"] as const) {
      const c = sized(requestOf(move.job, step));
      expect(c.aspect).toBe("9:16");
      expect(c.size).toEqual([384, 640]);
    }

    // An edit made as a square card is drawn at the square still size.
    const edit = await make(p.id, { tool: "edit", imageAssetId: image.id, prompt: "make it night", aspect: "1:1" });
    expect(edit.shot.aspect).toBe("1:1");
    expect(sized(requestOf(edit.job, "effect_end_frame"))).toEqual({ size: [768, 768], aspect: "1:1", hinted: [768, 768] });

    // The shape is the card's own: changed with a PATCH, the next still takes it. Left out, the card is the project's shape.
    p = await api.project(p.id);
    p = await patch(p.id, { shots: p.shots.map((s) => (s.id === square.shot.id ? { ...s, aspect: "9:16" } : s)) });
    expect(shotOf(p, square.shot.id).aspect).toBe("9:16");
    const redrawn = await api.run(`${base}/still`);
    expect(sized(requestOf(redrawn, "still"))).toEqual({ size: [576, 960], aspect: "9:16", hinted: [576, 960] });
    p = await api.project(p.id);
    p = await patch(p.id, { shots: p.shots.map((s) => (s.id === square.shot.id ? (({ aspect: _, ...rest }) => rest)(s) : s)) });
    expect(shotOf(p, square.shot.id).aspect).toBeUndefined();
    const plain = await api.run(`${base}/still`);
    expect(sized(requestOf(plain, "still"))).toEqual({ size: [960, 576], aspect: "16:9", hinted: [960, 576] });
    expect((await api.refused("PATCH", `/api/projects/${p.id}`, { shots: p.shots.map((s) => ({ ...s, aspect: "4:3" })) })).status).toBe(400);
  });
});

describe.skipIf(!canRender)("exports with cards of another shape", { timeout: 300_000 }, () => {
  it("a square card in a 16:9 cut exports at 16:9, framed like any picture of another shape", async () => {
    const p = await create("blank");
    const video = await make(p.id, { tool: "video", prompt: "a square tile, slowly turning", aspect: "1:1" });
    const image = await make(p.id, { tool: "image", prompt: "a square tile at rest", aspect: "1:1" });
    const cut = await sendToTimeline(await api.project(p.id), video.shot.id, image.shot.id);
    expect(cut.timeline!.clips.map((c) => c.shotId)).toEqual([video.shot.id, image.shot.id]);
    const clipSizes = cut.timeline!.clips.map((c) => cut.assets.find((a) => a.id === c.assetId)!).map((a) => [a.kind, a.width, a.height]);
    expect(clipSizes).toEqual([["video", 512, 512], ["image", 768, 768]]);

    const job = await api.run(`/api/projects/${p.id}/export`, { aspect: "16:9", quality: "preview" });
    expect(job.message).toMatch(/^Exported 960x540, /);
    const project = await api.project(p.id);
    const out = project.assets.find((a) => a.id === job.outputAssetIds[0])!;
    expect(out.role).toBe("export");
    expect(await probeMedia(join(dataDir, "projects", p.id, out.path))).toMatchObject({ width: 960, height: 540 });
  });
});
