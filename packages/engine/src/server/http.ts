/** A small router and the response helpers the routes share. Plain node:http, no framework. */
import busboy from "busboy";
import { createReadStream, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname } from "node:path";
import { pipeline } from "node:stream/promises";
import type { z } from "zod";
import { ApiError, badRequest } from "../errors.js";

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
}

/** A handler returns the JSON body (status 200), a Reply, or HANDLED when it wrote the response itself. */
export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

export const HANDLED = Symbol("handled");

export class Reply {
  constructor(
    readonly status: number,
    readonly body?: unknown,
  ) {}
}

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  /** `spec` is a contract route string like "GET /api/projects/:id" (any query part is ignored). */
  add(spec: string, handler: Handler): void {
    const [method, path] = spec.split(" ") as [string, string];
    this.routes.push({ method, parts: path.split("?")[0]!.split("/").filter(Boolean), handler });
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | "wrong_method" | undefined {
    const parts = pathname.split("/").filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      const ok = route.parts.every((p, i) => {
        if (p.startsWith(":")) {
          try {
            params[p.slice(1)] = decodeURIComponent(parts[i]!);
          } catch {
            throw badRequest("Malformed URL");
          }
          return true;
        }
        return p === parts[i];
      });
      if (!ok) continue;
      pathMatched = true;
      // HEAD runs the GET handler; node:http leaves the body out.
      if (route.method === method || (method === "HEAD" && route.method === "GET")) return { handler: route.handler, params };
    }
    return pathMatched ? "wrong_method" : undefined;
  }

  specs(): string[] {
    return this.routes.map((r) => `${r.method} /${r.parts.join("/")}`);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...(text ? {} : { "Content-Length": "0" }) });
  res.end(text);
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (res.headersSent || res.destroyed) {
    res.destroy();
    return;
  }
  if (err instanceof ApiError) return sendJson(res, err.status, err.issues ? { error: err.message, issues: err.issues } : { error: err.message });
  sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
}

const MAX_JSON_BYTES = 5 * 1024 * 1024;

async function readText(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new ApiError(413, "Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Parse and validate a JSON body. An empty body counts as {}, so optional bodies can be left out. */
export async function readBody<S extends z.ZodType>(req: IncomingMessage, schema: S): Promise<z.infer<S>> {
  const text = await readText(req, MAX_JSON_BYTES);
  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      throw badRequest("Body is not valid JSON");
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    throw badRequest(`Invalid request: ${issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join("; ")}`, issues);
  }
  return parsed.data;
}

/** Stream a raw request body to a file, up to `limit` bytes. */
export async function saveBody(req: IncomingMessage, dest: string, limit: number): Promise<number> {
  let size = 0;
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw new ApiError(413, "File too large");
  await pipeline(
    req,
    async function* (source) {
      for await (const chunk of source) {
        size += (chunk as Buffer).length;
        if (size > limit) throw new ApiError(413, "File too large");
        yield chunk as Buffer;
      }
    },
    createWriteStream(dest),
  );
  if (size === 0) throw badRequest("Empty upload");
  return size;
}

export interface SavedUpload {
  path: string;
  filename: string;
  mimeType: string;
  fields: Record<string, string>;
}

/**
 * Stream the multipart field `file` to disk (busboy, so a large file never sits in memory). Other text
 * fields come back in `fields`. Rejects with 400 when there is no file, 413 over `limit` bytes.
 */
export function saveMultipartFile(req: IncomingMessage, name: (ext: string) => string, limit: number): Promise<SavedUpload> {
  return new Promise((resolve, reject) => {
    let bb: busboy.Busboy;
    try {
      bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: limit, fields: 20, fieldSize: 64 * 1024 } });
    } catch {
      return reject(badRequest("Not a multipart body"));
    }
    const fields: Record<string, string> = {};
    let saved: Promise<Omit<SavedUpload, "fields">> | undefined;
    bb.on("field", (key, value) => (fields[key] = value));
    bb.on("file", (field, stream, info) => {
      if (field !== "file" || saved) return void stream.resume();
      const ext = extname(info.filename ?? "").toLowerCase();
      const path = name(/^\.[a-z0-9]{1,6}$/.test(ext) ? ext : extFromMime(info.mimeType));
      let tooBig = false;
      stream.on("limit", () => (tooBig = true));
      saved = pipeline(stream, createWriteStream(path)).then(async () => {
        if (tooBig) {
          await rm(path, { force: true });
          throw new ApiError(413, "File too large");
        }
        return { path, filename: info.filename ?? "", mimeType: info.mimeType };
      });
    });
    bb.on("error", () => reject(badRequest("The multipart body could not be read")));
    bb.on("close", () => {
      if (!saved) return reject(badRequest('Send the file in a multipart field named "file"'));
      saved.then((f) => resolve({ ...f, fields }), reject);
    });
    req.pipe(bb);
  });
}

