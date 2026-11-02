/**
 * The shot list writer through the engine, with a stand-in writer, on the problems the night of Nov 1 found:
 * - a new film starts with its template's shot list, marked as the template's until the writer writes one;
 * - the Lumi ad's writer gave each of five shots 4 s (a 20 s ad), and the whole answer was thrown away;
 * - a writer that misses is asked again with a note on what broke, and a writer that keeps missing leaves the film as it
 *   was, with a note for the board and no stills drawn from a list nobody chose;
 * - a rewrite once stills exist keeps what was made, off the timeline;
 * - a music video's look reached only shot 1, camera words drew a camera crane, and 6 shots could not fill a 30 s song.
 */
import { JobSchema, ProjectSchema, type Project, type TemplateId } from "@nightshift/contract";
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

/** What the writer answers to one request: a JSON answer, text as written, or an error it throws. */
type Answer = Record<string, unknown> | string | Error | ((req: StepRequest) => Record<string, unknown>);

/** Answers each shot list request with the next of `answers`, then with the template's own list; records every request. */
class Writer implements StepRunner {
  readonly requests: StepRequest[] = [];
  answers: Answer[] = [];
  private readonly mock = new MockStepRunner(0);

  async run(req: StepRequest, ctx: Parameters<StepRunner["run"]>[1]) {
    this.requests.push(req);
    if (req.step !== "text") return this.mock.run(req, ctx);
    const next = this.answers.shift();
    if (next instanceof Error) throw next;
    const answer = typeof next === "function" ? next(req) : (next ?? JSON.parse(String(req.values.fallback)));
    const out = join(req.outDir, "text.json");
    await writeFile(out, typeof answer === "string" ? answer : JSON.stringify(answer));
    return [{ path: out, kind: "text" as const, nodeId: "3" }];
  }

  asks(since: number): StepRequest[] {
    return this.requests.slice(since).filter((r) => r.step === "text");
  }
}

/** The Lumi ad as the Spark's writer wrote it on Nov 1: good lines, and 4 s a shot. */
const LUMI = {
  shots: [
    { prompt: "Close-up of Lumi sunrise lamp glowing softly on a nightstand, casting warm light like dawn.", cameraMove: "static", durationSec: 4, line: "Lumi wakes you gently, no alarm, just sunrise." },
    { prompt: "Overhead shot of the lamp slowly brightening as a person's eyes flutter open, smiling.", cameraMove: "crane_up", durationSec: 4, line: "No more groans. Just calm, golden mornings." },
    { prompt: "Side view of the lamp with a person reaching for their phone, then pausing to stare at the soft glow.", cameraMove: "pan_right", durationSec: 4, line: "Lumi's sunrise? It's the best alarm ever." },
    { prompt: "Lamp on a nightstand beside a coffee cup, morning light.", cameraMove: "dolly_in", durationSec: 4, line: "Wake up like you're in a dream." },
    { prompt: "Lamp glowing in a bedroom with a person stretching, sunlight streaming in.", cameraMove: "handheld", durationSec: 4, line: "Lumi. Because mornings deserve a sunrise, not a scream." },
  ],
};

const LUMI_BRIEF = { productName: "Lumi sunrise lamp", does: "wakes you up with a slow sunrise on your nightstand instead of a screaming alarm", tone: "playful", voice: "theo" };

const FROG_BRIEF = {
  songSource: "write",
  genre: "lofi",
  length: "30",
  songPrompt: "A rainy night adventure, cozy and a little lonely, then joyful as the sky clears",
  subject: "Claymation stop-motion world, handmade plasticine with visible fingerprints. A tiny green clay frog in a yellow raincoat sails a paper boat down a flooded clay street at night.",
};

/** The frog video the way its writer wrote it, with the look named once and camera words in some prompts. */
function frogAnswer(count: number, o: { look?: boolean } = {}) {
  const moments = [
    "A tiny green clay frog in a yellow raincoat sails a paper boat down a flooded clay street at night",
    "The frog's fingers press against the boat's edge as raindrops fall, camera tilts down to show fingerprints on the plasticine street",
    "Clay umbrellas sway in the wind, silhouetted against a glowing moon, camera pans right to follow the boat's drift",
    "The sky clears — clay stars blink into view, frog floats upward, camera crane_up to reveal the starry clay sky",
  ];
  return {
    ...(o.look === false ? {} : { look: "claymation stop-motion, handmade plasticine with visible fingerprints, warm shop light on wet clay" }),
    shots: Array.from({ length: count }, (_, i) => ({ prompt: moments[i % moments.length], cameraMove: "dolly_in", durationSec: 4 })),
  };
}

