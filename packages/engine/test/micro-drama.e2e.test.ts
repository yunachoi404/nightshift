/**
 * A micro drama through the engine on the Spark's recipe, with a stand-in writer: the shot list it writes, the cast it
 * draws when the project has no character photos (each a portrait that becomes a character reference every still is
 * drawn from), and the lines its drafts say. A project that brings its own characters casts nobody.
 */
import { ProjectSchema, type Project } from "@nightshift/contract";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, type EngineHandle } from "../src/engine.js";
import { defaultRecipesDir } from "../src/paths.js";
import { MockStepRunner } from "../src/runner/mock.js";
import type { StepRequest, StepRunner } from "../src/runner/types.js";
import { Api } from "./flow.js";

const SCENE = {
  setting: "a hotel lobby cafe at night, warm lamps, rain on the glass",
  characters: [
    { name: "Hana", look: "mid twenties, high ponytail, cream trench coat" },
    { name: "Daniel", look: "late twenties, slicked black hair, navy three-piece suit." },
  ],
  shots: [
    { prompt: "Wide shot of a lobby cafe at night, Hana behind the counter, Daniel walking in", cameraMove: "dolly_in", durationSec: 3 },
    { prompt: "Medium close-up of Daniel at the counter, cold stare", cameraMove: "static", durationSec: 3.5, line: "You again? I fired you this morning." },
    { prompt: "Close-up of Hana, sliding a coffee across", cameraMove: "static", durationSec: 3.5, line: "You did. Then I bought your company." },
    { prompt: "Two-shot, Daniel frozen, Hana smiling", cameraMove: "dolly_in", durationSec: 4, line: "That's impossible." },
    { prompt: "Extreme close-up of Hana", cameraMove: "dolly_in", durationSec: 4, line: "Welcome to your first day, intern." },
  ],
};

/**
 * Writes the scene above (with its cast only when asked to cast), and records every request. With `stumbles`, its
 * first answers run the shots together under repeated keys, as Qwen3-VL did on the Spark.
 */
class Writer implements StepRunner {
  readonly requests: StepRequest[] = [];
  stumbles = 0;
  private readonly mock = new MockStepRunner(0);

  async run(req: StepRequest, ctx: Parameters<StepRunner["run"]>[1]) {
    this.requests.push(req);
    if (req.step !== "text") return this.mock.run(req, ctx);
    const casting = String(req.values.system).includes('"characters"');
    const out = join(req.outDir, "text.json");
    if (this.stumbles > 0) {
      this.stumbles--;
      await writeFile(out, '{"setting":"a cafe","shots":[{"prompt":"Hana at the counter","line":""},{"prompt":"Daniel stares","line":"You fired me.","line":"I bought it."}]}');
      return [{ path: out, kind: "text" as const, nodeId: "3" }];
    }
    await writeFile(out, JSON.stringify(casting ? SCENE : { shots: SCENE.shots }));
    return [{ path: out, kind: "text" as const, nodeId: "3" }];
  }
}

