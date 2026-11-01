/**
 * Extra cards in a What if? film and in quick shots, through the engine API (mock GPU): the Media tools make cards there
 * on their own paths, as in a blank project, while the template's own shot keeps its flow. Extra cards stay off the
 * timeline and out of the export, and the film or the shot never sees them. Every step request is recorded, so the
 * tests see what each workflow would get.
 */
import { JobSchema, MAIN_BOARD_ID, ownShot, projectBoards, ProjectSchema, whatIfLook, type Job, type Project, type Shot } from "@nightshift/contract";
import { checkTools } from "@nightshift/editor";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { startEngine, type EngineHandle } from "../src/engine.js";
import { findFfmpeg, probeMedia } from "../src/media/ffmpeg.js";
import { placeholderScene } from "../src/media/png.js";
import { defaultRecipesDir } from "../src/paths.js";
import { MockStepRunner } from "../src/runner/mock.js";
import type { StepRequest, StepRunner } from "../src/runner/types.js";
import { Api, BRIEFS } from "./flow.js";

const hasFfmpeg = !!(await findFfmpeg());
const canRender = hasFfmpeg && !!checkTools().chrome;
const dataDir = mkdtempSync(join(tmpdir(), "ns-extra-cards-"));
const calls: StepRequest[] = [];
const mock = new MockStepRunner(0);
const runner: StepRunner = { run: (req, ctx) => (calls.push(structuredClone(req)), mock.run(req, ctx)) };

let engine: EngineHandle;
let api: Api;

beforeAll(async () => {
  engine = await startEngine({ port: 0, dataDir, mock: true, mockSpeed: 0, recipesDir: defaultRecipesDir(), runner, log: () => undefined });
  api = new Api(engine.url);
  await api.install("unified-128-cuda");
}, 60_000);
afterAll(() => engine?.stop());

