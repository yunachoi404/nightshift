/**
 * References where they are needed, on the Spark's recipe with a stand-in writer: a card's still made a reference (a
 * copy of its own), an edit that keeps the shot's references, edit cards that start with none, and a product ad
 * without a product photo that draws its product first and draws every still from it.
 */
import { ProjectSchema, type Project } from "@nightshift/contract";
import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, type EngineHandle } from "../src/engine.js";
import { placeholderScene } from "../src/media/png.js";
import { defaultRecipesDir } from "../src/paths.js";
import { MockStepRunner } from "../src/runner/mock.js";
import type { StepRequest, StepRunner } from "../src/runner/types.js";
import { Api } from "./flow.js";

const AD = {
  product: "a frosted glass dome on a round oak base, warm amber glow",
  shots: [
    { prompt: "The Lumi sunrise lamp on a nightstand at dawn", cameraMove: "dolly_in", durationSec: 3, line: "Meet Lumi." },
    { prompt: "A sleeper's face in soft orange light", cameraMove: "static", durationSec: 2.5, line: "It wakes you slowly." },
    { prompt: "An alarm clock tossed in a bin", cameraMove: "static", durationSec: 3.5, line: "No more screaming alarms." },
    { prompt: "A woman stretching by the window, grinning", cameraMove: "static", durationSec: 3, line: "Just light." },
    { prompt: "The lamp on a peach backdrop", cameraMove: "static", durationSec: 3, line: "Lumi sunrise lamp." },
  ],
};

/** Writes the ad above (its product's look only when asked for it), and records every request. */
class Writer implements StepRunner {
  readonly requests: StepRequest[] = [];
  private readonly mock = new MockStepRunner(0);

  async run(req: StepRequest, ctx: Parameters<StepRunner["run"]>[1]) {
    this.requests.push(req);
    if (req.step !== "text") return this.mock.run(req, ctx);
    const out = join(req.outDir, "text.json");
    const asked = String(req.values.system).includes('"product"');
    await writeFile(out, JSON.stringify(asked ? AD : { shots: AD.shots }));
    return [{ path: out, kind: "text" as const, nodeId: "3" }];
  }
}

