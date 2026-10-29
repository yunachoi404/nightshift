import { JobSchema, ProjectSchema, SettingsSchema, type Aspect } from "@nightshift/contract";
import { checkTools, probeMedia, resolveTools } from "@nightshift/editor";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { startEngine } from "../src/engine.js";
import { placeholderScene } from "../src/media/png.js";
import { defaultRecipesDir } from "../src/paths.js";
import { Api } from "./flow.js";

describe.skipIf(!checkTools().ffmpeg)("What-if through the real engine API", () => {
  it.each(["9:16", "16:9"] as Aspect[])("makes one %s film with voice, music, captions, redraw and same-take final", async aspect => {
    const dataDir = mkdtempSync(join(tmpdir(), "ns-what-if-flow-"));
    const engine = await startEngine({ port: 0, dataDir, mock: true, mockSpeed: 0, recipesDir: defaultRecipesDir(), log: () => undefined });
    try {
      const api = new Api(engine.url);
      await api.install("unified-128-cuda");
      let project = await api.call("POST", "/api/projects", ProjectSchema, { name: "Gravity", template: "what_if", aspect,
        brief: { question: "What if gravity stopped for ten seconds?", look: "cinematic" } });
      const base = `/api/projects/${project.id}`;
      const photo = await api.upload(project.id, placeholderScene(384, 640, "kitchen").toPng(), "kitchen.png", "image/png");
      await api.call("PATCH", base, ProjectSchema, { brief: { ...project.brief, photoAssetId: photo.id } });
      await api.run(`${base}/storyboard`);
      await api.settle(project.id);
      project = await api.project(project.id);
      expect(project.shots).toHaveLength(1);
      const shot = project.shots[0]!;
      const originalIds = shot.keyframes!.map(frame => frame.stillAssetId);
      expect(originalIds).toHaveLength(4);
      expect(originalIds[0]).toBe(photo.id);
      expect(originalIds.every(Boolean)).toBe(true);
      const draft = project.takes[0]!;
      expect(draft.guideAssetIds).toEqual(originalIds);
      expect(draft.latentAssetId).toBeTruthy();
      expect(project.assets.some(asset => asset.role === "voice" && asset.text)).toBe(true);
      expect(project.assets.some(asset => asset.role === "music")).toBe(true);
      expect(project.timeline!.clips).toHaveLength(1);
      expect(project.timeline!.clips[0]!.out).toBeCloseTo(15, 1);
      expect(project.timeline!.captions.length).toBeGreaterThan(0);

      await api.run(`${base}/shots/${shot.id}/still`, { keyframeIndex: 2, seed: 123 });
      project = await api.project(project.id);
      const after = project.shots[0]!.keyframes!.map(frame => frame.stillAssetId);
      expect(after.slice(0, 2)).toEqual(originalIds.slice(0, 2));
      expect(after[2]).not.toBe(originalIds[2]);
      expect(after[3]).not.toBe(originalIds[3]);
      expect(project.takes[0]!.guideAssetIds).toEqual(originalIds);
      await api.run(`${base}/shots/${shot.id}/final`, { draftId: draft.id, kind: "same_take", mode: "now" });
      project = await api.project(project.id);
      const final = project.takes.find(take => take.rung === "final")!;
      expect(final.parentTakeId).toBe(draft.id);
      expect(final.guideAssetIds).toEqual(originalIds);
      expect(final.prompt).toBe(draft.prompt);
      await api.run(`${base}/shots/${shot.id}/draft`, { seed: 456 });
      project = await api.project(project.id);
      const another = project.takes.filter(take => take.rung === "draft").at(-1)!;
      project = await api.call("PATCH", base, ProjectSchema, { shots: project.shots.map(item => ({ ...item, chosenDraftId: another.id })) });
      expect(project.shots[0]!.chosenFinalId, "an old final must not override the newly picked draft").toBeUndefined();
      expect(project.takes.some(take => take.id === final.id)).toBe(true);
      await api.call("PATCH", "/api/settings", SettingsSchema, { overnight: { enabled: false } });
      await api.call("PATCH", base, ProjectSchema, { shots: project.shots.map(item => ({ ...item, chosenDraftId: draft.id })) });
      const queued = await api.job(`${base}/shots/${shot.id}/final`, { draftId: draft.id, kind: "same_take", mode: "overnight" });
      project = await api.project(project.id);
      await api.call("PATCH", base, ProjectSchema, { shots: project.shots.map(item => ({ ...item, chosenDraftId: another.id })) });
      await api.call("PATCH", "/api/settings", SettingsSchema, { overnight: { enabled: true, startAt: "00:00", endAt: "00:00" } });
      expect((await api.wait(queued.id)).status).toBe("done");
      project = await api.project(project.id);
      expect(project.shots[0]!.chosenDraftId).toBe(another.id);
      expect(project.shots[0]!.chosenFinalId, "a late final must not replace the newly picked draft").toBeUndefined();
      expect(project.takes.some(take => take.jobId === queued.id && take.parentTakeId === draft.id)).toBe(true);
      const remaster = await fetch(engine.url + `${base}/shots/${shot.id}/final`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ draftId: draft.id, kind: "remaster", mode: "now" }) });
      expect(remaster.status).toBe(409);
      const jobs = await api.call("GET", `/api/jobs?projectId=${project.id}`, z.array(JobSchema));
      expect(jobs.filter(job => job.step === "video_what_if")).toHaveLength(2);
      expect(jobs.every(job => job.status === "done")).toBe(true);
      if (checkTools().chrome) {
        const exported = await api.run(`${base}/export`, { aspect, quality: "preview" });
        project = await api.project(project.id);
        const asset = project.assets.find(item => item.id === exported.outputAssetIds[0])!;
        const media = await probeMedia(resolveTools(), join(dataDir, "projects", project.id, asset.path));
        expect([media.width, media.height]).toEqual(aspect === "9:16" ? [540, 960] : [960, 540]);
        expect(media.durationSec).toBeCloseTo(15, 1);
        expect(media.hasAudio).toBe(true);
      }
    } finally { await engine.stop(); }
  }, 180_000);
});
