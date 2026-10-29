/**
 * A stand-in for a GPU computer's ComfyUI (v0.41.3) on the network, with what the remote check and comfy-api-proxy 0.1.6
 * use: /system_stats, /object_info, /upload/image, /prompt, /history, /queue, /view and job cancel. It has no /ws, so
 * the proxy polls. A graph "runs" by its loaders and savers only: a loader's file must be in the input folder (ComfyUI
 * validates that before it queues anything), a saver writes a small file of its kind to the output folder.
 *
 * `down()` / `up()`: it goes away (a preemption on a shared GPU box) and comes back on the same port without the jobs it had, as a
 * restarted ComfyUI does.
 */
import busboy from "busboy";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { basename, dirname, join } from "node:path";
import { placeholderScene } from "../src/media/png.js";
import type { ObjectInfo, SystemStats } from "../src/remote/check.js";

type Graph = Record<string, { class_type?: string; inputs: Record<string, unknown> }>;

interface FakeJob {
  id: string;
  graph: Graph;
  status: "running" | "done" | "interrupted";
  outputs: Record<string, Record<string, { filename: string; subfolder: string; type: string }[]>>;
}

/** What a DGX Spark's ComfyUI reported (argv left out). */
export const GB10_STATS: SystemStats = {
  system: { os: "linux", ram_total: 130663821312, comfyui_version: "0.41.3" },
  devices: [{ name: "cuda:0 NVIDIA GB10 : native", type: "cuda", vram_total: 130663821312, torch_vram_total: 8887730176 }],
};

/** Loaders and the input that names their file. Everything else just passes. */
const LOADERS: Record<string, string> = { LoadImage: "image", LoadVideo: "file", LoadAudio: "audio", NightshiftLoadAVLatent: "latent" };

export class FakeComfy {
  url = "";
  readonly inputDir: string;
  readonly outputDir: string;
  /** Graphs ComfyUI accepted, in order. */
  readonly prompts: Graph[] = [];
  /** Files received through /upload/image, by name as stored. */
  readonly uploads: string[] = [];
  readonly jobs = new Map<string, FakeJob>();
  /** Keep accepted jobs running until `release()`. */
  hold = false;
  stats: SystemStats = structuredClone(GB10_STATS);
  /** Node types it has, with a model list per loader input ("UNETLoader.unet_name": [...]). */
  nodeTypes: Set<string>;
  modelLists: Record<string, string[]> = {};
  private server?: Server;
  private sockets = new Set<Socket>();
  private port = 0;
  private counters = new Map<string, number>();

  private constructor(
    dir: string,
    private readonly video: string,
    nodeTypes: string[],
  ) {
    this.inputDir = join(dir, "input");
    this.outputDir = join(dir, "output");
    mkdirSync(this.inputDir, { recursive: true });
    mkdirSync(this.outputDir, { recursive: true });
    this.nodeTypes = new Set(nodeTypes);
  }

  /** `video`: an MP4 the video savers put out. */
  static async start(o: { dir: string; video: string; nodeTypes: string[] }): Promise<FakeComfy> {
    const comfy = new FakeComfy(o.dir, o.video, o.nodeTypes);
    await comfy.up();
    return comfy;
  }

