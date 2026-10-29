import type { OtherGpuUse } from "@nightshift/contract";

/** An error with an HTTP status. The server turns it into { error } with that status. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues?: unknown[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The GPU runtime went away mid-job (ComfyUI restarted, preempted, or the proxy lost it). The queue puts
 * the job back and tries again instead of failing it.
 */
export class RuntimeLostError extends Error {
  override name = "RuntimeLostError";
}

const RUNTIME_LOST = /(?:could not|failed to|unable to) reach comfyui|econnrefused|econnreset|fetch failed|socket hang up|other side closed|connection (refused|reset)/i;

/**
 * Whether an error means the runtime went away rather than the job failing: the connection to the proxy failed or
 * timed out (a dropped ssh tunnel hangs rather than refuses), or the proxy could not reach ComfyUI (`upstream_unreachable`,
 * its 503 while a shared GPU box runs other work, or "Failed to reach ComfyUI for upload/content", its 500 when ComfyUI
 * goes away during an upload or a download).
 */
export function isRuntimeLost(err: unknown): boolean {
  if (err instanceof RuntimeLostError) return true;
  if (!(err instanceof Error)) return false;
  if ((err as { code?: unknown }).code === "upstream_unreachable" || err.name === "TimeoutError") return true;
  const cause = (err as { cause?: unknown }).cause;
  return RUNTIME_LOST.test(err.message) || (cause instanceof Error && RUNTIME_LOST.test(`${cause.message} ${(cause as { code?: string }).code ?? ""}`));
}

export const notFound =(message: string) => new ApiError(404, message);
export const conflict = (message: string) => new ApiError(409, message);
export const badRequest = (message: string, issues?: unknown[]) => new ApiError(400, message, issues);
/** Stop local workers without cancelling a durable remote generation. */
export class ShutdownError extends Error {
  override name = "ShutdownError";
}


/** How PyTorch and ComfyUI say a job ran out of graphics memory ("CUDA out of memory", "would exceed allowed memory"). */
const OUT_OF_MEMORY = /out of memory|outofmemory|would exceed allowed memory/i;

/**
 * A failed GPU job's message, in plain words; its `error` keeps the details. Out of graphics memory says so, and names
 * what other programs held on the card at that moment when the GPU warning knew (RuntimeStatus.otherGpuUse), since
 * that is the usual cause on a small card. Anything else stays "Failed".
 */
export function failureMessage(error: string, others?: OtherGpuUse): string {
  if (!OUT_OF_MEMORY.test(error)) return "Failed";
  if (!others) return "Ran out of graphics memory.";
  return `Ran out of graphics memory. Other apps are using ${others.usedGb} GB${others.apps.length ? ` (${others.apps.join(", ")})` : ""}.`;
}
