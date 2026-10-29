import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectSchema, quickMoves } from "@nightshift/contract";
import { startEngine } from "../src/engine.js";
import { MockStepRunner } from "../src/runner/mock.js";
import { findFfmpeg } from "../src/media/ffmpeg.js";
import { placeholderScene } from "../src/media/png.js";
import { cameraMove, cameraSource } from "../src/projects/camera-move.js";
import { Api } from "./flow.js";

const hasFfmpeg = !!await findFfmpeg();
describe("camera quick shots", () => {
  it("rejects unknown moves and non-image sources", () => {
    expect(() => cameraMove("made-up")).toThrow("Unknown camera move");
    expect(() => cameraSource({ assets: [], brief: {} } as never)).toThrow("Add a photo");
    expect(new Set(quickMoves.map((p) => p.id)).size).toBe(quickMoves.length);
  });
  it.skipIf(!hasFfmpeg)("uses the uploaded photo, makes its layout before the shot, and finishes the same take", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ns-camera-"));
    const steps: string[] = [];
    const runner = new MockStepRunner(0);
    const engine = await startEngine({ port: 0, dataDir, mock: true, mockSpeed: 0, log: () => undefined,
      runner: { run(req, ctx) { steps.push(req.step); return runner.run(req, ctx); } } });
    try {
      const api = new Api(engine.url);
      await api.install("unified-128-cuda");
      let p = await api.call("POST", "/api/projects", ProjectSchema, { name: "Camera", template: "camera_move", aspect: "16:9", brief: { move: "dolly_in", prompt: "A desk lamp" } });
      const photo = await api.upload(p.id, placeholderScene(640, 384, "lamp").toPng(), "lamp.png", "image/png");
      await api.call("PATCH", `/api/projects/${p.id}`, ProjectSchema, { brief: { ...p.brief, photoAssetId: photo.id } });
      await api.run(`/api/projects/${p.id}/storyboard`);
      await api.settle(p.id);
      p = await api.project(p.id);
      expect(p.shots).toHaveLength(1);
      expect(p.shots[0]!.stillAssetId).toBe(photo.id);
      expect(p.shots[0]!.durationSec).toBe(4);
      expect(steps).toEqual(["camera_layout", "video_camera_move"]);
      expect(p.takes[0]!.imageAssetId).toBe(photo.id);
      expect(p.takes[0]!.latentAssetId).toBeTruthy();
      expect(p.timeline!.clips).toHaveLength(1);
      expect(p.timeline!.overlays).toEqual([]);
      const original = readFileSync(join(dataDir, "projects", p.id, photo.path));
      expect(original).toEqual(placeholderScene(640, 384, "lamp").toPng());
      await api.run(`/api/projects/${p.id}/shots/${p.shots[0]!.id}/final`, { draftId: p.takes[0]!.id, kind: "same_take", mode: "now" });
      p = await api.project(p.id);
      expect(p.takes.find((t) => t.rung === "final")?.parentTakeId).toBe(p.takes[0]!.id);
    } finally { await engine.stop(); }
  }, 120_000);
});
