/**
 * Runs recipe steps on ComfyUI through the Comfy SDK and comfy-api-proxy. This is the only path to the GPU:
 * no raw /prompt calls (hackathon rule).
 *
 * Known proxy and SDK quirks handled here:
 * - Output.sizeBytes is always 0, so sizes come from the downloaded file.
 * - job.outputs also lists loader previews (LoadVideo shows up as an output), so only the recipe's
 *   declared outputNodes are collected.
 * - SaveVideo outputs arrive typed "image"; the kind comes from the file extension.
 * - The poll path reports no live progress; the SSE stream (job.events) does.
 * - The proxy's nodes_total counts only the nodes ComfyUI has reached so far, so it grows as the job runs: halfway
 *   through the sampler it reads 8 of 9 done. The graph's own node count is the real total. The SDK also drops
 *   every progress frame whose value is below the last one, so once a node boundary reads 1.0 (8 of 8 done) the
 *   frames inside the next node never arrive: progress moves node by node, without the sampler's steps.
 */
import type { Comfy, Job as SdkJob } from "@comfyorg/sdk";
import { mkdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { bindWorkflow, kindFromFilename, type Graph } from "../comfy/bind.js";
import { renderCameraLayout } from "../comfy/camera.js";
import { isRuntimeLost, RuntimeLostError, ShutdownError } from "../errors.js";
import { abortError, type Logger } from "../util.js";
import type { StepContext, StepOutput, StepRequest, StepRunner } from "./types.js";

export class SdkStepRunner implements StepRunner {
  constructor(
    private readonly client: () => Comfy,
    private readonly workflowsDir: string,
    private readonly log: Logger,
  ) {}

  async run(req: StepRequest, ctx: StepContext): Promise<StepOutput[]> {
    const graph = JSON.parse(await readFile(join(this.workflowsDir, req.ref.workflow), "utf8")) as Graph;
    const bound = bindWorkflow(graph, req.ref, req.values);
    const client = this.client();
    const wf = client.workflows.fromJson(bound.graph);
    for (const f of bound.files) wf.setInput(f.node, f.field, client.assets.fromFile(f.path));

    let job = req.resumeComfyJobId ? await this.reattach(client, req.resumeComfyJobId) : undefined;
    if (job) {
      this.log(`job ${req.jobId}: following comfy job ${job.id} again (${job.status})`);
    } else {
      ctx.onProgress({ progress: 0.01, message: bound.files.length ? "Uploading inputs" : "Submitting" });
      job = await client.submit(wf, { signal: ctx.signal });
      ctx.onSubmitted?.(job.id);
      this.log(`job ${req.jobId}: comfy job ${job.id} submitted (${req.step}, ${req.ref.workflow})`);
    }
    try {
      await this.follow(job, ctx, Object.keys(bound.graph).length);
      // The event stream can end without a final status; poll until the job really is finished.
      await job.wait(undefined, ctx.signal);
    } catch (err) {
      if (ctx.signal.aborted) {
        if (!(ctx.signal.reason instanceof ShutdownError)) await job.cancel(AbortSignal.timeout(10_000)).catch(() => undefined);
        throw abortError(ctx.signal);
      }
      throw err;
    }
    if (job.status !== "succeeded") {
      if (job.status === "canceled" && req.resumeComfyJobId === job.id) {
        throw new RuntimeLostError("The previous generation was canceled while the engine restarted. Trying it again.");
      }
      const message = describeFailure(job);
      // "expired": the proxy remembers the job but ComfyUI does not, so ComfyUI restarted under it (a preemption).
      const lost = (job.status === "expired" && !job.error) || isRuntimeLost(new Error(message));
      throw lost ? new RuntimeLostError(job.status === "expired" ? "ComfyUI restarted and lost the job" : message) : new Error(message);
    }

    ctx.onProgress({ progress: 0.96, message: "Saving outputs" });
    await mkdir(req.outDir, { recursive: true });
    const outputs: StepOutput[] = [];
    for (const nodeId of req.ref.outputNodes) {
      for (const out of job.getOutputs(nodeId)) {
        const kind = kindFromFilename(out.name) ?? (out.type === "image" || out.type === "video" || out.type === "audio" || out.type === "latent" || out.type === "text" ? out.type : undefined);
        if (!kind) continue;
        const dest = join(req.outDir, `${nodeId.replace(/[^\w-]/g, "_")}_${basename(out.name)}`);
        await out.toFile(dest, { signal: ctx.signal });
        const size = (await stat(dest)).size;
        if (size === 0) throw new Error(`Output ${out.name} from node ${nodeId} downloaded empty`);
        outputs.push({ path: dest, kind, nodeId });
      }
    }
    if (outputs.length === 0) throw new Error(`ComfyUI finished but output nodes ${req.ref.outputNodes.join(", ")} produced no files`);
    return req.step === "camera_layout" ? renderCameraLayout(req, outputs, ctx) : outputs;
  }

  /**
   * The earlier ComfyUI job, if it is still queued, running or finished well. Otherwise undefined: submit anew. When the
   * runtime cannot say (it is gone again), the error goes up and the job waits, so a job that may still be running is
   * never submitted twice.
   */
  private async reattach(client: Comfy, id: string): Promise<SdkJob | undefined> {
    try {
      const job = await client.jobs.get(id);
      return ["queued", "running", "succeeded"].includes(job.status) ? job : undefined;
    } catch (err) {
      if (isRuntimeLost(err)) throw err;
      return undefined;
    }
  }

  /** `graphNodes`: how many nodes the submitted graph has, the most ComfyUI can run. */
  private async follow(job: SdkJob, ctx: StepContext, graphNodes: number): Promise<void> {
    let best = 0.02;
    for await (const ev of job.events(ctx.signal)) {
      if (ev.kind === "statusChange") {
        if (ev.status === "queued") ctx.onProgress({ progress: best, message: ev.queuePosition ? `Waiting in ComfyUI queue (${ev.queuePosition})` : "Waiting in ComfyUI queue" });
        if (ev.status === "running") ctx.onProgress({ progress: best, message: "Running" });
      } else if (ev.kind === "progress") {
        const nodesTotal = ev.nodesTotal ? Math.max(ev.nodesTotal, graphNodes) : 0;
        const inNode = ev.steps && ev.steps > 1 && ev.step !== null ? ev.step / ev.steps : 0;
        const fraction = nodesTotal > 0 ? ((ev.nodesDone ?? 0) + inNode) / nodesTotal : ev.value;
        best = Math.max(best, 0.02 + 0.93 * Math.min(1, fraction));
        const message =
          ev.steps && ev.steps > 1 && ev.step !== null
            ? `Step ${ev.step} of ${ev.steps}`
            : ev.currentNodeClass
              ? `Running ${ev.currentNodeClass}`
              : nodesTotal > 0
                ? `Node ${Math.min(nodesTotal, (ev.nodesDone ?? 0) + 1)} of ${nodesTotal}`
                : undefined;
        ctx.onProgress({ progress: best, message: ev.message ?? message });
      }
    }
  }
}

function describeFailure(job: SdkJob): string {
  const e = job.error as { message?: string; node_id?: string | null; class_type?: string | null } | null;
  if (!e) return `ComfyUI job ended ${job.status}`;
  const where = [e.class_type, e.node_id ? `node ${e.node_id}` : undefined].filter(Boolean).join(" ");
  return `ComfyUI ${job.status}${where ? ` in ${where}` : ""}: ${e.message ?? "no detail"}`;
}
