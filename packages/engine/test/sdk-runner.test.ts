/**
 * The SDK runner against a fake Comfy client that behaves like @comfyorg/sdk 0.5.0 talking to
 * comfy-api-proxy 0.1.6, quirks included.
 */
import type { Comfy } from "@comfyorg/sdk";
import type { WorkflowRef } from "@nightshift/contract";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeLostError, ShutdownError } from "../src/errors.js";
import { defaultWorkflowsDir } from "../src/paths.js";
import { SdkStepRunner } from "../src/runner/sdk.js";
import type { StepProgress, StepRequest } from "../src/runner/types.js";

interface FakeOutput {
  nodeId: string;
  name: string;
  type: string;
  bytes: string;
}

function fakeClient(o: { outputs: FakeOutput[]; status?: string; error?: unknown; events?: unknown[]; hang?: boolean; onEvents?: () => void; existing?: Record<string, string> }) {
  const calls = { submitted: undefined as Record<string, { inputs: Record<string, unknown> }> | undefined, uploads: [] as string[], cancelled: false, fetched: [] as string[] };
  const job = {
    id: "comfy-job-1",
    status: "queued",
    error: null as unknown,
    async *events(signal?: AbortSignal) {
      signal?.throwIfAborted();
      o.onEvents?.();
      for (const ev of o.events ?? []) yield ev;
      if (o.hang) {
        await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      }
    },
    async refresh() {
      job.status = o.status ?? "succeeded";
      job.error = o.error ?? null;
      return job;
    },
    async wait() {
      return job.refresh();
    },
    getOutputs(nodeId: string) {
      return o.outputs
        .filter((x) => x.nodeId === nodeId)
        .map((x) => ({
          nodeId: x.nodeId,
          name: x.name,
          type: x.type,
          sizeBytes: 0, // the proxy always reports 0
          toFile: async (path: string) => (writeFileSync(path, x.bytes), path),
        }));
    },
    async cancel() {
      calls.cancelled = true;
      return job;
    },
  };
  const client = {
    workflows: {
      fromJson: (graph: Record<string, { inputs: Record<string, unknown> }>) => ({
        json: graph,
        setInput: (node: string, field: string, value: unknown) => void (graph[node]!.inputs[field] = value),
      }),
    },
    assets: { fromFile: (path: string) => (calls.uploads.push(path), { asset: path }) },
    submit: async (wf: { json: Record<string, { inputs: Record<string, unknown> }> }) => ((calls.submitted = wf.json), job),
    jobs: {
      get: async (id: string) => {
        calls.fetched.push(id);
        const status = o.existing?.[id];
        if (!status) throw new Error("NotFound");
        // A live job is followed in full; a dead one is only looked at.
        return status === "running" ? Object.assign(job, { id, status }) : { id, status };
      },
    },
  };
  return { client: client as unknown as Comfy, calls };
}

const ref: WorkflowRef = {
  workflow: "layout_to_render.api.json",
  inputs: { prompt: { node: "5508", field: "value" }, video: { node: "5001", field: "file" }, seed: { node: "5516:4832", field: "noise_seed" } },
  params: {},
  outputNodes: ["4852"],
};

function request(outDir: string, values: Record<string, unknown>): StepRequest {
  return { jobId: "job_1", step: "video_draft", ref, values, outDir, hints: { aspect: "16:9", width: 960, height: 544 } };
}