describe("the shot list writer on the Spark's recipe", () => {
  const writer = new Writer();
  let engine: EngineHandle;
  let api: Api;

  beforeAll(async () => {
    engine = await startEngine({ port: 0, dataDir: mkdtempSync(join(tmpdir(), "ns-writer-")), mock: true, mockSpeed: 0, runner: writer, recipesDir: defaultRecipesDir(), log: () => undefined });
    api = new Api(engine.url);
    await api.install("unified-128-cuda");
  });
  afterAll(async () => {
    await engine?.stop();
  });
  beforeEach(() => {
    writer.answers = [];
  });

  const create = (template: TemplateId, brief: Record<string, unknown>, name = "Writer test"): Promise<Project> => api.call("POST", "/api/projects", ProjectSchema, { name, template, aspect: "9:16", brief });
  const stillsOf = (p: Project, since: number) => writer.requests.slice(since).filter((r) => r.step === "still" && p.shots.some((s) => String(r.values.prompt).includes(s.prompt.slice(0, 30))));

  it("starts a film with the template's list, marked as such, and the writer's list replaces it and draws its stills", async () => {
    const project = await create("product_ad", LUMI_BRIEF);
    expect(project.shotList).toEqual({ by: "template" });
    expect((await create("blank", {})).shotList).toBeUndefined();

    writer.answers = [LUMI];
    const before = writer.requests.length;
    const job = await api.run(`/api/projects/${project.id}/storyboard`);
    // An ad without a product photo draws its product first, as its product reference.
    expect(job.message).toBe("Shot list drafted. Drew Lumi sunrise lamp first, so every shot shows the same one.");
    await api.settle(project.id);
    const p = await api.project(project.id);
    expect(p.shotList).toEqual({ by: "writer" });
    expect(p.references?.map((r) => [r.label, r.kind])).toEqual([["Lumi sunrise lamp", "product"]]);
    // The writer's own lines, in the ad's 15 seconds: five shots of 4 s became five of 3 s.
    expect(p.shots.map((s) => s.line)).toEqual(LUMI.shots.map((s) => s.line));
    expect(p.shots.map((s) => s.durationSec)).toEqual([3, 3, 3, 3, 3]);
    expect(p.shots.every((s) => s.stillAssetId)).toBe(true);
    expect(writer.asks(before)).toHaveLength(1);
  });

  it("asks the writer again with a note on what broke, for every template", async () => {
    const project = await create("product_ad", LUMI_BRIEF);
    writer.answers = [{ shots: LUMI.shots.map(({ line: _, ...shot }) => shot) }, { shots: LUMI.shots.slice(0, 3) }, LUMI];
    const before = writer.requests.length;
    const job = await api.run(`/api/projects/${project.id}/storyboard`);
    expect(job.message).toMatch(/^Shot list drafted\./);
    const asks = writer.asks(before);
    expect(asks).toHaveLength(3);
    expect(String(asks[0]!.values.system)).not.toContain("Your last answer");
    expect(String(asks[1]!.values.system)).toContain("No shot had a voiceover line. Give most shots one short line.");
    expect(String(asks[2]!.values.system)).toMatch(/Your last answer had 3 shots\. Write exactly 5 separate objects/);
    // Each ask with its own seed: the same input gets the same answer.
    const seed = Number(asks[0]!.values.seed);
    expect(asks.map((r) => r.values.seed)).toEqual([seed, seed + 1, seed + 2]);
    expect((await api.project(project.id)).shotList).toEqual({ by: "writer" });
  });

  it("leaves the film as it was when the writer keeps missing: a note for the board, and no stills from a list nobody chose", async () => {
    const project = await create("product_ad", LUMI_BRIEF);
    writer.answers = ["I cannot help with that.", { shots: [] }, { shots: LUMI.shots.slice(0, 2) }];
    const before = writer.requests.length;
    const job = await api.run(`/api/projects/${project.id}/storyboard`);
    expect(job.message).toBe("The writer tried 3 times, but its shot list did not fit this template. The template's shot list stays.");
    expect(String(writer.asks(before)[1]!.values.system)).toContain("Your last answer was not a JSON object with a shots array.");
    await api.settle(project.id);
    let p = await api.project(project.id);
    expect(p.shotList).toEqual({ by: "template", note: "The writer tried 3 times, but its shot list did not fit this template." });
    expect(p.shots.map((s) => s.id)).toEqual(project.shots.map((s) => s.id));
    expect((await api.call("GET", `/api/jobs?projectId=${project.id}`, z.array(JobSchema))).map((j) => j.step)).toEqual(["text"]);

    // A writer that fails outright says so the same way.
    writer.answers = [new Error("the language model ran out of memory"), new Error("again"), new Error("and again")];
    expect((await api.run(`/api/projects/${project.id}/storyboard`)).message).toBe("The writer failed: the language model ran out of memory. The template's shot list stays.");
    expect((await api.project(project.id)).shotList?.note).toBe("The writer failed: the language model ran out of memory.");

    // Trying again with a writer that fits clears the note and draws the stills.
    writer.answers = [LUMI];
    await api.run(`/api/projects/${project.id}/storyboard`);
    await api.settle(project.id);
    p = await api.project(project.id);
    expect(p.shotList).toEqual({ by: "writer" });
    expect(p.shots.filter((s) => s.onTimeline !== false).every((s) => s.stillAssetId)).toBe(true);
  });

  it("keeps a written list when a rewrite misses, and the note can be dismissed", async () => {
    const project = await create("product_ad", LUMI_BRIEF);
    writer.answers = [LUMI];
    await api.run(`/api/projects/${project.id}/storyboard`);
    await api.settle(project.id);
    const written = await api.project(project.id);
    writer.answers = [{ shots: [] }, { shots: [] }, { shots: [] }];
    const job = await api.run(`/api/projects/${project.id}/storyboard`);
    expect(job.message).toBe("The writer tried 3 times, but its shot list did not fit this template. The shot list stays as it was.");
    const p = await api.project(project.id);
    expect(p.shotList).toEqual({ by: "writer", note: "The writer tried 3 times, but its shot list did not fit this template." });
    expect(p.shots).toEqual(written.shots);
    const dismissed = await api.call("PATCH", `/api/projects/${project.id}`, ProjectSchema, { shotList: { by: "writer" } });
    expect(dismissed.shotList).toEqual({ by: "writer" });
  });

  it("rewrites a drawn list without losing what was made: locked shots stay, others with a still or a take leave the timeline", async () => {
    const project = await create("product_ad", LUMI_BRIEF);
    writer.answers = [LUMI];
    await api.run(`/api/projects/${project.id}/storyboard`);
    await api.settle(project.id);
    let p = await api.project(project.id);
    const [first, second] = p.shots;
    await api.run(`/api/projects/${project.id}/shots/${second!.id}/draft`);
    p = await api.call("PATCH", `/api/projects/${project.id}`, ProjectSchema, { shots: p.shots.map((s) => (s.id === first!.id ? { ...s, locked: true } : s)) });

    writer.answers = [{ shots: LUMI.shots.map((s) => ({ ...s, prompt: `New: ${s.prompt}` })) }];
    await api.run(`/api/projects/${project.id}/storyboard`);
    await api.settle(project.id);
    p = await api.project(project.id);
    const timeline = p.shots.filter((s) => s.onTimeline !== false);
    expect(timeline[0]!.id).toBe(first!.id);
    expect(timeline.slice(1).every((s) => s.prompt.startsWith("New: "))).toBe(true);
    // The four replaced shots had stills (one a draft too): they stay, off the timeline, with their take.
    const aside = p.shots.filter((s) => s.onTimeline === false);
    expect(aside).toHaveLength(4);
    expect(aside.every((s) => s.stillAssetId && !s.prompt.startsWith("New: "))).toBe(true);
    expect(p.takes.some((t) => t.shotId === second!.id)).toBe(true);
    // On the board they follow the new list.
    expect(p.boards![0]!.items.slice(-4)).toEqual(aside.map((s) => s.id));
  });

  it("plans a music video to fill its song, with its look on every still and no camera words in them", async () => {
    const project = await create("music_video", FROG_BRIEF, "Paper Boat Frog");
    // 30 s of lo-fi at 84 bpm in clips of at most 4.04 s: one bar a shot, 11 shots.
    expect(project.shots.map((s) => s.durationSec)).toEqual(Array(11).fill(2.86));
    writer.answers = [frogAnswer(6), (req) => frogAnswer(Number(/Return exactly (\d+) shots/.exec(String(req.values.system))?.[1]))];
    const before = writer.requests.length;
    await api.run(`/api/projects/${project.id}/storyboard`);
    await api.settle(project.id);
    const asks = writer.asks(before);
    expect(String(asks[0]!.values.system)).toContain("Return exactly 11 shots, each 2.86 seconds long, for a 30 second song.");
    expect(String(asks[0]!.values.system)).toContain('"look":"the look every shot shares');
    expect(String(asks[1]!.values.system)).toMatch(/Your last answer had 6 shots\. Write exactly 11 separate objects/);
    // The recipe's own room for the writer (1536 tokens on the Spark) stands when it is more than the list needs.
    expect(asks[0]!.values.maxTokens).toBe(1536);

    const p = await api.project(project.id);
    expect(p.shots).toHaveLength(11);
    expect(p.shots.map((s) => s.durationSec)).toEqual(Array(11).fill(2.86));
    expect(p.brief.style).toBe("claymation stop-motion, handmade plasticine with visible fingerprints, warm shop light on wet clay");
    const stills = stillsOf(p, before);
    expect(stills).toHaveLength(11);
    for (const still of stills) {
      expect(String(still.values.prompt)).toContain("Claymation stop-motion, handmade plasticine with visible fingerprints, warm shop light on wet clay.");
      expect(String(still.values.prompt)).not.toMatch(/camera|crane_up|pans right/i);
    }
    expect(p.shots[3]!.prompt).toBe("The sky clears — clay stars blink into view, frog floats upward.");
    // A draft hears the move, and the look.
    await api.run(`/api/projects/${project.id}/shots/${p.shots[3]!.id}/draft`);
    const draft = writer.requests.filter((r) => r.step === "video_draft").at(-1)!;
    expect(String(draft.values.prompt)).toBe("The sky clears — clay stars blink into view, frog floats upward. The camera slowly dollies in. Claymation stop-motion, handmade plasticine with visible fingerprints, warm shop light on wet clay. Music video, bold color, stylized lighting, anamorphic lens.");
  });

  it("takes the brief's world as a music video's look when the writer names none", async () => {
    const project = await create("music_video", FROG_BRIEF, "Paper Boat Frog");
    writer.answers = [frogAnswer(11, { look: false })];
    await api.run(`/api/projects/${project.id}/storyboard`);
    expect((await api.project(project.id)).brief.style).toBe(FROG_BRIEF.subject.replace(/\.$/, ""));
  });
});