  async up(): Promise<void> {
    const server = createServer((req, res) => void this.handle(req, res).catch((err: Error) => this.json(res, 500, { error: err.message })));
    server.on("connection", (s) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve) => server.listen(this.port, "127.0.0.1", resolve));
    this.port = (server.address() as AddressInfo).port;
    this.url = `http://127.0.0.1:${this.port}`;
    this.server = server;
  }

  /** Gone: connections refused, open ones cut, and the jobs it had are forgotten (a restart). */
  async down(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    this.jobs.clear();
  }

  async close(): Promise<void> {
    await this.down();
  }

  release(): void {
    this.hold = false;
    for (const job of this.jobs.values()) if (job.status === "running") this.finish(job);
  }

  running(): FakeJob[] {
    return [...this.jobs.values()].filter((j) => j.status === "running");
  }

  objectInfo(): ObjectInfo {
    const info: ObjectInfo = {};
    for (const type of this.nodeTypes) {
      const required: Record<string, unknown> = {};
      const loaded = LOADERS[type];
      if (loaded) required[loaded] = type === "NightshiftLoadAVLatent" ? ["STRING", { default: "draft.latent" }] : [this.files(this.inputDir)];
      for (const [key, options] of Object.entries(this.modelLists)) {
        const [node, field] = key.split(".") as [string, string];
        // Both of /object_info's list formats.
        if (node === type) required[field] = field.endsWith("_name") ? [options] : ["COMBO", { options }];
      }
      info[type] = { input: { required } };
    }
    return info;
  }

  private files(dir: string): string[] {
    return this.uploads.filter((f) => existsSync(join(dir, f)));
  }

  private json(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const path = url.pathname;
    if (req.method === "GET" && path === "/system_stats") return this.json(res, 200, this.stats);
    if (req.method === "GET" && path === "/object_info") return this.json(res, 200, this.objectInfo());
    if (req.method === "POST" && path === "/upload/image") return this.upload(req, res);
    if (req.method === "POST" && path === "/prompt") return this.prompt(JSON.parse((await readAll(req)).toString("utf8")) as { prompt: Graph; prompt_id: string }, res);
    const history = /^\/history\/([^/]+)$/.exec(path);
    if (req.method === "GET" && history) {
      const job = this.jobs.get(history[1]!);
      if (!job || job.status === "running") return this.json(res, 200, {});
      const done = job.status === "done";
      const messages = done ? [["execution_start", { prompt_id: job.id }], ["execution_success", { prompt_id: job.id }]] : [["execution_interrupted", { prompt_id: job.id }]];
      return this.json(res, 200, { [job.id]: { prompt: [0, job.id, job.graph, {}, []], outputs: job.outputs, status: { status_str: done ? "success" : "error", completed: done, messages } } });
    }
    if (req.method === "GET" && path === "/queue") return this.json(res, 200, { queue_running: this.running().map((j, i) => [i, j.id, j.graph, {}, []]), queue_pending: [] });
    if (req.method === "GET" && path === "/view") {
      const dir = url.searchParams.get("type") === "input" ? this.inputDir : this.outputDir;
      const file = join(dir, url.searchParams.get("subfolder") ?? "", basename(url.searchParams.get("filename") ?? ""));
      if (!existsSync(file)) return this.json(res, 404, { error: "not found" });
      const bytes = readFileSync(file);
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(bytes.length) });
      return void res.end(bytes);
    }
    const cancel = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(path);
    if (req.method === "POST" && cancel) {
      const job = this.jobs.get(cancel[1]!);
      if (job?.status === "running") job.status = "interrupted";
      return this.json(res, 200, {});
    }
    this.json(res, 404, { error: `No route ${req.method} ${path}` });
  }

  /** Like ComfyUI: a file of the same name and bytes is reused, a different one gets a new name. */
  private upload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return new Promise((resolve, reject) => {
      const fields: Record<string, string> = {};
      let file: { name: string; data: Buffer } | undefined;
      const bb = busboy({ headers: req.headers });
      bb.on("field", (name, value) => (fields[name] = value));
      bb.on("file", (_name, stream, info) => {
        const chunks: Buffer[] = [];
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => (file = { name: info.filename ?? "upload.bin", data: Buffer.concat(chunks) }));
      });
      bb.on("error", reject);
      bb.on("close", () => {
        if (!file) return resolve(this.json(res, 400, { error: "no file" }));
        const subfolder = fields.subfolder ?? "";
        let name = file.name;
        for (let i = 1; existsSync(join(this.inputDir, subfolder, name)) && !readFileSync(join(this.inputDir, subfolder, name)).equals(file.data); i++) {
          name = file.name.replace(/(\.[^.]+)?$/, ` (${i})$1`);
        }
        mkdirSync(join(this.inputDir, subfolder), { recursive: true });
        writeFileSync(join(this.inputDir, subfolder, name), file.data);
        this.uploads.push(subfolder ? `${subfolder}/${name}` : name);
        resolve(this.json(res, 200, { name, subfolder, type: "input" }));
      });
      req.pipe(bb);
    });
  }

  private prompt(body: { prompt: Graph; prompt_id: string }, res: ServerResponse): void {
    const graph = body.prompt;
    const nodeErrors: Record<string, unknown> = {};
    for (const [id, node] of Object.entries(graph)) {
      const type = node.class_type ?? "";
      if (!this.nodeTypes.has(type)) return this.json(res, 400, { error: { type: "invalid_prompt", message: `Cannot execute because node ${type} does not exist.` }, node_errors: {} });
      const field = LOADERS[type];
      const value = field ? String(node.inputs[field] ?? "") : "";
      if (field && !existsSync(this.annotated(value))) nodeErrors[id] = { errors: [{ message: `Invalid file: ${value}` }], class_type: type };
    }
    if (Object.keys(nodeErrors).length) return this.json(res, 400, { error: { type: "prompt_outputs_failed_validation", message: "Prompt outputs failed validation" }, node_errors: nodeErrors });
    this.prompts.push(graph);
    const job: FakeJob = { id: body.prompt_id, graph, status: "running", outputs: {} };
    this.jobs.set(job.id, job);
    if (!this.hold) this.finish(job);
    this.json(res, 200, { prompt_id: job.id, number: this.prompts.length, node_errors: {} });
  }

  /** "x.latent", "x.latent [output]": where ComfyUI's annotated paths point. */
  private annotated(value: string): string {
    const m = /^(.*?)\s*\[(input|output)\]$/.exec(value);
    return m ? join(m[2] === "output" ? this.outputDir : this.inputDir, m[1]!) : join(this.inputDir, value);
  }

  private finish(job: FakeJob): void {
    for (const [id, node] of Object.entries(job.graph)) {
      const type = node.class_type ?? "";
      const save = type === "SaveImage" ? { key: "images", ext: "png" } : type === "SaveVideo" ? { key: "images", ext: "mp4" } : type === "NightshiftSaveAVLatent" ? { key: "latents", ext: "latent" } : undefined;
      if (!save) continue;
      const prefix = String(node.inputs.filename_prefix ?? "ComfyUI");
      const count = (this.counters.get(prefix) ?? 0) + 1;
      this.counters.set(prefix, count);
      const subfolder = dirname(prefix) === "." ? "" : dirname(prefix);
      const filename = `${basename(prefix)}_${String(count).padStart(5, "0")}_.${save.ext}`;
      const dest = join(this.outputDir, subfolder, filename);
      mkdirSync(dirname(dest), { recursive: true });
      if (save.ext === "png") writeFileSync(dest, placeholderScene(64, 36, "fake comfy").toPng());
      else if (save.ext === "mp4") copyFileSync(this.video, dest);
      else writeFileSync(dest, `nightshift-latent from ${job.id}`);
      job.outputs[id] = { [save.key]: [{ filename, subfolder, type: "output" }] };
    }
    job.status = "done";
  }
}

async function readAll(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
