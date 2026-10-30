/**
 * Finals for the night through the engine API (mock GPU, the shipped recipes), the way Finish overnight queues them: each
 * final names the model it loads, and finals that share a model are listed, and run, back to back.
 */
import { JobSchema, ProjectSchema, SettingsSchema, type FinalKind } from "@nightshift/contract";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { startEngine, type EngineHandle } from "../src/engine.js";
import { findFfmpeg } from "../src/media/ffmpeg.js";
import { defaultRecipesDir } from "../src/paths.js";
import { Api } from "./flow.js";

const hasFfmpeg = !!(await findFfmpeg());

describe.skipIf(!hasFfmpeg)("finals for the night through the API", { timeout: 120_000 }, () => {
  let engine: EngineHandle;
  let api: Api;

  beforeAll(async () => {
    engine = await startEngine({ port: 0, dataDir: mkdtempSync(join(tmpdir(), "ns-night-groups-")), mock: true, mockSpeed: 0, recipesDir: defaultRecipesDir(), log: () => undefined });
    api = new Api(engine.url);
    await api.install("unified-128-cuda");
  });
  afterAll(() => engine?.stop());

  it("each final names its model, and the finals that share one wait back to back", async () => {
    const created = await api.call("POST", "/api/projects", ProjectSchema, { name: "Night groups", template: "cinematic_shot", aspect: "16:9", brief: { prompt: "A ferry leaves the pier at dusk" } });
    await api.run(`/api/projects/${created.id}/storyboard`);
    await api.settle(created.id);
    const shotId = (await api.project(created.id)).shots[0]!.id;
    await api.run(`/api/projects/${created.id}/shots/${shotId}/draft`, { seed: 1 });
    const draft = (await api.project(created.id)).takes.find((t) => t.shotId === shotId && t.rung === "draft")!;
    // Overnight mode is off, so the finals wait whatever the time of day the test runs.
    await api.call("PATCH", "/api/settings", SettingsSchema, { overnight: { enabled: false } });
    const final = (kind: FinalKind, mode: "now" | "overnight" = "overnight") => api.job(`/api/projects/${created.id}/shots/${shotId}/final`, { draftId: draft.id, kind, mode });

    const same1 = await final("same_take");
    const remaster = await final("remaster");
    const same2 = await final("same_take");
    expect([same1.model, remaster.model, same2.model]).toEqual(["LTX-2.5", "MiniMax H3", "LTX-2.5"]);
    expect(same2.nightGroup).toBe(same1.nightGroup);
    expect(remaster.nightGroup).not.toBe(same1.nightGroup);
    const queued = async () => (await api.call("GET", `/api/jobs?projectId=${created.id}`, z.array(JobSchema))).filter((j) => j.status === "queued");
    expect((await queued()).map((j) => [j.id, j.message])).toEqual([
      [same1.id, "Runs when overnight mode is on"],
      [same2.id, "Runs when overnight mode is on"],
      [remaster.id, "Runs when overnight mode is on"],
    ]);

    // Overnight mode on with a window open all day: the LTX-2.5 finals run first, then the MiniMax H3 one.
    await api.call("PATCH", "/api/settings", SettingsSchema, { overnight: { enabled: true, startAt: "00:00", endAt: "00:00" } });
    try {
      const done = await Promise.all([same1, same2, remaster].map((j) => api.wait(j.id)));
      expect(done.map((j) => j.status)).toEqual(["done", "done", "done"]);
      // Finals run one at a time and each files its take when it is done, so the takes are in the order they ran.
      const finals = (await api.project(created.id)).takes.filter((t) => t.rung === "final").map((t) => t.jobId);
      expect(finals).toEqual([same1.id, same2.id, remaster.id]);
    } finally {
      await api.call("PATCH", "/api/settings", SettingsSchema, { overnight: { enabled: false, startAt: "23:00", endAt: "07:00" } });
    }

    // A final to run now names its model too, and is not grouped.
    const now = await final("remaster", "now");
    expect(now.model).toBe("MiniMax H3");
    expect(now.nightGroup).toBeUndefined();
    await api.wait(now.id);
  });
});
