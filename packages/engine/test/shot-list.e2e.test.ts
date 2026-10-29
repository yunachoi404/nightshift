/**
 * The shot list asks only for what its template uses. On an 8 GB card the local LLM writes about two tokens a second,
 * and asked for an optional voiceover line it filled every cinematic shot's line with the whole brief: three minutes of
 * an eight-minute list, for lines nothing reads. Cinematic shots and music videos now ask for no line, and a line
 * written anyway is dropped; a product ad asks for short ones and a talking intro for its script, as written.
 */
import { ProjectSchema, type Project, type TemplateId } from "@nightshift/contract";
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

const BRIEF = "A red motorcycle parked on wet cobblestones at night, neon cafe sign, rain.";

/** Answers the shot list as Qwen3-VL 4B did on an RTX 2080 SUPER: every shot's line is the brief. */
class WriterLikeQwen implements StepRunner {
  readonly systems = new Map<string, string>();
  private readonly mock = new MockStepRunner(0);

  async run(req: StepRequest, ctx: Parameters<StepRunner["run"]>[1]) {
    if (req.step !== "text") return this.mock.run(req, ctx);
    const system = String(req.values.system);
    this.systems.set(String(req.values.prompt).split("\n")[0]!, system);
    const count = Number(/Return exactly (\d+) shots/.exec(system)?.[1] ?? 1);
    const plan = JSON.parse(String(req.values.fallback)) as { shots: Array<Record<string, unknown>> };
    const shots = plan.shots.slice(0, count).map((s) => ({ ...s, line: s.line ?? BRIEF }));
    const out = join(req.outDir, "text.json");
    await writeFile(out, JSON.stringify({ shots }));
    return [{ path: out, kind: "text" as const, nodeId: "3" }];
  }
}

describe("the shot list on the 8 GB recipe", () => {
  const writer = new WriterLikeQwen();
  let engine: EngineHandle;
  let api: Api;

  beforeAll(async () => {
    engine = await startEngine({ port: 0, dataDir: mkdtempSync(join(tmpdir(), "ns-shotlist-")), mock: true, mockSpeed: 0, runner: writer, recipesDir: defaultRecipesDir(), log: () => undefined });
    api = new Api(engine.url);
    await api.install("nvidia-8");
  });
  afterAll(async () => {
    await engine?.stop();
  });

  async function storyboard(template: TemplateId, brief: Record<string, unknown>): Promise<Project> {
    const project = await api.call("POST", "/api/projects", ProjectSchema, { name: "Rain Rider", template, aspect: "16:9", brief });
    const job = await api.job(`/api/projects/${project.id}/storyboard`);
    expect(await api.wait(job.id, 20_000)).toMatchObject({ status: "done", message: expect.stringMatching(/^Shot list drafted\./) });
    return api.call("GET", `/api/projects/${project.id}`, ProjectSchema);
  }

  it("a cinematic sequence asks for no voiceover line, and keeps none it is given", async () => {
    const project = await storyboard("cinematic_shot", { idea: BRIEF, sequence: "three", look: "neon", cameraMove: "dolly_in" });
    const system = writer.systems.get("Template: Cinematic shot")!;
    expect(system).not.toMatch(/"line"|voiceover|spoken words/i);
    expect(project.shots).toHaveLength(3);
    expect(project.shots.map((s) => s.line)).toEqual([undefined, undefined, undefined]);
    // And each shot is as long as one Kandinsky 6 Lite draft.
    expect(project.shots.map((s) => s.durationSec)).toEqual([2.04, 2.04, 2.04]);
  });

  it("a music video asks for no line either", async () => {
    await storyboard("music_video", { songSource: "write", songPrompt: "night ride", subject: BRIEF, genre: "synth", length: "30" });
    expect(writer.systems.get("Template: Music video")).not.toMatch(/"line"|voiceover/i);
  });

  it("a product ad asks for short lines, and a talking intro for its script as written", async () => {
    await storyboard("product_ad", { productName: "Ember mug", does: "keeps coffee hot for three hours", tone: "warm", voice: "mara" });
    expect(writer.systems.get("Template: Product ad")).toContain('"line":"the voiceover over this shot, one short sentence of at most 12 words, or empty"');
    await storyboard("talking_intro", { script: "Hi, I'm making a show about slow things. Each week, one idea.", voice: "mara", visuals: "match" });
    const intro = writer.systems.get("Template: Talking intro")!;
    expect(intro).toContain('"line":"the script line this shot shows, exactly as written"');
    expect(intro).toContain("Keep every script sentence verbatim.");
  });
});
