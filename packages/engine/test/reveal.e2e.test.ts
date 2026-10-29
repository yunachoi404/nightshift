/**
 * The reveal share clip through the engine (mock GPU, real editor): a shot with a same-take final gets an export
 * job that carries the shot, files a "reveal" asset of the asked shape, and refuses shots that cannot be revealed.
 */
import { JobSchema, ProjectSchema, type Project } from "@nightshift/contract";
import { checkTools } from "@nightshift/editor";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, type EngineHandle } from "../src/engine.js";
import { findFfmpeg, probeMedia } from "../src/media/ffmpeg.js";
import { defaultRecipesDir } from "../src/paths.js";
import { Api } from "./flow.js";

const tools = checkTools();
const canRender = !!(await findFfmpeg()) && !!tools.chrome;
const dataDir = mkdtempSync(join(tmpdir(), "ns-reveal-"));

let engine: EngineHandle;
let api: Api;

beforeAll(async () => {
  engine = await startEngine({ port: 0, dataDir, mock: true, mockSpeed: 0, recipesDir: defaultRecipesDir(), log: () => undefined });
  api = new Api(engine.url);
  await api.install("unified-128-cuda");
});
afterAll(() => engine?.stop());

async function shotWithFinal(kind: "same_take" | "remaster"): Promise<Project> {
  const p = await api.call("POST", "/api/projects", ProjectSchema, { name: `reveal ${kind}`, template: "cinematic_shot", aspect: "16:9", brief: { prompt: "A ferry leaves the pier at dusk" } });
  await api.run(`/api/projects/${p.id}/storyboard`);
  await api.settle(p.id);
  const shot = (await api.project(p.id)).shots[0]!;
  await api.run(`/api/projects/${p.id}/shots/${shot.id}/still`);
  await api.run(`/api/projects/${p.id}/shots/${shot.id}/draft`);
  const drafted = await api.project(p.id);
  const draft = drafted.takes.find((t) => t.shotId === shot.id && t.rung === "draft")!;
  await api.run(`/api/projects/${p.id}/shots/${shot.id}/final`, { draftId: draft.id, kind, mode: "now" });
  return api.project(p.id);
}

describe.skipIf(!canRender)("reveal export", { timeout: 240_000 }, () => {
  it("makes a vertical and a wide reveal of a same-take final, filed as reveal assets on a job that carries the shot", async () => {
    const p = await shotWithFinal("same_take");
    const shot = p.shots[0]!;
    for (const aspect of ["9:16", "16:9"] as const) {
      const queued = await api.job(`/api/projects/${p.id}/export`, { aspect, kind: "reveal", shotId: shot.id });
      expect(queued.step).toBe("export");
      expect(queued.shotId).toBe(shot.id);
      const job = await api.wait(queued.id);
      expect(job.status, job.error).toBe("done");
      expect(job.message).toMatch(/^Reveal \d+x\d+, \d+\.\d s, .* same take, frame \d+ of \d+$/);
      const after = await api.project(p.id);
      const asset = after.assets.find((a) => a.id === job.outputAssetIds[0])!;
      expect(asset.role).toBe("reveal");
      expect(asset.kind).toBe("video");
      const info = await probeMedia(join(dataDir, "projects", p.id, asset.path));
      expect([info.width, info.height]).toEqual(aspect === "9:16" ? [1080, 1920] : [1920, 1080]);
      expect(info.durationSec).toBeGreaterThanOrEqual(8);
      expect(info.durationSec).toBeLessThanOrEqual(12);
    }
  });

  it("defaults to the only shot, and asks for one when there are several", async () => {
    const p = await shotWithFinal("same_take");
    expect(p.shots.length).toBeGreaterThanOrEqual(1);
    if (p.shots.length > 1) {
      await expect(api.call("POST", `/api/projects/${p.id}/export`, null, { aspect: "9:16", kind: "reveal" })).rejects.toThrow(/ 400 /);
    } else {
      const queued = await api.job(`/api/projects/${p.id}/export`, { aspect: "9:16", kind: "reveal" });
      expect(queued.shotId).toBe(p.shots[0]!.id);
      const job = await api.wait(queued.id);
      expect(job.status, job.error).toBe("done");
    }
  });

  it("refuses a shot with no final, and labels a remaster a remaster", async () => {
    const p = await shotWithFinal("remaster");
    const bare = p.shots.find((s) => !s.chosenFinalId);
    if (bare) {
      await expect(api.call("POST", `/api/projects/${p.id}/export`, null, { aspect: "9:16", kind: "reveal", shotId: bare.id })).rejects.toThrow(/ 409 /);
    }
    const withFinal = p.shots.find((s) => s.chosenFinalId)!;
    const queued = await api.job(`/api/projects/${p.id}/export`, { aspect: "9:16", kind: "reveal", shotId: withFinal.id });
    const job = JobSchema.parse(await api.wait(queued.id));
    expect(job.status, job.error).toBe("done");
    expect(job.message).toMatch(/remaster$/);
    expect(job.message).not.toMatch(/same take/);
  });
});
