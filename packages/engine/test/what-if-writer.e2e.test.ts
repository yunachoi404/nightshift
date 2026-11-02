/**
 * The What if? writer through the engine, with a stand-in writer, on the problems the night of Nov 2 found:
 * - the writer fell back 2 of 2 times, the board said nothing, and the app went on to draw, voice and render a film from
 *   the starter story's filler narration;
 * - "Rewrite story" deleted the film's take, while the story page says takes stay saved.
 */
import { JobSchema, ProjectSchema, SettingsSchema, fallbackWhatIf, type Project } from "@nightshift/contract";
import { checkTools } from "@nightshift/editor";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { startEngine, type EngineHandle } from "../src/engine.js";
import { defaultRecipesDir } from "../src/paths.js";
import { MockStepRunner } from "../src/runner/mock.js";
import type { StepRequest, StepRunner } from "../src/runner/types.js";
import { Api } from "./flow.js";

/** Answers each story request with the next of `answers` (text as written, or an error it throws), then with its outline. */
class Writer implements StepRunner {
  readonly requests: StepRequest[] = [];
  answers: (string | Error)[] = [];
  private readonly mock = new MockStepRunner(0);

  async run(req: StepRequest, ctx: Parameters<StepRunner["run"]>[1]) {
    this.requests.push(req);
    if (req.step !== "text") return this.mock.run(req, ctx);
    const next = this.answers.shift();
    if (next instanceof Error) throw next;
    const out = join(req.outDir, "text.json");
    await writeFile(out, next ?? String(req.values.fallback));
    return [{ path: out, kind: "text" as const, nodeId: "3" }];
  }
}

/** The library question from the night of Nov 2: no tested starter story fits it, so the starter is filler. */
const BOOKS = { question: "What if every book in an old library flew off its shelf like a bird?", look: "miniature" };
const GRAVITY = { question: "What if gravity stopped for ten seconds?", look: "cinematic" };

/** A story the writer could have written for the library: four states, 38 spoken words. */
const BOOKS_STORY = JSON.stringify({
  prompt: "A quiet old library with tall wooden shelves. One red book opens its covers like wings and lifts off, then the other books follow and circle the room like a flock, and the shelves are left empty.",
  cameraMove: "static",
  keyframes: [
    { prompt: "A quiet old library with tall wooden shelves, every book in its place, warm window light.", line: "Every library keeps its books on the shelf." },
    { prompt: "The same library. One red book has opened its covers like wings and lifts off its shelf.", line: "Until one morning, a single red book opens its covers and flies." },
    { prompt: "The same library. Dozens of books circle the room like a flock of birds, pages fluttering.", line: "Then the whole collection takes flight, circling the reading room." },
    { prompt: "The same library. The shelves stand empty as the last books stream out of the open window.", line: "The shelves stand empty. The stories have gone out into the world." },
  ],
});

