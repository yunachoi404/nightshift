import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChecksumError, downloadFile } from "../src/install/download.js";
import { parseExtraModelPaths, searchDirs } from "../src/install/modelDirs.js";
import { planInstall } from "../src/install/plan.js";
import { recipe } from "./helpers.js";

const BODY = randomBytes(300_000);
const SHA = createHash("sha256").update(BODY).digest("hex");

let server: Server;
let base = "";
const requests: { path: string; range?: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    requests.push({ path: req.url ?? "", ...(req.headers.range ? { range: req.headers.range } : {}) });
    if (req.url === "/flaky") {
      // Drops the connection halfway through the first time.
      if (requests.filter((r) => r.path === "/flaky").length === 1) {
        res.writeHead(200, { "Content-Length": String(BODY.length) });
        res.write(BODY.subarray(0, 100_000));
        setTimeout(() => res.destroy(), 20);
        return;
      }
    }
    if (req.url === "/smaller") {
      // The file on the server changed and is now smaller than our partial download.
      res.writeHead(req.headers.range ? 416 : 200, req.headers.range ? { "Content-Range": "bytes */1000" } : { "Content-Length": String(BODY.length) });
      return void res.end(req.headers.range ? undefined : BODY);
    }
    if (req.url === "/no-range" || !req.headers.range) {
      res.writeHead(200, { "Content-Length": String(BODY.length) });
      return void res.end(BODY);
    }
    const start = Number(/bytes=(\d+)-/.exec(req.headers.range)![1]);
    if (start >= BODY.length) {
      res.writeHead(416, { "Content-Range": `bytes */${BODY.length}` });
      return void res.end();
    }
    res.writeHead(206, { "Content-Range": `bytes ${start}-${BODY.length - 1}/${BODY.length}`, "Content-Length": String(BODY.length - start) });
    res.end(BODY.subarray(start));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const tmp = () => mkdtempSync(join(tmpdir(), "ns-dl-"));

describe("downloadFile", () => {
  it("downloads, verifies sha256 and reports progress", async () => {
    const dest = join(tmp(), "models", "vae", "a.safetensors");
    const seen: number[] = [];
    await downloadFile({ url: `${base}/file`, dest, sha256: SHA, onProgress: (d) => seen.push(d) });
    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(seen.at(-1)).toBe(BODY.length);
  });

  it("resumes a part file with a Range request and still checks the whole file", async () => {
    const dest = join(tmp(), "b.bin");
    writeFileSync(`${dest}.part`, BODY.subarray(0, 123_456));
    requests.length = 0;
    await downloadFile({ url: `${base}/file`, dest, sha256: SHA });
    expect(requests[0]?.range).toBe("bytes=123456-");
    expect(readFileSync(dest).equals(BODY)).toBe(true);
  });

  it("a complete part file finishes without downloading again (416)", async () => {
    const dest = join(tmp(), "c.bin");
    writeFileSync(`${dest}.part`, BODY);
    await downloadFile({ url: `${base}/file`, dest, sha256: SHA });
    expect(statSync(dest).size).toBe(BODY.length);
  });

  it("a stale part file bigger than the server's file is thrown away, not renamed into place", async () => {
    const dest = join(tmp(), "g.bin");
    writeFileSync(`${dest}.part`, Buffer.alloc(5000));
    await downloadFile({ url: `${base}/smaller`, dest, attempts: 2 });
    expect(readFileSync(dest).equals(BODY)).toBe(true);
  }, 15_000);

  it("starts over when the server ignores Range", async () => {
    const dest = join(tmp(), "d.bin");
    writeFileSync(`${dest}.part`, Buffer.from("garbage that is not the file"));
    await downloadFile({ url: `${base}/no-range`, dest, sha256: SHA });
    expect(readFileSync(dest).equals(BODY)).toBe(true);
  });

  it("retries a dropped connection and resumes where it stopped", async () => {
    const dest = join(tmp(), "e.bin");
    requests.length = 0;
    await downloadFile({ url: `${base}/flaky`, dest, sha256: SHA, attempts: 3 });
    expect(readFileSync(dest).equals(BODY)).toBe(true);
    expect(requests.filter((r) => r.path === "/flaky").length).toBe(2);
    expect(requests[1]?.range).toMatch(/^bytes=\d+-$/);
  }, 15_000);

  it("a checksum mismatch deletes the part file and fails without retrying", async () => {
    const dest = join(tmp(), "f.bin");
    await expect(downloadFile({ url: `${base}/file`, dest, sha256: "0".repeat(64) })).rejects.toBeInstanceOf(ChecksumError);
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(existsSync(dest)).toBe(false);
  });
});

describe("extra_model_paths.yaml", () => {
  it("reads base_path, relative and absolute folders, multi-line lists and legacy names", () => {
    const yaml = `
shared:
  base_path: /opt/shared-models
  is_default: false
  checkpoints: models/checkpoints/
  text_encoders: |
    models/text_encoders/
    models/clip/
  diffusion_models: /mnt/unet
comfy_local:
  base_path: ../shared
  vae: models/vae
`;
    const dirs = parseExtraModelPaths(yaml, "/home/me/comfyui");
    expect(dirs.get("checkpoints")).toEqual(["/opt/shared-models/models/checkpoints"]);
    expect(dirs.get("text_encoders")).toEqual(["/opt/shared-models/models/text_encoders", "/opt/shared-models/models/clip"]);
    expect(dirs.get("diffusion_models")).toEqual(["/mnt/unet"]);
    expect(dirs.get("vae")).toEqual(["/home/me/shared/models/vae"]);
    expect(dirs.has("is_default")).toBe(false);
    // "unet" is ComfyUI's old name for diffusion_models: a model listed under either is found under both.
    expect(searchDirs(dirs, "/home/me/comfyui", "unet")).toEqual(["/home/me/comfyui/models/unet", "/mnt/unet"]);
  });

  it("bad YAML gives no extra folders rather than an error", () => {
    expect(parseExtraModelPaths(": : :\n  - [", "/x").size).toBe(0);
  });
});

describe("install plan", () => {
  it("finds models in ComfyUI's folder or an extra folder, skips truncated files, checks disk", async () => {
    const root = tmp();
    const comfy = join(root, "comfyui");
    const shared = join(root, "shared");
    mkdirSync(join(comfy, "models", "vae"), { recursive: true });
    mkdirSync(join(shared, "clip"), { recursive: true });
    writeFileSync(join(comfy, "models", "vae", "vae.safetensors"), Buffer.alloc(2048));
    writeFileSync(join(shared, "clip", "te.safetensors"), Buffer.alloc(2048));
    writeFileSync(join(comfy, "models", "vae", "short.safetensors"), Buffer.alloc(100)); // truncated
    const lic = { name: "Apache-2.0", url: "https://example.com/l" };
    const kb = 2048 / 1024 ** 3;
    const r = recipe("t", { vendor: "nvidia", minVramGb: 0, minRamGb: 0 }, {
      models: [
        { id: "vae", folder: "vae", filename: "vae.safetensors", url: "https://example.com/a", sizeGb: kb, license: lic },
        { id: "te", folder: "text_encoders", filename: "te.safetensors", url: "https://example.com/b", sizeGb: kb, license: lic },
        { id: "short", folder: "vae", filename: "short.safetensors", url: "https://example.com/c", sizeGb: kb, license: lic },
        { id: "big", folder: "diffusion_models", filename: "big.safetensors", url: "https://example.com/d", sizeGb: 20, license: lic },
      ],
    });
    const dirs = parseExtraModelPaths(`s:\n  base_path: ${shared}\n  text_encoders: clip/\n`, comfy);
    const plan = await planInstall({ recipe: r, dirs, comfyDir: comfy, freeDiskGb: 30, runtimeInstalled: false });
    expect(plan.alreadyPresent).toEqual(["vae", "te"]);
    expect(plan.downloads.map((m) => m.id)).toEqual(["short", "big"]);
    expect(plan.totalDownloadGb).toBe(20);
    // 20 GB of models + 9 GB runtime + 5 GB margin > 30 GB free
    expect(plan.fits).toBe(false);
    expect((await planInstall({ recipe: r, dirs, comfyDir: comfy, freeDiskGb: 30, runtimeInstalled: true })).fits).toBe(true);
  });
});
