import { checkTools } from "@nightshift/editor";
import { JobSchema, ProjectSchema } from "@nightshift/contract";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { startEngine } from "../src/engine.js";
import { placeholderScene } from "../src/media/png.js";
import { defaultRecipesDir } from "../src/paths.js";
import { Api } from "./flow.js";

describe.skipIf(!checkTools().ffmpeg)("Effect quick shot through the API", () => {
  it.each(["freeze", "levitate"])("%s keeps the uploaded photo, makes a take, then finishes and exports it", async (effect) => {
    const dataDir = mkdtempSync(join(tmpdir(), "ns-effect-"));
    const engine = await startEngine({ port: 0, dataDir, mock: true, mockSpeed: 0, recipesDir: defaultRecipesDir(), log: () => undefined });
    try {
      const api = new Api(engine.url);
      await api.install("unified-128-cuda");
      let project = await api.call("POST", "/api/projects", ProjectSchema, { name: "Frozen bottle", template: "vfx_effect", aspect: "9:16", brief: { effect, prompt: "An amber bottle" } });
      const base = `/api/projects/${project.id}`;
      const photo = await api.upload(project.id, placeholderScene(384, 640, "bottle").toPng(), "photo.png", "image/png");
      await api.call("PATCH", base, ProjectSchema, { brief: { ...project.brief, photoAssetId: photo.id } });
      await api.run(`${base}/storyboard`);
      await api.settle(project.id);
      project = await api.project(project.id);
      expect(project.shots).toHaveLength(1);
      const shot = project.shots[0]!;
      expect(shot.stillAssetId).toBe(photo.id);
      expect(shot.durationSec).toBe(4);
      const jobs = await api.call("GET", `/api/jobs?projectId=${project.id}`, z.array(JobSchema));
      expect(jobs.filter((j) => j.step === "video_effect")).toHaveLength(1);
      expect(jobs.every((j) => j.status === "done")).toBe(true);
      expect(jobs.some((j) => j.step === "still")).toBe(false);
      const preparation = jobs.find((j) => j.step === "text")!;
      expect(preparation.message).toBe("Photo ready. Rendering the effect.");
      expect(project.takes).toHaveLength(1);
      const take = project.takes[0]!;
      expect(take.imageAssetId).toBe(photo.id);
      expect(take.latentAssetId).toBeTruthy();
      expect(take.prompt).toContain(effect === "freeze" ? "frost" : "levitates");
      expect(project.assets.filter((a) => a.kind === "image")).toHaveLength(effect === "freeze" ? 2 : 1);
      expect(shot.chosenDraftId).toBe(take.id);
      await api.run(`${base}/shots/${shot.id}/final`, { draftId: take.id, kind: "same_take", mode: "now" });
      project = await api.project(project.id);
      expect(project.takes.find((t) => t.rung === "final")?.parentTakeId).toBe(take.id);
      if (checkTools().chrome) {
        const job = await api.run(`${base}/export`, { aspect: "9:16", quality: "preview" });
        expect(job.outputAssetIds).toHaveLength(1);
      }
    } finally { await engine.stop(); }
  }, 180_000);
});
