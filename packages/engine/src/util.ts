import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, constants, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

export const GIB = 1024 ** 3;

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function bytesToGb(bytes: number): number {
  return round1(bytes / GIB);
}

/** Short, sortable, URL-safe ids: time prefix plus randomness. */
export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === "string" ? reason : "Cancelled");
  err.name = "AbortError";
  return err;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "CancelledError");
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Write JSON through a temp file and rename, so a crash never leaves a half-written file. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n");
  await rename(tmp, path);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Find an executable on PATH (plus extra dirs). Returns the full path or undefined. */
export async function which(cmd: string, extraDirs: string[] = []): Promise<string | undefined> {
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  const dirs = [...extraDirs, ...(process.env.PATH ?? "").split(delimiter)].filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = join(dir, cmd + ext);
      try {
        await access(p, constants.X_OK);
        return p;
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Run a short command and capture its output. Never throws; a missing binary gives code 127. */
export function execCapture(cmd: string, args: string[], opts: { timeoutMs?: number; cwd?: string } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeoutMs ?? 15_000, cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 127) : 0;
      resolve({ stdout: String(stdout), stderr: String(stderr), code });
    });
  });
}

/**
 * Run a long command, streaming its output to `onLine`. Rejects on a non-zero exit with the tail of the output.
 * Aborting the signal kills the child.
 */
export function runStreaming(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; onLine?: (line: string) => void; signal?: AbortSignal } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const tail: string[] = [];
    const onData = (buf: Buffer) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail.push(line);
        if (tail.length > 20) tail.shift();
        opts.onLine?.(line);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const onAbort = () => child.kill("SIGTERM");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.signal?.aborted) return reject(abortError(opts.signal));
      if (code === 0) return resolve();
      reject(new Error(`${cmd} ${args.slice(0, 3).join(" ")} exited with ${code}:\n${tail.join("\n")}`));
    });
  });
}

export type Logger = (msg: string) => void;

export const consoleLogger: Logger = (msg) => {
  process.stderr.write(`[engine ${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
};

/** Serializes async work per key, so two edits to one project never interleave. */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
