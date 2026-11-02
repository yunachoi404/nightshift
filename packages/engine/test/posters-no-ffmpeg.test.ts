/** Posters on a computer without ffmpeg: a picture is sent whole, briefly cached; a video has no poster (404). */
import { AssetSchema, ProjectSchema, type Asset, type Project } from "@nightshift/contract";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("../src/media/ffmpeg.js", async (original) => ({ ...(await original<typeof import("../src/media/ffmpeg.js")>()), findFfmpeg: async () => undefined, findFfprobe: async () => undefined }));

const { startEngine } = await import("../src/engine.js");
const { placeholderScene } = await import("../src/media/png.js");
const { SAMPLE_RECIPES_DIR } = await import("../src/paths.js");

const dataDir = mkdtempSync(join(tmpdir(), "ns-posters-noff-"));
let engine: Awaited<ReturnType<typeof startEngine>>;
let project: Project;

async function upload(bytes: Uint8Array<ArrayBuffer>, filename: string, type: string): Promise<Asset> {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), filename);
  const res = await fetch(`${engine.url}/api/projects/${project.id}/assets`, { method: "POST", body: form });
  expect(res.status).toBe(201);
  return AssetSchema.parse(await res.json());
}

beforeAll(async () => {
  engine = await startEngine({ port: 0, dataDir, mock: true, mockSpeed: 0, recipesDir: SAMPLE_RECIPES_DIR, log: () => undefined });
  const res = await fetch(`${engine.url}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "No ffmpeg", template: "blank", aspect: "16:9" }) });
  project = ProjectSchema.parse(await res.json());
});

afterAll(async () => {
  await engine?.stop();
});

it("sends a picture whole and has no poster for a video", async () => {
  const png = placeholderScene(320, 180, "whole").toPng();
  const still = await upload(new Uint8Array(png), "still.png", "image/png");
  const res = await fetch(`${engine.url}/api/projects/${project.id}/assets/${still.id}?w=160`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("cache-control")).toBe("private, max-age=300");
  expect(Buffer.from(await res.arrayBuffer()).equals(png)).toBe(true);

  const video = await upload(new Uint8Array(Buffer.from("not really a video")), "clip.mp4", "video/mp4");
  expect((await fetch(`${engine.url}/api/projects/${project.id}/assets/${video.id}?w=160`)).status).toBe(404);
  expect(existsSync(join(dataDir, "projects", project.id, "posters"))).toBe(false);
});