describe.skipIf(!checkTools().ffmpeg)("the What if? writer on the Spark's recipe", () => {
  const writer = new Writer();
  const logged: string[] = [];
  let engine: EngineHandle;
  let api: Api;

  beforeAll(async () => {
    engine = await startEngine({ port: 0, dataDir: mkdtempSync(join(tmpdir(), "ns-what-if-writer-")), mock: true, mockSpeed: 0, runner: writer, recipesDir: defaultRecipesDir(), log: (line) => logged.push(line) });
    api = new Api(engine.url);
    await api.install("unified-128-cuda");
  });
  afterAll(async () => {
    await engine?.stop();
  });
  beforeEach(() => {
    writer.answers = [];
  });

  const create = (brief: Record<string, unknown>): Promise<Project> => api.call("POST", "/api/projects", ProjectSchema, { name: "What if test", template: "what_if", aspect: "9:16", brief });
  const jobs = (p: Project) => api.call("GET", `/api/jobs?projectId=${p.id}`, z.array(JobSchema));
  const asks = (since: number) => writer.requests.slice(since).filter((r) => r.step === "text");

  it("asks again with what broke, and when the story still does not come, draws, voices and renders nothing", async () => {
    let project = await create(BOOKS);
    const starter = fallbackWhatIf(BOOKS);
    writer.answers = ["Here is your story!", JSON.stringify({ ...JSON.parse(BOOKS_STORY), keyframes: JSON.parse(BOOKS_STORY).keyframes.slice(0, 3) }), JSON.stringify(starter)];
    const before = writer.requests.length;
    const job = await api.run(`/api/projects/${project.id}/storyboard`);
    expect(job.message).toBe("The writer tried 3 times, but its story did not fit. Nothing was drawn. Try again, or use the starter beats.");
    const tries = asks(before);
    expect(tries).toHaveLength(3);
    expect(String(tries[0]!.values.system)).not.toContain("Your last answer");
    expect(String(tries[1]!.values.system)).toContain("Your last answer was not one JSON object.");
    expect(String(tries[2]!.values.system)).toContain("Your last answer had 3 keyframes. Write exactly four");
    // What it wrote is in the engine's log, so a writer that keeps missing can be seen.
    expect(logged.filter((line) => line.includes(`project ${project.id}: the What if? writer's story`))).toHaveLength(3);
    expect(logged.at(-1)).toContain("repeated the outline word for word");

    await api.settle(project.id);
    project = await api.project(project.id);
    expect(project.shotList).toEqual({ by: "template", note: "The writer tried 3 times, but its story did not fit." });
    // The starter beats are there to edit, with nothing drawn from them.
    expect(project.shots).toHaveLength(1);
    expect(project.shots[0]!.keyframes!.map((frame) => frame.line)).toEqual(starter.keyframes.map((frame) => frame.line));
    expect(project.shots[0]!.keyframes!.every((frame) => !frame.stillAssetId)).toBe(true);
    expect((await jobs(project)).map((j) => j.step)).toEqual(["text"]);
    expect(project.takes).toEqual([]);
    expect(project.assets).toEqual([]);

    // "Use these beats": the beats as they are (here edited by hand) are drawn, voiced and made into the film.
    const shot = project.shots[0]!;
    const keyframes = shot.keyframes!.map((frame, i) => (i === 3 ? { ...frame, line: "And the library is never quiet again." } : frame));
    await api.call("PATCH", `/api/projects/${project.id}`, ProjectSchema, { shots: [{ ...shot, keyframes, line: keyframes.map((f) => f.line).join(" ") }] });
    const askedBefore = asks(0).length;
    const use = await api.run(`/api/projects/${project.id}/storyboard`, { keepStory: true });
    expect(use.message).toBe("Story ready. Drawing your beats.");
    expect(asks(0)).toHaveLength(askedBefore);
    await api.settle(project.id);
    project = await api.project(project.id);
    expect(project.shotList).toEqual({ by: "template" });
    expect(project.shots[0]!.keyframes!.every((frame) => frame.stillAssetId)).toBe(true);
    expect(project.takes).toHaveLength(1);
    const voice = project.assets.find((a) => a.role === "voice");
    expect(voice?.text).toContain("And the library is never quiet again.");
    expect(project.assets.some((a) => a.role === "music")).toBe(true);
  }, 120_000);

  it("refuses to use the beats of a film that has no story yet", async () => {
    const project = await create(BOOKS);
    const refused = await api.refused("POST", `/api/projects/${project.id}/storyboard`, { keepStory: true });
    expect(refused).toEqual({ status: 409, error: "Write the story first." });
  });

  it("rewrites the story on the same film: every take and final stays, and the new film becomes the pick when it lands", async () => {
    let project = await create(GRAVITY);
    // The tested gravity story, as the writer gave it back: a story, drawn and rendered.
    await api.run(`/api/projects/${project.id}/storyboard`);
    await api.settle(project.id);
    project = await api.project(project.id);
    expect(project.shotList).toEqual({ by: "writer" });
    const film = project.shots[0]!;
    const take = project.takes.find((t) => t.rung === "draft")!;
    expect(film.chosenDraftId).toBe(take.id);
    await api.run(`/api/projects/${project.id}/shots/${film.id}/final`, { draftId: take.id, kind: "same_take", mode: "now" });
    project = await api.project(project.id);
    const final = project.takes.find((t) => t.rung === "final")!;
    expect(final.parentTakeId).toBe(take.id);

    writer.answers = [BOOKS_STORY];
    const job = await api.run(`/api/projects/${project.id}/storyboard`);
    expect(job.message).toBe("Story ready");
    // Right after the rewrite, before the new film lands: the same film, its new beats, and its takes and pick.
    let now = await api.project(project.id);
    expect(now.shots.map((s) => s.id)).toEqual([film.id]);
    expect(now.shots[0]!.keyframes![1]!.line).toBe("Until one morning, a single red book opens its covers and flies.");
    expect(now.takes.map((t) => t.id)).toEqual(expect.arrayContaining([take.id, final.id]));
    await api.settle(project.id);
    now = await api.project(project.id);
    expect(now.takes.map((t) => t.id)).toEqual(expect.arrayContaining([take.id, final.id]));
    const drafts = now.takes.filter((t) => t.rung === "draft");
    expect(drafts).toHaveLength(2);
    const fresh = drafts.find((t) => t.id !== take.id)!;
    expect(now.shots[0]!.chosenDraftId).toBe(fresh.id);
    expect(now.shots[0]!.keyframes!.every((frame) => frame.stillAssetId)).toBe(true);
    expect(fresh.guideAssetIds).toEqual(now.shots[0]!.keyframes!.map((frame) => frame.stillAssetId));
    expect(fresh.guideAssetIds).not.toEqual(take.guideAssetIds);
    // The old take still finishes: it was made from its own record.
    const later = await api.run(`/api/projects/${project.id}/shots/${film.id}/final`, { draftId: take.id, kind: "same_take", mode: "now" });
    expect(later.status).toBe("done");
  }, 120_000);

  it("rewrites the story while a final of the film waits for tonight, which goes on", async () => {
    let project = await create(GRAVITY);
    await api.run(`/api/projects/${project.id}/storyboard`);
    await api.settle(project.id);
    project = await api.project(project.id);
    const film = project.shots[0]!;
    const settings = await api.call("GET", "/api/settings", SettingsSchema);
    await api.call("PATCH", "/api/settings", SettingsSchema, { overnight: { ...settings.overnight, enabled: false } });
    try {
      const tonight = await api.job(`/api/projects/${project.id}/shots/${film.id}/final`, { draftId: film.chosenDraftId, kind: "same_take", mode: "overnight" });
      writer.answers = [BOOKS_STORY];
      expect((await api.run(`/api/projects/${project.id}/storyboard`)).message).toBe("Story ready");
      expect((await jobs(project)).find((j) => j.id === tonight.id)?.status).toBe("queued");
      await api.call("POST", `/api/jobs/${tonight.id}/cancel`, JobSchema);
      await api.settle(project.id);
    } finally {
      await api.call("PATCH", "/api/settings", SettingsSchema, { overnight: settings.overnight });
    }
  }, 120_000);

  it("keeps the film as it was when a rewrite's story does not come, and a beat drawn by hand clears the note", async () => {
    let project = await create(GRAVITY);
    await api.run(`/api/projects/${project.id}/storyboard`);
    await api.settle(project.id);
    project = await api.project(project.id);
    const before = (await jobs(project)).length;

    writer.answers = [new Error("The writer ran out of memory")];
    const job = await api.run(`/api/projects/${project.id}/storyboard`);
    expect(job.message).toBe("The writer could not finish: The writer ran out of memory. The story stays as it was.");
    await api.settle(project.id);
    const after = await api.project(project.id);
    expect(after.shots).toEqual(project.shots);
    expect(after.takes).toEqual(project.takes);
    expect(after.shotList).toEqual({ by: "writer", note: "The writer could not finish: The writer ran out of memory." });
    expect(await jobs(project)).toHaveLength(before + 1);

    await api.run(`/api/projects/${project.id}/shots/${project.shots[0]!.id}/still`, { keyframeIndex: 3 });
    expect((await api.project(project.id)).shotList).toEqual({ by: "writer" });
  }, 120_000);
});