const EXT_FOR_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/wave": ".wav",
  "audio/mpeg": ".mp3",
  "audio/flac": ".flac",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
};

export function extFromMime(mime: string | undefined): string {
  return EXT_FOR_MIME[(mime ?? "").split(";")[0]!.trim().toLowerCase()] ?? ".bin";
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".opus": "audio/opus",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
};

export function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Errors a response gets when its connection is gone. A failing read stream has its own codes (EIO, ENOENT). */
const CONNECTION_GONE = new Set(["ERR_STREAM_PREMATURE_CLOSE", "ECONNRESET", "EPIPE", "ECONNABORTED", "ERR_STREAM_DESTROYED", "ERR_STREAM_UNABLE_TO_PIPE"]);

/**
 * The client closed the connection before the response finished. A <video> element does this all the time: it
 * cancels a Range request once it has what it needs, or when the user seeks. That is normal, not a failure, and there
 * is no one left to send an error to.
 */
export function isClientAbort(err: unknown, req: IncomingMessage, res: ServerResponse): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return !!code && CONNECTION_GONE.has(code) && !res.writableFinished && (res.destroyed || req.destroyed || !!req.socket?.destroyed);
}

/** Stream a file into the response. Resolves, without sending more, when the client goes away first. */
async function streamFile(req: IncomingMessage, res: ServerResponse, path: string, range?: { start: number; end: number }): Promise<void> {
  try {
    await pipeline(createReadStream(path, range), res);
  } catch (err) {
    if (!isClientAbort(err, req, res)) throw err;
  }
}

/** Send a file, honoring a single "Range: bytes=" request (video and audio seeking need it). */
export async function sendFile(req: IncomingMessage, res: ServerResponse, path: string, cacheControl: string): Promise<void> {
  const s = await stat(path).catch(() => undefined);
  if (!s?.isFile()) throw new ApiError(404, "File not found");
  const headers: Record<string, string> = { "Content-Type": mimeFor(path), "Accept-Ranges": "bytes", "Cache-Control": cacheControl, "Last-Modified": s.mtime.toUTCString() };
  let range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  // "bytes=5-3" is not a valid range: RFC 9110 says to ignore the header.
  if (range && range[1] && range[2] && Number(range[1]) > Number(range[2])) range = null;
  if (range && s.size > 0) {
    let start = range[1] ? Number(range[1]) : s.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : s.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, s.size - 1);
    if (start > end || Number.isNaN(start)) {
      res.writeHead(416, { "Content-Range": `bytes */${s.size}` });
      res.end();
      return;
    }
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${s.size}`, "Content-Length": String(end - start + 1) });
    if (req.method === "HEAD") return void res.end();
    return streamFile(req, res, path, { start, end });
  }
  res.writeHead(200, { ...headers, "Content-Length": String(s.size) });
  if (req.method === "HEAD") return void res.end();
  return streamFile(req, res, path);
}

/** The UI's dev server (Vite) runs on another localhost port. Only loopback origins are allowed. */
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/**
 * Requests other sites' pages may not make. A page anywhere on the web can POST to 127.0.0.1 (a "simple"
 * request needs no CORS preflight), and DNS rebinding can point another name at it. So:
 * - when the engine listens on loopback, the Host header must be a loopback name;
 * - a write (anything but GET/HEAD/OPTIONS) that carries an Origin must come from loopback, from the
 *   engine's own origin, or from an origin the embedder allowed (a desktop shell's custom scheme).
 * Returns the reason to refuse, or undefined.
 */
export function refuseRequest(req: IncomingMessage, loopbackOnly: boolean, allowedOrigins: string[]): string | undefined {
  const host = req.headers.host ?? "";
  if (loopbackOnly && host && !LOOPBACK_HOST.test(host)) return `Host ${host} is not allowed`;
  const origin = req.headers.origin;
  if (!origin || ["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET")) return undefined;
  if (LOOPBACK_ORIGIN.test(origin) || allowedOrigins.includes(origin)) return undefined;
  if (host && (origin === `http://${host}` || origin === `https://${host}`)) return undefined;
  return `Origin ${origin} is not allowed`;
}

export function corsHeaders(origin: string | undefined): Record<string, string> {
  if (!origin || !LOOPBACK_ORIGIN.test(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}
