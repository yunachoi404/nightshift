/**
 * Posters (`?w=` on an asset): a small JPEG of a picture or of a video's first frame, made once and kept in the project
 * folder, so the UI's small pictures load tens of KB instead of full stills and finals. And the overnight window's time
 * zone, which the settings report so a browser in another zone reads the window's times on the engine's clock.
 */
import { AssetSchema, ProjectSchema, SettingsSchema, type Asset, type Project } from "@nightshift/contract";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, type EngineHandle } from "../src/engine.js";
import { findFfmpeg, probeMedia } from "../src/media/ffmpeg.js";
import { encodePng, placeholderScene } from "../src/media/png.js";
import { SAMPLE_RECIPES_DIR } from "../src/paths.js";
import { execCapture } from "../src/util.js";

const ffmpeg = await findFfmpeg();
const dataDir = mkdtempSync(join(tmpdir(), "ns-posters-"));
let engine: EngineHandle;
let project: Project;

async function upload(bytes: Uint8Array<ArrayBuffer>, filename: string, type: string): Promise<Asset> {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), filename);
  const res = await fetch(`${engine.url}/api/projects/${project.id}/assets`, { method: "POST", body: form });
  expect(res.status, await res.clone().text()).toBe(201);
  return AssetSchema.parse(await res.json());
}

const get = (asset: Asset, query = "") => fetch(`${engine.url}/api/projects/${project.id}/assets/${asset.id}${query}`);
const postersDir = () => join(dataDir, "projects", project.id, "posters");
const posters = () => readdirSync(postersDir()).sort();

/** The size of a picture the engine sent, read back with ffprobe. */
async function sizeOf(res: Response, ext: string): Promise<{ width?: number; height?: number }> {
  const file = join(mkdtempSync(join(tmpdir(), "ns-poster-out-")), `poster${ext}`);
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return probeMedia(file);
}

