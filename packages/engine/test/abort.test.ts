/**
 * A browser's <video> cancels Range requests all the time (it has enough, or the user seeks). The engine treats that
 * as normal: no error in its log, no attempt to answer, and the next request is served as usual.
 */
import { AssetSchema, ProjectSchema } from "@nightshift/contract";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { request, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startEngine, type EngineHandle } from "../src/engine.js";
import { isClientAbort } from "../src/server/http.js";
import { sleep } from "../src/util.js";

const lines: string[] = [];
let engine: EngineHandle;
let assetUrl: URL;
// Big enough that the response is still streaming when the client hangs up.
const BODY = randomBytes(24 * 1024 * 1024);

beforeAll(async () => {
  engine = await startEngine({ port: 0, dataDir: mkdtempSync(join(tmpdir(), "ns-abort-")), mock: true, mockSpeed: 0, log: (m) => lines.push(m) });
  const project = ProjectSchema.parse(
    await (await fetch(`${engine.url}/api/projects`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "abort", template: "cinematic_shot", aspect: "16:9" }) })).json(),
  );
  const asset = AssetSchema.parse(await (await fetch(`${engine.url}/api/projects/${project.id}/assets?filename=clip.mp4`, { method: "POST", body: BODY })).json());
  assetUrl = new URL(`${engine.url}/api/projects/${project.id}/assets/${asset.id}`);
});

afterAll(() => engine?.stop());

/** Ask for `range` and hang up after the first chunk, as a media element does. */
function cancelAfterFirstChunk(range?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(assetUrl, { headers: range ? { Range: range } : {} }, (res) => {
      res.once("data", () => {
        req.destroy();
        resolve(res.statusCode ?? 0);
      });
    });
    req.on("error", (err) => (req.destroyed ? undefined : reject(err)));
    req.end();
  });
}

describe("client aborts", () => {
  it("cancelled Range and full requests log nothing and leave the asset servable", async () => {
    const statuses = [];
    for (const range of ["bytes=0-", "bytes=1000-", "bytes=5000000-", undefined]) statuses.push(await cancelAfterFirstChunk(range));
    expect(statuses).toEqual([206, 206, 206, 200]);
    // The engine sees the close a moment after the client.
    await sleep(200);
    expect(lines.filter((l) => /failed|Premature close/i.test(l))).toEqual([]);
    const after = await fetch(assetUrl, { headers: { Range: "bytes=10-19" } });
    expect(after.status).toBe(206);
    expect(Buffer.from(await after.arrayBuffer()).equals(BODY.subarray(10, 20))).toBe(true);
  });

  it("only a connection that is really gone counts as an abort", () => {
    const gone = { socket: { destroyed: true }, destroyed: true } as unknown as IncomingMessage;
    const alive = { socket: { destroyed: false }, destroyed: false } as unknown as IncomingMessage;
    const res = (destroyed: boolean, writableFinished = false) => ({ destroyed, writableFinished }) as unknown as ServerResponse;
    const err = (code: string) => Object.assign(new Error(code), { code });
    expect(isClientAbort(err("ERR_STREAM_PREMATURE_CLOSE"), gone, res(true))).toBe(true);
    expect(isClientAbort(err("ECONNRESET"), gone, res(false))).toBe(true);
    // A seek can close the response before pipeline attaches to it (Node 26).
    expect(isClientAbort(err("ERR_STREAM_UNABLE_TO_PIPE"), gone, res(true))).toBe(true);
    // ECONNRESET from a request the handler made itself (to ComfyUI, say) while our client is still there is a failure.
    expect(isClientAbort(err("ECONNRESET"), alive, res(false))).toBe(false);
    expect(isClientAbort(err("ERR_STREAM_UNABLE_TO_PIPE"), alive, res(false))).toBe(false);
    // A failing disk read is a failure even though it ends the response too.
    expect(isClientAbort(err("EIO"), gone, res(true))).toBe(false);
    expect(isClientAbort(new Error("no code"), gone, res(true))).toBe(false);
    expect(isClientAbort(err("EPIPE"), gone, res(true, true))).toBe(false);
  });
});
