/**
 * Resumable, checksummed downloads. Bytes land in "<dest>.part"; an interrupted download continues with an
 * HTTP Range request (the part file is re-hashed first so the sha256 still covers every byte). The file is
 * renamed into place only after the checksum matches.
 */
import { createHash, type Hash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { abortError, sleep } from "../util.js";

export class ChecksumError extends Error {
  override name = "ChecksumError";
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    url: string,
  ) {
    super(`HTTP ${status} for ${new URL(url).host}${new URL(url).pathname}`);
  }
}

export interface DownloadOptions {
  url: string;
  dest: string;
  sha256?: string;
  onProgress?(doneBytes: number, totalBytes: number | undefined): void;
  signal?: AbortSignal;
  /** Attempts for network errors and 5xx answers, each resuming where the last stopped. */
  attempts?: number;
  fetchImpl?: typeof fetch;
}

/** Hugging Face gated repos need a token; it is sent to huggingface.co only and never logged. */
function authHeaders(url: string): Record<string, string> {
  const token = process.env.HF_TOKEN ?? process.env.HUGGING_FACE_HUB_TOKEN;
  const host = new URL(url).hostname;
  return token && (host === "huggingface.co" || host.endsWith(".huggingface.co")) ? { Authorization: `Bearer ${token}` } : {};
}

export async function downloadFile(o: DownloadOptions): Promise<void> {
  const attempts = o.attempts ?? 5;
  for (let i = 1; ; i++) {
    try {
      return await downloadOnce(o);
    } catch (err) {
      const fsError = ["ENOSPC", "EACCES", "EPERM", "EROFS", "EISDIR", "ENOTDIR"].includes((err as NodeJS.ErrnoException).code ?? "");
      const retryable = !(err instanceof ChecksumError) && !fsError && !o.signal?.aborted && (!(err instanceof HttpError) || err.status >= 500 || err.status === 429);
      if (!retryable || i >= attempts) throw err;
      await sleep(Math.min(30_000, 1000 * 2 ** i), o.signal);
    }
  }
}

async function hashFile(path: string, hash: Hash): Promise<void> {
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
}

async function downloadOnce(o: DownloadOptions): Promise<void> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const part = `${o.dest}.part`;
  await mkdir(dirname(o.dest), { recursive: true });
  let have = (await stat(part).catch(() => undefined))?.size ?? 0;
  let hash = o.sha256 ? createHash("sha256") : undefined;
  if (hash && have > 0) await hashFile(part, hash);

  const headers: Record<string, string> = { ...authHeaders(o.url), "User-Agent": "nightshift-engine" };
  if (have > 0) headers.Range = `bytes=${have}-`;
  const res = await fetchImpl(o.url, { headers, signal: o.signal, redirect: "follow" });

  if (res.status === 416 && have > 0) {
    // The part file already holds every byte, if its size matches the server's.
    await res.body?.cancel();
    const size = Number(/\/(\d+)$/.exec(res.headers.get("content-range") ?? "")?.[1]);
    if (Number.isFinite(size) && size !== have) {
      await rm(part, { force: true });
      throw new Error(`The partial download (${have} bytes) does not match the file on the server (${size} bytes); starting over`);
    }
    return finish(o, part, hash);
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new HttpError(res.status, o.url);
  }
  const contentRange = res.headers.get("content-range");
  if (have > 0 && (res.status !== 206 || !contentRange?.startsWith(`bytes ${have}-`))) {
    // The server ignored the range: start over.
    have = 0;
    hash = o.sha256 ? createHash("sha256") : undefined;
    await rm(part, { force: true });
  }
  const length = Number(res.headers.get("content-length"));
  const total = Number.isFinite(length) && length > 0 ? have + length : undefined;
  if (!res.body) throw new Error(`Empty response for ${o.url}`);

  let done = have;
  let lastReport = 0;
  o.onProgress?.(done, total);
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      done += chunk.length;
      hash?.update(chunk);
      const now = Date.now();
      if (now - lastReport > 250) {
        lastReport = now;
        o.onProgress?.(done, total);
      }
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), meter, createWriteStream(part, { flags: have > 0 ? "a" : "w" }), { signal: o.signal });
  if (o.signal?.aborted) throw abortError(o.signal);
  o.onProgress?.(done, total ?? done);
  if (total !== undefined && done < total) throw new Error(`Download ended early (${done} of ${total} bytes)`);
  await finish(o, part, hash);
}

async function finish(o: DownloadOptions, part: string, hash: Hash | undefined): Promise<void> {
  if (hash && o.sha256) {
    const got = hash.digest("hex");
    if (got.toLowerCase() !== o.sha256.toLowerCase()) {
      await rm(part, { force: true });
      throw new ChecksumError(`Checksum mismatch for ${o.dest}: expected ${o.sha256}, got ${got}`);
    }
  }
  await rename(part, o.dest);
}