beforeAll(async () => {
  engine = await startEngine({ port: 0, dataDir, mock: true, mockSpeed: 0, recipesDir: SAMPLE_RECIPES_DIR, log: () => undefined });
  const res = await fetch(`${engine.url}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Posters", template: "blank", aspect: "16:9" }) });
  project = ProjectSchema.parse(await res.json());
});

afterAll(async () => {
  await engine?.stop();
});

describe("posters", () => {
  it("a still becomes a small JPEG, made once and kept in the project folder", { skip: !ffmpeg }, async () => {
    const png = placeholderScene(1280, 720, "poster").toPng();
    const still = await upload(new Uint8Array(png), "still.png", "image/png");

    const res = await get(still, "?w=320");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(await sizeOf(res.clone(), ".jpg")).toEqual({ width: 320, height: 180 });
    expect(Number(res.headers.get("content-length"))).toBeLessThan(png.length / 4);
    expect(posters()).toEqual([`${still.id}-w320.jpg`]);

    // Asked again, it is the same file, not made again.
    const made = statSync(join(postersDir(), `${still.id}-w320.jpg`)).mtimeMs;
    expect((await get(still, "?w=320")).status).toBe(200);
    expect(statSync(join(postersDir(), `${still.id}-w320.jpg`)).mtimeMs).toBe(made);

    // Other widths round up to the next poster width, and anything wider is the widest. The asset itself is unchanged.
    expect(await sizeOf(await get(still, "?w=200"), ".jpg")).toEqual({ width: 320, height: 180 });
    expect(await sizeOf(await get(still, "?w=4000"), ".jpg")).toEqual({ width: 640, height: 360 });
    expect(Buffer.from(await (await get(still)).arrayBuffer()).equals(png)).toBe(true);
    expect(posters()).toEqual([`${still.id}-w320.jpg`, `${still.id}-w640.jpg`]);
  });

  it("many asks at once make one poster", { skip: !ffmpeg }, async () => {
    const still = await upload(new Uint8Array(placeholderScene(960, 540, "together").toPng()), "together.png", "image/png");
    const all = await Promise.all(Array.from({ length: 8 }, () => get(still, "?w=160").then(async (r) => [r.status, Buffer.from(await r.arrayBuffer())] as const)));
    expect(all.every(([status]) => status === 200)).toBe(true);
    expect(all.every(([, bytes]) => bytes.equals(all[0]![1]))).toBe(true);
    expect(posters().filter((n) => n.startsWith(still.id))).toEqual([`${still.id}-w160.jpg`]);
    // Nothing half-written is left behind.
    expect(posters().some((n) => n.startsWith("part_"))).toBe(false);
  });

  it("a small picture is never scaled up, and a see-through one stays PNG", { skip: !ffmpeg }, async () => {
    const small = await upload(new Uint8Array(placeholderScene(64, 36, "small").toPng()), "small.png", "image/png");
    expect(await sizeOf(await get(small, "?w=640"), ".jpg")).toEqual({ width: 64, height: 36 });

    const rgba = new Uint8Array(400 * 200 * 4);
    for (let i = 0; i < rgba.length; i += 4) rgba.set(i % (400 * 4) < 200 * 4 ? [250, 180, 40, 255] : [0, 0, 0, 0], i);
    const cutout = await upload(new Uint8Array(encodePng(400, 200, rgba)), "cutout.png", "image/png");
    const res = await get(cutout, "?w=160");
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(await sizeOf(res, ".png")).toEqual({ width: 160, height: 80 });
  });

  it("a video's poster is its first frame", { skip: !ffmpeg }, async () => {
    const file = join(mkdtempSync(join(tmpdir(), "ns-poster-video-")), "clip.mp4");
    const made = await execCapture(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24", "-t", "1", "-pix_fmt", "yuv420p", file]);
    expect(made.code, made.stderr).toBe(0);
    const video = await upload(new Uint8Array(readFileSync(file)), "clip.mp4", "video/mp4");
    expect(video.kind).toBe("video");
    const res = await get(video, "?w=640");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(await sizeOf(res, ".jpg")).toEqual({ width: 640, height: 360 });
    // Without ?w, the video itself, with Range as before.
    const ranged = await get(video, "");
    expect(ranged.headers.get("content-type")).toBe("video/mp4");
  });

  it("audio has no poster, a bad width is refused, and an asset's posters go with it", { skip: !ffmpeg }, async () => {
    const song = await upload(new Uint8Array(Buffer.from("RIFF....WAVE")), "song.wav", "audio/wav");
    const sound = await get(song, "?w=320");
    expect(sound.status).toBe(200);
    expect(sound.headers.get("content-type")).toBe("audio/wav");

    const ref = await upload(new Uint8Array(placeholderScene(640, 360, "gone").toPng()), "gone.png", "image/png");
    for (const w of ["abc", "0", "-5", "1.5", ""]) expect((await get(ref, `?w=${w}`)).status, `w=${w}`).toBe(400);
    expect((await get(ref, "?w=320")).status).toBe(200);
    expect((await get(ref, "?w=160")).status).toBe(200);
    expect(posters().filter((n) => n.startsWith(ref.id))).toHaveLength(2);
    expect((await fetch(`${engine.url}/api/projects/${project.id}/assets/${ref.id}`, { method: "DELETE" })).status).toBe(204);
    expect(posters().filter((n) => n.startsWith(ref.id))).toEqual([]);
    expect((await get(ref, "?w=320")).status).toBe(404);
  });
});

describe("the overnight window's time zone", () => {
  it("is the engine's, reported on every read and never saved", async () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const read = SettingsSchema.parse(await (await fetch(`${engine.url}/api/settings`)).json());
    expect(read.overnight).toEqual({ enabled: false, startAt: "23:00", endAt: "07:00", timeZone: zone });

    // A browser sends back what it read, zone and all, as the Finals page does: the zone is not the browser's to set.
    const body = JSON.stringify({ overnight: { ...read.overnight, enabled: true, timeZone: "Europe/Berlin" } });
    const patched = SettingsSchema.parse(await (await fetch(`${engine.url}/api/settings`, { method: "PATCH", headers: { "content-type": "application/json" }, body })).json());
    expect(patched.overnight).toEqual({ enabled: true, startAt: "23:00", endAt: "07:00", timeZone: zone });
    expect(JSON.parse(readFileSync(join(dataDir, "settings.json"), "utf8")).overnight).toEqual({ enabled: true, startAt: "23:00", endAt: "07:00" });
  });
});