describe("the shot list writer on an 8 GB card", () => {
  const writer = new Writer();
  let engine: EngineHandle;
  let api: Api;

  beforeAll(async () => {
    engine = await startEngine({ port: 0, dataDir: mkdtempSync(join(tmpdir(), "ns-writer-8-")), mock: true, mockSpeed: 0, runner: writer, recipesDir: defaultRecipesDir(), log: () => undefined });
    api = new Api(engine.url);
    await api.install("nvidia-8");
  });
  afterAll(async () => {
    await engine?.stop();
  });

  it("gives the writer room for every shot the music video needs, past the workflow's 384 tokens", async () => {
    const project = await api.call("POST", "/api/projects", ProjectSchema, { name: "Frog", template: "music_video", aspect: "9:16", brief: FROG_BRIEF });
    // Kandinsky 6 Lite makes clips of at most 2.04 s: two beats of 84 bpm a shot, 21 shots for 30 s.
    expect(project.shots.map((s) => s.durationSec)).toEqual(Array(21).fill(1.43));
    const before = writer.requests.length;
    await api.run(`/api/projects/${project.id}/storyboard`);
    const ask = writer.asks(before)[0]!;
    expect(String(ask.values.system)).toContain("Return exactly 21 shots, each 1.43 seconds long, for a 30 second song.");
    expect(ask.values.maxTokens).toBe(200 + 21 * 80);
  });
});