describe("references on cards, on the Spark's recipe", () => {
  const writer = new Writer();
  let engine: EngineHandle;
  let api: Api;
  const png = (label: string) => new Uint8Array(placeholderScene(64, 64, label).toPng());

  beforeAll(async () => {
    engine = await startEngine({ port: 0, dataDir: mkdtempSync(join(tmpdir(), "ns-card-refs-")), mock: true, mockSpeed: 0, runner: writer, recipesDir: defaultRecipesDir(), log: () => undefined });
    api = new Api(engine.url);
    await api.install("unified-128-cuda");
  });
  afterAll(async () => {
    await engine?.stop();
  });

  /** A blank project with one drawn card on a second board. */
  async function drawnCard(): Promise<{ project: Project; shotId: string; boardId: string }> {
    const project = await api.call("POST", "/api/projects", ProjectSchema, { name: "Frog", template: "blank", aspect: "9:16" });
    const withBoards = await api.call("PATCH", `/api/projects/${project.id}`, ProjectSchema, { boards: [{ id: "b1", name: "Shots", items: [] }, { id: "b2", name: "Scenes", items: [] }] });
    const job = await api.run(`/api/projects/${withBoards.id}/make`, { tool: "image", prompt: "A clay frog in a yellow raincoat", boardId: "b2" });
    return { project: await api.project(project.id), shotId: job.shotId!, boardId: "b2" };
  }

  it("makes a card's still a reference: a copy of its own, on the card's board, that redraws cannot change", async () => {
    const { project, shotId, boardId } = await drawnCard();
    const still = project.shots.find((s) => s.id === shotId)!.stillAssetId!;
    const p = await api.call("POST", `/api/projects/${project.id}/references`, ProjectSchema, { assetId: still, kind: "character", label: "Frog" });
    const ref = p.references!.at(-1)!;
    expect(ref).toMatchObject({ kind: "character", label: "Frog", copiedFrom: still });
    expect(ref.assetId).not.toBe(still);
    const copy = p.assets.find((a) => a.id === ref.assetId)!;
    expect(copy).toMatchObject({ kind: "image", role: "reference" });
    expect(p.boards!.find((b) => b.id === boardId)!.items).toContain(copy.id);
    const bytes = async (id: string) => Buffer.from(await (await fetch(`${engine.url}/api/projects/${p.id}/assets/${id}`)).arrayBuffer());
    expect((await bytes(copy.id)).equals(await bytes(still))).toBe(true);

    // The next still of any card that did not choose its references is drawn from it.
    const before = writer.requests.length;
    await api.run(`/api/projects/${p.id}/shots/${shotId}/still`, { prompt: "The frog paddles a paper boat" });
    const drawn = writer.requests.slice(before).find((r) => r.step === "still")!;
    expect(drawn.ref.workflow).toBe("references_klein4b.api.json");
    expect(await readFile(String(drawn.values.image))).toEqual(await bytes(copy.id));

    // The same image twice, or something that is not an image of the project, is refused.
    for (const assetId of [copy.id, still]) expect(await api.refused("POST", `/api/projects/${p.id}/references`, { assetId, kind: "character", label: "Again" })).toMatchObject({ status: 409, error: "That image is already the reference Frog." });
    expect((await api.refused("POST", `/api/projects/${p.id}/references`, { assetId: "ast_nope", kind: "style", label: "Nope" })).status).toBe(404);
    expect((await api.refused("POST", `/api/projects/${p.id}/references`, { assetId: still, kind: "style", label: " " })).status).toBe(400);
  });

  it("keeps the shot's references in an edit, the edited image first, and refuses more than the edit has room for", async () => {
    const { project, shotId } = await drawnCard();
    const still = project.shots.find((s) => s.id === shotId)!.stillAssetId!;
    const refs: string[] = [];
    for (const name of ["Rin", "Mochi", "Shop"]) {
      const a = await api.upload(project.id, png(name), `${name}.png`, "image/png", "reference");
      refs.push(a.id);
    }
    let p = await api.call("PATCH", `/api/projects/${project.id}`, ProjectSchema, {
      references: [
        { id: "rin", assetId: refs[0], kind: "character", label: "Rin" },
        { id: "mochi", assetId: refs[1], kind: "character", label: "Mochi" },
        { id: "shop", assetId: refs[2], kind: "place", label: "The shop" },
      ],
    });

    // A card that never chose keeps the first two: the edited image takes the third place.
    let before = writer.requests.length;
    await api.run(`/api/projects/${p.id}/shots/${shotId}/still`, { prompt: "She crosses her arms", editFrom: still });
    let edit = writer.requests.slice(before).find((r) => r.step === "still")!;
    expect(edit.ref.workflow).toBe("references_klein4b.api.json");
    expect(String(edit.values.image)).toContain(still);
    expect([edit.values.image2, edit.values.image3].map((v) => String(v).split("/").pop()!.split(".")[0])).toEqual([refs[0], refs[1]]);
    expect(String(edit.values.prompt)).toBe('Image 1 is the picture to change. Image 2 is "Rin" (character). Image 3 is "Mochi" (character). Change image 1: She crosses her arms. Keep everything else in image 1 as it is: the framing, the setting and the light. Wherever a reference appears in image 1, give it the look of its image: each character\'s face, hair and clothing, each product\'s shape and materials. Names identify subjects only. Do not add lettering.');
    p = await api.project(p.id);
    // The history keeps the user's words, not the engineered prompt.
    expect(p.shots.find((s) => s.id === shotId)!.stillHistory!.at(-1)!.prompt).toBe("She crosses her arms");

    // Three chosen on the card are one too many for an edit; switching one off fixes it.
    const shots = (ids: string[]) => p.shots.map((s) => (s.id === shotId ? { ...s, referenceIds: ids } : s));
    p = await api.call("PATCH", `/api/projects/${p.id}`, ProjectSchema, { shots: shots(["rin", "mochi", "shop"]) });
    expect(await api.refused("POST", `/api/projects/${p.id}/shots/${shotId}/still`, { prompt: "Night", editFrom: still })).toEqual({ status: 409, error: "An edit keeps up to 2 references beside the image. Switch one off for this shot." });
    p = await api.call("PATCH", `/api/projects/${p.id}`, ProjectSchema, { shots: shots(["mochi"]) });
    before = writer.requests.length;
    await api.run(`/api/projects/${p.id}/shots/${shotId}/still`, { prompt: "Night", editFrom: still });
    edit = writer.requests.slice(before).find((r) => r.step === "still")!;
    expect(String(edit.values.image2)).toContain(refs[1]);
    expect(edit.values.image3).toBeUndefined();

    // None chosen: the plain edit step, as before.
    p = await api.call("PATCH", `/api/projects/${p.id}`, ProjectSchema, { shots: shots([]) });
    before = writer.requests.length;
    await api.run(`/api/projects/${p.id}/shots/${shotId}/still`, { prompt: "Night", editFrom: still });
    edit = writer.requests.slice(before).find((r) => r.step === "effect_end_frame")!;
    expect(edit.values.prompt).toBe("Night");
    expect(edit.values.image2).toBeUndefined();

    // A card made with the edit tool starts with no references, unless the request names some.
    const tool = await api.run(`/api/projects/${p.id}/make`, { tool: "edit", imageAssetId: still, prompt: "Make it snow" });
    expect(writer.requests.at(-1)!.step).toBe("effect_end_frame");
    p = await api.project(p.id);
    expect(p.shots.find((s) => s.id === tool.shotId)!.referenceIds).toEqual([]);
    const named = await api.run(`/api/projects/${p.id}/make`, { tool: "edit", imageAssetId: still, prompt: "Make it snow", referenceIds: ["rin"] });
    expect(writer.requests.at(-1)!.ref.workflow).toBe("references_klein4b.api.json");
    expect((await api.project(p.id)).shots.find((s) => s.id === named.shotId)!.referenceIds).toEqual(["rin"]);
  });

  it("draws a product ad's product first when it has no photo, and draws every still and the end card from it", async () => {
    const project = await api.call("POST", "/api/projects", ProjectSchema, { name: "Lumi ad", template: "product_ad", aspect: "9:16", brief: { productName: "Lumi sunrise lamp", does: "wakes you up with a slow sunrise", tone: "playful" } });
    const before = writer.requests.length;
    const job = await api.run(`/api/projects/${project.id}/storyboard`);
    expect(job.message).toBe("Shot list drafted. Drew Lumi sunrise lamp first, so every shot shows the same one.");
    await api.settle(project.id);
    const asked = writer.requests.slice(before);
    expect(String(asked.find((r) => r.step === "text")!.values.system)).toContain('There is no product photo, so design the product yourself: add "product"');

    // One square product photo, from the writer's description, is the product reference and the end card's photo.
    const stills = asked.filter((r) => r.step === "still");
    expect(String(stills[0]!.values.prompt)).toBe("Product photo of Lumi sunrise lamp, a frosted glass dome on a round oak base, warm amber glow. The whole product alone in the middle of the frame, on a plain soft grey studio background, soft even light, crisp detail. No lettering, labels or logos.");
    expect(stills[0]!.values.width).toBe(stills[0]!.values.height);
    const p = await api.project(project.id);
    expect(p.references?.map((r) => [r.label, r.kind])).toEqual([["Lumi sunrise lamp", "product"]]);
    const product = p.references![0]!;
    expect(p.assets.find((a) => a.id === product.assetId)?.role).toBe("reference");
    expect(p.brief.referenceAssetId).toBe(product.assetId);

    // Every shot's still is drawn from it.
    const shots = stills.slice(1);
    expect(shots).toHaveLength(5);
    for (const still of shots) {
      expect(still.ref.workflow).toBe("references_klein4b.api.json");
      expect(String(still.values.image)).toContain(product.assetId);
    }

    // Asked again, the ad has its product: nothing more is drawn first.
    const again = await api.run(`/api/projects/${project.id}/storyboard`);
    expect(again.message).toBe("Shot list drafted.");
    expect((await api.project(project.id)).references).toHaveLength(1);
  });

  it("does not draw a product for an ad that brings its photo", async () => {
    const project = await api.call("POST", "/api/projects", ProjectSchema, { name: "Mug ad", template: "product_ad", aspect: "9:16", brief: { productName: "Mug", does: "keeps coffee hot" } });
    const photo = await api.upload(project.id, png("Mug"), "mug.png", "image/png", "reference");
    await api.call("PATCH", `/api/projects/${project.id}`, ProjectSchema, { references: [{ id: "mug", assetId: photo.id, kind: "product", label: "Mug" }] });
    const before = writer.requests.length;
    expect((await api.run(`/api/projects/${project.id}/storyboard`)).message).toBe("Shot list drafted.");
    expect(String(writer.requests.slice(before).find((r) => r.step === "text")!.values.system)).not.toContain('"product"');
    expect((await api.project(project.id)).references?.map((r) => r.label)).toEqual(["Mug"]);
  });
});
