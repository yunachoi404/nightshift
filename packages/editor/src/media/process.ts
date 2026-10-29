import { spawn } from "node:child_process";

export interface RunOptions {
  signal?: AbortSignal;
  /** Bytes written to the child's stdin. */
  input?: Buffer;
  /** Called with each chunk of stderr, for progress parsing. */
  onStderr?: (chunk: string) => void;
  cwd?: string;
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

export class ToolError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/** Runs a command to completion and collects its output. Rejects on a non-zero exit or abort. */
export function run(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError());
      return;
    }
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    const onAbort = () => child.kill("SIGKILL");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      // Keep the tail only: ffmpeg can print a lot over a long encode.
      err = (err + text).slice(-64_000);
      options.onStderr?.(text);
    });
    child.on("error", (error) => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(new ToolError(`${command} failed to start: ${error.message}`, command, err));
    });
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) reject(abortError());
      else if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(new ToolError(`${command} exited with code ${code}: ${lastLines(err, 6)}`, command, err));
    });
    child.stdin.on("error", () => {});
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

export function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function lastLines(text: string, count: number): string {
  return text.trim().split("\n").slice(-count).join("\n");
}

/** Runs `tasks` with at most `limit` in flight. Results keep the input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}