describe("SdkStepRunner", () => {
  it("binds inputs, uploads files, maps progress, and keeps only the declared output nodes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-sdk-"));
    writeFileSync(join(dir, "layout.mp4"), "layout");
    const { client, calls } = fakeClient({
      outputs: [
        { nodeId: "5001", name: "layout.mp4", type: "video", bytes: "the input echoed back" }, // LoadVideo quirk
        { nodeId: "4852", name: "ohf/layout_to_render_00001_.mp4", type: "image", bytes: "rendered video" }, // SaveVideo typed image
      ],
      events: [
        { kind: "statusChange", status: "queued", queuePosition: 2 },
        { kind: "statusChange", status: "running", queuePosition: null },
        { kind: "progress", value: 0.5, message: null, nodesDone: 2, nodesTotal: 4, currentNode: "x", currentNodeClass: null, step: 4, steps: 8 },
      ],
    });
    const progress: StepProgress[] = [];
    const runner = new SdkStepRunner(() => client, defaultWorkflowsDir(), () => undefined);
    const out = await runner.run(request(join(dir, "out"), { prompt: "a street", seed: 9, video: join(dir, "layout.mp4") }), {
      signal: new AbortController().signal,
      onProgress: (p) => progress.push(p),
    });
    expect(calls.submitted!["5508"]!.inputs.value).toBe("a street");
    expect(calls.submitted!["5516:4832"]!.inputs.noise_seed).toBe(9);
    expect(calls.submitted!["5001"]!.inputs.file).toEqual({ asset: join(dir, "layout.mp4") });
    expect(calls.uploads).toEqual([join(dir, "layout.mp4")]);
    expect(out).toEqual([{ path: join(dir, "out", "4852_layout_to_render_00001_.mp4"), kind: "video", nodeId: "4852" }]);
    expect(readFileSync(out[0]!.path, "utf8")).toBe("rendered video");
    expect(progress.map((p) => p.message)).toEqual(["Uploading inputs", "Waiting in ComfyUI queue (2)", "Running", "Step 4 of 8", "Saving outputs"]);
    // (2 nodes done + 4/8 of the third) of the graph's nodes: the proxy's total of 4 is only the nodes reached so far
    const nodes = Object.keys(JSON.parse(readFileSync(join(defaultWorkflowsDir(), ref.workflow), "utf8")) as object).length;
    expect(nodes).toBeGreaterThan(4);
    expect(progress[3]!.progress).toBeCloseTo(0.02 + 0.93 * (2.5 / nodes), 5);
  });

  it("progress counts the whole graph, not only the nodes ComfyUI has reached", async () => {
    // As comfy-api-proxy 0.1.6 reported a MOSS still on an 8 GB card: halfway through the sampler, the 9th of 11 nodes.
    const still: WorkflowRef = { workflow: "moss_image_gptq_encoder.api.json", inputs: {}, params: {}, outputNodes: ["11"] };
    const { client } = fakeClient({
      outputs: [{ nodeId: "11", name: "nightshift/moss_00001_.png", type: "image", bytes: "png" }],
      events: [{ kind: "progress", value: 0.9466, message: null, nodesDone: 8, nodesTotal: 9, currentNode: "9", currentNodeClass: null, step: 26, steps: 50 }],
    });
    const progress: StepProgress[] = [];
    const runner = new SdkStepRunner(() => client, defaultWorkflowsDir(), () => undefined);
    const dir = mkdtempSync(join(tmpdir(), "ns-sdk-"));
    await runner.run({ ...request(dir, {}), step: "still", ref: still }, { signal: new AbortController().signal, onProgress: (p) => progress.push(p) });
    const sampling = progress.find((p) => p.message === "Step 26 of 50")!;
    expect(sampling.progress).toBeCloseTo(0.02 + 0.93 * ((8 + 26 / 50) / 11), 5);
    expect(sampling.progress).toBeLessThan(0.8);
  });

  it("a proxy that lost ComfyUI becomes a retryable RuntimeLostError", async () => {
    const { client } = fakeClient({ outputs: [], status: "failed", error: { message: "Could not reach ComfyUI.", node_id: null, class_type: null } });
    const runner = new SdkStepRunner(() => client, defaultWorkflowsDir(), () => undefined);
    const dir = mkdtempSync(join(tmpdir(), "ns-sdk-"));
    await expect(runner.run(request(dir, {}), { signal: new AbortController().signal, onProgress: () => undefined })).rejects.toBeInstanceOf(RuntimeLostError);
  });

  it("a node error is a plain failure naming the node", async () => {
    const { client } = fakeClient({ outputs: [], status: "failed", error: { message: "CUDA out of memory", node_id: "5516:4829", class_type: "SamplerCustomAdvanced" } });
    const runner = new SdkStepRunner(() => client, defaultWorkflowsDir(), () => undefined);
    const dir = mkdtempSync(join(tmpdir(), "ns-sdk-"));
    const err = await runner.run(request(dir, {}), { signal: new AbortController().signal, onProgress: () => undefined }).catch((e: Error) => e);
    expect(err).not.toBeInstanceOf(RuntimeLostError);
    expect((err as Error).message).toBe("ComfyUI failed in SamplerCustomAdvanced node 5516:4829: CUDA out of memory");
  });

  it("succeeded but nothing from the output nodes is an error, not a silent empty result", async () => {
    const { client } = fakeClient({ outputs: [{ nodeId: "5001", name: "layout.mp4", type: "video", bytes: "x" }] });
    const runner = new SdkStepRunner(() => client, defaultWorkflowsDir(), () => undefined);
    const dir = mkdtempSync(join(tmpdir(), "ns-sdk-"));
    await expect(runner.run(request(dir, {}), { signal: new AbortController().signal, onProgress: () => undefined })).rejects.toThrow(/produced no files/);
  });

  it("a retry follows the ComfyUI job it already submitted instead of submitting twice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-sdk-"));
    const { client, calls } = fakeClient({ outputs: [{ nodeId: "4852", name: "a.mp4", type: "image", bytes: "v" }], existing: { "comfy-old": "running" } });
    const submitted: string[] = [];
    const runner = new SdkStepRunner(() => client, defaultWorkflowsDir(), () => undefined);
    const out = await runner.run(
      { ...request(dir, {}), resumeComfyJobId: "comfy-old" },
      { signal: new AbortController().signal, onProgress: () => undefined, onSubmitted: (id) => submitted.push(id) },
    );
    expect(calls.fetched).toEqual(["comfy-old"]);
    expect(calls.submitted).toBeUndefined();
    expect(submitted).toEqual([]);
    expect(out).toHaveLength(1);
  });

  it("a failed or unknown earlier ComfyUI job is submitted again, and the new id is reported", async () => {
    for (const existing of [{ "comfy-old": "failed" }, {}] as Record<string, string>[]) {
      const dir = mkdtempSync(join(tmpdir(), "ns-sdk-"));
      const { client, calls } = fakeClient({ outputs: [{ nodeId: "4852", name: "a.mp4", type: "image", bytes: "v" }], existing });
      const submitted: string[] = [];
      const runner = new SdkStepRunner(() => client, defaultWorkflowsDir(), () => undefined);
      await runner.run({ ...request(dir, {}), resumeComfyJobId: "comfy-old" }, { signal: new AbortController().signal, onProgress: () => undefined, onSubmitted: (id) => submitted.push(id) });
      expect(calls.submitted).toBeDefined();
      expect(submitted).toEqual(["comfy-job-1"]);
    }
  });

  it("cancelling cancels the ComfyUI job too", async () => {
    let listening!: () => void;
    const ready = new Promise<void>((resolve) => { listening = resolve; });
    const { client, calls } = fakeClient({ outputs: [], hang: true, onEvents: listening });
    const runner = new SdkStepRunner(() => client, defaultWorkflowsDir(), () => undefined);
    const dir = mkdtempSync(join(tmpdir(), "ns-sdk-"));
    const ac = new AbortController();
    const run = runner.run(request(dir, {}), { signal: ac.signal, onProgress: () => undefined });
    await ready;
    ac.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(calls.cancelled).toBe(true);
  });

  it("engine shutdown leaves a remote generation running for the next engine to follow", async () => {
    let listening!: () => void;
    const ready = new Promise<void>((resolve) => { listening = resolve; });
    const { client, calls } = fakeClient({ outputs: [], hang: true, onEvents: listening });
    const runner = new SdkStepRunner(() => client, defaultWorkflowsDir(), () => undefined);
    const ac = new AbortController();
    const run = runner.run(request(mkdtempSync(join(tmpdir(), "ns-sdk-")), {}), { signal: ac.signal, onProgress: () => undefined });
    await ready;
    ac.abort(new ShutdownError());
    await expect(run).rejects.toBeInstanceOf(Error);
    expect(calls.cancelled).toBe(false);
  });

  it("a cancellation arriving after reattachment is retried, not reported as a failed take", async () => {
    const { client } = fakeClient({ outputs: [], existing: { "comfy-old": "running" }, status: "canceled" });
    const runner = new SdkStepRunner(() => client, defaultWorkflowsDir(), () => undefined);
    await expect(runner.run({ ...request(mkdtempSync(join(tmpdir(), "ns-sdk-")), {}), resumeComfyJobId: "comfy-old" }, {
      signal: new AbortController().signal, onProgress: () => undefined,
    })).rejects.toBeInstanceOf(RuntimeLostError);
  });
});