describe("a micro drama on the Spark's recipe", () => {
  const writer = new Writer();
  let engine: EngineHandle;
  let api: Api;

  beforeAll(async () => {
    engine = await startEngine({ port: 0, dataDir: mkdtempSync(join(tmpdir(), "ns-drama-")), mock: true, mockSpeed: 0, runner: writer, recipesDir: defaultRecipesDir(), log: () => undefined });
    api = new Api(engine.url);
    await api.install("unified-128-cuda");
  });
  afterAll(async () => {
    await engine?.stop();
  });

  async function create(): Promise<Project> {
    return api.call("POST", "/api/projects", ProjectSchema, { name: "The new owner", template: "micro_drama", aspect: "9:16", brief: { premise: "The barista he fired just bought his company", look: "anime", mood: "comedy" } });
  }

  it("casts its own characters without photos, draws every still from them, and has each draft say its line", async () => {
    const project = await create();
    const job = await api.run(`/api/projects/${project.id}/storyboard`);
    expect(job.message).toBe("Shot list drafted. Cast Hana and Daniel.");
    await api.settle(project.id);
    let p = await api.project(project.id);

    // Two portraits, in the scene's look, are the project's character references.
    const portraits = writer.requests.filter((r) => r.step === "still" && String(r.values.prompt).startsWith("Half-body portrait of"));
    expect(portraits.map((r) => String(r.values.prompt).split(",")[0])).toEqual(["Half-body portrait of Hana", "Half-body portrait of Daniel"]);
    expect(String(portraits[1]!.values.prompt)).toContain("late twenties, slicked black hair, navy three-piece suit, facing the camera");
    expect(String(portraits[0]!.values.prompt)).toContain("2D anime film style");
    expect(p.references?.map((r) => [r.label, r.kind])).toEqual([["Hana", "character"], ["Daniel", "character"]]);
    for (const ref of p.references!) expect(p.assets.find((a) => a.id === ref.assetId)?.role).toBe("reference");

    // Every still stays in the scene's setting, and is drawn from the portraits of the characters its shot names: both
    // in the wide shot and the two-shot, one in a close-up.
    const stills = writer.requests.filter((r) => r.step === "still" && !String(r.values.prompt).startsWith("Half-body portrait of"));
    expect(stills).toHaveLength(5);
    expect(stills.map((s) => [s.values.image, s.values.image2].filter(Boolean).length)).toEqual([2, 1, 1, 2, 1]);
    expect(p.shots.map((s) => s.referenceIds?.length ?? null)).toEqual([null, 1, 1, null, 1]);
    expect(p.brief.setting).toBe(SCENE.setting);
    for (const still of stills) {
      expect(String(still.values.prompt)).toContain("A hotel lobby cafe at night, warm lamps, rain on the glass.");
      // A still never carries the spoken line: image models paint quoted words.
      expect(String(still.values.prompt)).not.toMatch(/fired you|bought your company|impossible|first day/);
    }
    expect(p.shots.map((s) => s.line ?? null)).toEqual([null, ...SCENE.shots.slice(1).map((s) => s.line)]);

    // A draft says its shot's line, in quotes, in the comedy's delivery.
    await api.run(`/api/projects/${project.id}/shots/${p.shots[4]!.id}/draft`);
    const draft = writer.requests.filter((r) => r.step === "video_draft").at(-1)!;
    expect(String(draft.values.prompt)).toContain('Hana says deadpan, perfectly timed, "Welcome to your first day, intern." Their lips move with every word.');
    p = await api.project(project.id);
    const take = p.takes.find((t) => t.shotId === p.shots[4]!.id)!;
    expect(take.prompt).toBe(String(draft.values.prompt));

    // Its final, on the Spark, renders the same take at four times the draft's size.
    await api.run(`/api/projects/${project.id}/shots/${take.shotId}/final`, { draftId: take.id, kind: "same_take", mode: "now" });
    const final = writer.requests.filter((r) => r.step === "video_final_same_take").at(-1)!;
    expect(final.ref.workflow).toBe("ltx25_same_take_hd.api.json");
    expect(final.values.prompt).toBe(draft.values.prompt);
  });

  it("asks the writer again, with another seed, when its answer breaks the shape", async () => {
    writer.stumbles = 2;
    const project = await create();
    const before = writer.requests.length;
    const job = await api.run(`/api/projects/${project.id}/storyboard`);
    expect(job.message).toMatch(/^Shot list drafted\./);
    const asks = writer.requests.slice(before).filter((r) => r.step === "text");
    const first = Number(asks[0]!.values.seed);
    expect(asks.map((r) => r.values.seed)).toEqual([first, first + 1, first + 2]);
    // The writer answers the same input the same way, so each new ask says what broke.
    expect(asks.map((r) => String(r.values.system).includes("Your last answer had 2 shots. Write exactly 5 separate objects in the shots array, one per shot"))).toEqual([false, true, true]);
    expect((await api.project(project.id)).shots.map((s) => s.line ?? null)).toEqual([null, ...SCENE.shots.slice(1).map((s) => s.line)]);
  });

  it("casts nobody when the project brings its characters, and tells the writer their names instead", async () => {
    const project = await create();
    const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"));
    const a = await api.upload(project.id, png, "mina.png", "image/png", "reference");
    await api.call("PATCH", `/api/projects/${project.id}`, ProjectSchema, { references: [{ id: "ref_mina", label: "Mina", kind: "character", assetId: a.id }] });
    const before = writer.requests.length;
    const job = await api.run(`/api/projects/${project.id}/storyboard`);
    expect(job.message).toBe("Shot list drafted.");
    const text = writer.requests.slice(before).find((r) => r.step === "text")!;
    expect(String(text.values.system)).not.toContain('"characters"');
    expect(String(text.values.system)).toContain('Available visual references: "Mina" (character).');
    // Her look comes from her photo, so the writer is told not to describe it.
    expect(String(text.values.system)).toContain("face, hair and clothes come from their photo, so never describe them");
    const p = await api.project(project.id);
    expect(p.references?.map((r) => r.label)).toEqual(["Mina"]);
  });
});
