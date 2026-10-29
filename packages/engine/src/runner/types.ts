import type { Aspect, StepId, WorkflowRef } from "@nightshift/contract";
import type { OutputKind } from "../comfy/bind.js";

/** One generation: a recipe step with its named inputs filled in. */
export interface StepRequest {
  jobId: string;
  step: StepId;
  ref: WorkflowRef;
  /** Named inputs (see WorkflowRefSchema). File inputs are absolute local paths. */
  values: Record<string, unknown>;
  /** Where output files are written. */
  outDir: string;
  /** A ComfyUI job this step already submitted (before a retry or an engine restart): follow it instead of submitting again. */
  resumeComfyJobId?: string;
  /** Facts about the request the mock runner uses to make believable placeholders. */
  hints: { aspect: Aspect; width: number; height: number; durationSec?: number; cameraMove?: string; label?: string };
}

export interface StepOutput {
  path: string;
  kind: OutputKind;
  nodeId: string;
}

export interface StepProgress {
  progress: number;
  message?: string;
}

export interface StepContext {
  signal: AbortSignal;
  onProgress(p: StepProgress): void;
  /** Called with the ComfyUI job id right after submitting, so a retry can find the job again. */
  onSubmitted?(comfyJobId: string): void;
}

/** Runs recipe steps: through the Comfy SDK for real, or with ffmpeg placeholders in mock mode. */
export interface StepRunner {
  run(req: StepRequest, ctx: StepContext): Promise<StepOutput[]>;
}