const jobs = (pid: string) => api.call("GET", `/api/jobs?projectId=${pid}`, z.array(JobSchema));
const patch = (pid: string, body: unknown) => api.call("PATCH", `/api/projects/${pid}`, ProjectSchema, body);
const shotOf = (p: Project, id: string) => p.shots.find((s) => s.id === id)!;
const takesOf = (p: Project, shotId: string) => p.takes.filter((t) => t.shotId === shotId);
/** A project with its photo, as the What if? form and the quick shots start one. */
async function withPhoto(template: Project["template"]): Promise<{ p: Project; photo: string }> {
  const { name, brief } = BRIEFS[template];
  const p = await api.call("POST", "/api/projects", ProjectSchema, { name, template, aspect: "16:9", brief });
  const photo = await api.upload(p.id, placeholderScene(640, 384, "harbor").toPng(), "harbor.png", "image/png");
  return { p: await patch(p.id, { brief: { ...brief, photoAssetId: photo.id } }), photo: photo.id };
}
/** Make a card with a tool and wait for everything it queued. */
async function make(pid: string, body: Record<string, unknown>): Promise<{ job: Job; project: Project; shot: Shot }> {
  const job = await api.job(`/api/projects/${pid}/make`, body);
  await api.settle(pid);
  const done = (await jobs(pid)).find((j) => j.id === job.id)!;
  expect(done.status, done.error).toBe("done");
  const project = await api.project(pid);
  return { job, project, shot: shotOf(project, job.shotId!) };
}
/** The jobs a card had, by step, oldest first. */
const stepsOf = async (pid: string, shotId: string) =>
  (await jobs(pid)).filter((j) => j.shotId === shotId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((j) => j.step);
/** The one request of a step a job sent. */
function requestOf(job: Pick<Job, "id">, step: StepRequest["step"]): StepRequest {
  const found = calls.filter((c) => c.jobId === job.id && c.step === step);
  expect(found, `${step} requests of ${job.id}`).toHaveLength(1);
  return found[0]!;
}
/** The canvas's shot cards, board by board (the film's voice and music are cards too). */
const shotCards = (p: Project) => projectBoards(p).map((b) => ({ ...b, items: b.items.filter((id) => p.shots.some((s) => s.id === id)) }));
/** The shot each clip of the cut shows. */
const cutOf = (p: Project) => (p.timeline?.clips ?? []).map((c) => c.shotId);

describe.skipIf(!hasFfmpeg)("extra cards in a What if? film", { timeout: 180_000 }, () => {
  it("makes images and videos on the tools' own paths, while the story, its beats, the film and its final work as before", async () => {
    let { p, photo } = await withPhoto("what_if");
    const base = `/api/projects/${p.id}`;

    // Before the story: an image card. The film's look is not added to its prompt.
    const kite = await make(p.id, { tool: "image", prompt: "a red kite over a grey beach" });
    expect(kite.job.step).toBe("still");
    expect(kite.shot).toMatchObject({ onTimeline: false, prompt: "a red kite over a grey beach" });
    const kiteStill = requestOf(kite.job, "still");
    expect(kiteStill.values.prompt).toBe("A red kite over a grey beach.");
    expect(kiteStill.values.image2).toBeUndefined();

    // The story: the film is the project's own shot, first, and the card made before it stays as it was.
    await api.run(`${base}/storyboard`);
    await api.settle(p.id);
    p = await api.project(p.id);
    const film = ownShot(p)!;
    expect(film.keyframes).toHaveLength(4);
    expect(film.keyframes![0]!.stillAssetId).toBe(photo);
    expect(p.shots.map((s) => s.id)).toEqual([film.id, kite.shot.id]);
    expect(shotOf(p, kite.shot.id)).toMatchObject({ onTimeline: false, stillAssetId: kite.shot.stillAssetId, index: 1 });
    expect(shotCards(p)).toEqual([{ id: MAIN_BOARD_ID, name: "Film", items: [film.id, kite.shot.id] }]);
    const [filmTake] = takesOf(p, film.id);
    expect(filmTake!.guideAssetIds).toEqual(film.keyframes!.map((k) => k.stillAssetId));
    expect(cutOf(p)).toEqual([film.id]);

    // After the story: a video from a prompt is a still, then a plain motion draft. Neither is the film's.
    const waves = await make(p.id, { tool: "video", prompt: "waves roll onto the sand" });
    expect(await stepsOf(p.id, waves.shot.id)).toEqual(["still", "video_draft"]);
    expect(requestOf(waves.job, "still").values.prompt).toBe("Waves roll onto the sand.");
    const wavesDraft = requestOf((await jobs(p.id)).find((j) => j.shotId === waves.shot.id && j.step === "video_draft")!, "video_draft");
    expect(wavesDraft.values.prompt).toBe("Waves roll onto the sand. The camera holds still.");
    for (const prompt of [kiteStill.values.prompt, wavesDraft.values.prompt]) expect(String(prompt)).not.toContain(whatIfLook(p.brief));
    expect(waves.shot).toMatchObject({ onTimeline: false });
    expect(takesOf(waves.project, waves.shot.id)).toHaveLength(1);

    // An image card is edited like any other; the film is drawn from its story.
    const edited = await api.run(`${base}/shots/${kite.shot.id}/still`, { prompt: "make it night", editFrom: kite.shot.stillAssetId });
    expect(requestOf(edited, "effect_end_frame").values.prompt).toBe("make it night");
    expect(await api.refused("POST", `${base}/shots/${film.id}/still`, { prompt: "make it night", editFrom: film.stillAssetId })).toEqual({ status: 409, error: "A What if? film is drawn from its story. Redraw a beat there instead." });
    // A card's video finishes as a remaster too; the film only as its same take.
    const remaster = await api.run(`${base}/shots/${waves.shot.id}/final`, { draftId: takesOf(waves.project, waves.shot.id)[0]!.id, kind: "remaster", mode: "now" });
    expect(remaster.step).toBe("video_final_remaster");
    expect((await api.refused("POST", `${base}/shots/${film.id}/final`, { draftId: filmTake!.id, kind: "remaster", mode: "now" })).status).toBe(409);

    // The film's own flow, with the cards beside it: redraw a beat, another take, the same-take final.
    p = await api.project(p.id);
    const before = film.keyframes!.map((k) => k.stillAssetId);
    await api.run(`${base}/shots/${film.id}/still`, { keyframeIndex: 2, seed: 123 });
    p = await api.project(p.id);
    const after = shotOf(p, film.id).keyframes!.map((k) => k.stillAssetId);
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
    expect(after[2]).not.toBe(before[2]);
    expect(shotOf(p, kite.shot.id).stillAssetId).not.toBe(kite.shot.stillAssetId); // the edit
    const take = await api.run(`${base}/shots/${film.id}/draft`, { seed: 456 });
    expect(take.step).toBe("video_what_if");
    expect(await api.run(`${base}/shots/${film.id}/final`, { draftId: filmTake!.id, kind: "same_take", mode: "now" })).toMatchObject({ step: "video_final_same_take" });
    p = await api.project(p.id);
    expect(takesOf(p, film.id).filter((t) => t.rung === "draft")).toHaveLength(2);
    expect(takesOf(p, waves.shot.id).map((t) => t.rung)).toEqual(["draft", "final"]);
    expect(cutOf(p)).toEqual([film.id]);

    // Only the film goes on the timeline, and it stays: refused in plain words, nothing changed.
    expect(await api.refused("PATCH", base, { shots: p.shots.map((s) => (s.id === waves.shot.id ? { ...s, onTimeline: true } : s)) })).toEqual({
      status: 400,
      error: "Only this project's own shot goes on its timeline. Cards made with the tools stay in Media.",
    });
    expect(await api.refused("PATCH", base, { shots: p.shots.filter((s) => s.id !== film.id) })).toEqual({ status: 400, error: "This project's own shot stays. Only cards made with the tools can be deleted." });
    // A card can be deleted, and the film stays first however the cards are sent.
    p = await patch(p.id, { shots: [...p.shots].reverse().filter((s) => s.id !== kite.shot.id) });
    expect(p.shots.map((s) => [s.id, s.index])).toEqual([[film.id, 0], [waves.shot.id, 1]]);

    // A new story replaces the film and its takes. The cards stay, with theirs, and the new film takes the old one's place.
    await api.run(`${base}/storyboard`);
    await api.settle(p.id);
    p = await api.project(p.id);
    const rewritten = ownShot(p)!;
    expect(rewritten.id).not.toBe(film.id);
    expect(p.shots.map((s) => s.id)).toEqual([rewritten.id, waves.shot.id]);
    expect(takesOf(p, film.id)).toEqual([]);
    expect(takesOf(p, waves.shot.id).map((t) => t.rung)).toEqual(["draft", "final"]);
    expect(shotCards(p)[0]!.items).toEqual([rewritten.id, waves.shot.id]);
    expect(cutOf(p)).toEqual([rewritten.id]);

    // The export is the film alone.
    if (canRender) {
      const exported = await api.run(`${base}/export`, { aspect: "16:9", quality: "preview" });
      p = await api.project(p.id);
      expect(cutOf(p)).toEqual([rewritten.id]);
      const asset = p.assets.find((a) => a.id === exported.outputAssetIds[0])!;
      expect((await probeMedia(join(dataDir, "projects", p.id, asset.path))).durationSec).toBeCloseTo(15, 0);
    }
  });
});

describe.skipIf(!hasFfmpeg)("extra cards in quick shots", { timeout: 180_000 }, () => {
  it("a camera move makes its own shot first, then cards on their own paths; its shot and its takes are untouched", async () => {
    let { p, photo } = await withPhoto("camera_move");
    const base = `/api/projects/${p.id}`;
    expect(await api.refused("POST", `${base}/make`, { tool: "image", prompt: "a paper boat" })).toEqual({ status: 409, error: "Make the shot from this project's photo first." });

    await api.run(`${base}/storyboard`);
    await api.settle(p.id);
    p = await api.project(p.id);
    const own = ownShot(p)!;
    expect(p.shots).toHaveLength(1);
    expect(own.stillAssetId).toBe(photo);

    // An image and a video of the photo: a still drawn as written, and a plain motion draft, not the camera move.
    const boat = await make(p.id, { tool: "image", prompt: "a paper boat on a pond" });
    expect(requestOf(boat.job, "still").values.prompt).toBe("A paper boat on a pond.");
    const pan = await make(p.id, { tool: "video", imageAssetId: photo, prompt: "the boats rock gently", move: "pan_left" });
    expect(pan.job.step).toBe("video_draft");
    expect(requestOf(pan.job, "video_draft").values.prompt).toBe("The boats rock gently. The camera pans left.");
    expect(pan.shot).toMatchObject({ onTimeline: false, stillAssetId: photo });
    // A card's still can be drawn again; the shot's still is its photo.
    expect((await api.run(`${base}/shots/${boat.shot.id}/still`, {})).step).toBe("still");
    expect((await api.refused("POST", `${base}/shots/${own.id}/still`, {})).status).toBe(409);

    // The shot's own flow: another take is its camera move, and preparing it again keeps the cards.
    expect((await api.run(`${base}/shots/${own.id}/draft`, {})).step).toBe("video_camera_move");
    await api.run(`${base}/storyboard`);
    await api.settle(p.id);
    p = await api.project(p.id);
    expect(p.shots.map((s) => s.id)).toEqual([own.id, boat.shot.id, pan.shot.id]);
    expect(takesOf(p, own.id).map((t) => t.tool)).toEqual([undefined, undefined, undefined]);
    expect(takesOf(p, pan.shot.id)).toHaveLength(1);
    expect(cutOf(p)).toEqual([own.id]);
    expect(await api.refused("PATCH", base, { shots: p.shots.map((s) => ({ ...s, onTimeline: true })) })).toMatchObject({ status: 400 });
  });

  it("an effect keeps its own shot, draws a card's still on the GPU, and rewrites only its own shot", async () => {
    let { p, photo } = await withPhoto("vfx_effect");
    const base = `/api/projects/${p.id}`;
    await api.run(`${base}/storyboard`);
    await api.settle(p.id);
    p = await api.project(p.id);
    const own = ownShot(p)!;
    expect(own.stillAssetId).toBe(photo);

    const moon = await make(p.id, { tool: "image", prompt: "a full moon over the statue" });
    expect(requestOf(moon.job, "still").values.prompt).toBe("A full moon over the statue.");
    const grow = await make(p.id, { tool: "effect", effect: "bloom", imageAssetId: moon.shot.stillAssetId });
    expect(grow.job.step).toBe("video_effect");
    expect(takesOf(grow.project, grow.shot.id)[0]).toMatchObject({ tool: { kind: "effect", effect: "bloom" }, imageAssetId: moon.shot.stillAssetId });

    // Written again, the shot from the photo is new and drafted once. The cards keep their stills and takes.
    await api.run(`${base}/storyboard`);
    await api.settle(p.id);
    p = await api.project(p.id);
    const again = ownShot(p)!;
    expect(again.id).not.toBe(own.id);
    expect(again.stillAssetId).toBe(photo);
    expect(p.shots.map((s) => s.id)).toEqual([again.id, moon.shot.id, grow.shot.id]);
    expect(shotOf(p, moon.shot.id).stillAssetId).toBe(moon.shot.stillAssetId);
    expect(takesOf(p, grow.shot.id)).toHaveLength(1);
    const effects = (await jobs(p.id)).filter((j) => j.step === "video_effect").map((j) => j.shotId);
    expect(effects.toSorted()).toEqual([own.id, grow.shot.id, again.id].toSorted());
    expect(cutOf(p)).toEqual([again.id]);
  });
});
