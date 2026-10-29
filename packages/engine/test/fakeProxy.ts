/**
 * A stand-in for comfy-api-proxy 0.1.6 with what @comfyorg/sdk 0.5.0 uses: asset uploads, job submit, polling, cancel,
 * output downloads (live events answer 501, so the SDK polls). It behaves like a shared GPU box's proxy when things go wrong:
 *
 * - `down()` / `up()`: the proxy itself goes away and comes back on the same port (a dropped ssh tunnel, a restart).
 *   Jobs keep running behind it meanwhile, as they do in ComfyUI.
 * - `comfyDown()` / `comfyBack()`: the ComfyUI behind it goes away (a preemption on a shared GPU box) while the proxy stays up. It
 *   answers 503 `upstream_unreachable` to everything that needs ComfyUI, and /api/v2/health still says healthy. The
 *   jobs ComfyUI had are lost: once it is back the proxy reports them `expired`.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { placeholderScene } from "../src/media/png.js";

interface FakeJob {
  id: string;
  status: "running" | "succeeded" | "canceled" | "expired";
  createdAt: string;
  /** Lost when ComfyUI went away under it. */
  lost: boolean;
  outputs: { nodeId: string; name: string }[];
}

const PNG = placeholderScene(64, 36, "fake proxy output").toPng();

export class FakeProxy {
  url = "";
  /** Jobs as ComfyUI received them, in order. */
  readonly submitted: Record<string, { class_type?: string; inputs: Record<string, unknown> }>[] = [];
  readonly jobs = new Map<string, FakeJob>();
  /** Keep submitted jobs running until `release()`. */
  hold = false;
  private comfyUp = true;
  private server?: Server;
  private sockets = new Set<Socket>();
  private port = 0;

  static async start(): Promise<FakeProxy> {
    const proxy = new FakeProxy();
    await proxy.up();
    return proxy;
  }

  async up(): Promise<void> {
    const server = createServer((req, res) => void this.handle(req, res));
    server.on("connection", (s) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve) => server.listen(this.port, "127.0.0.1", resolve));
    this.port = (server.address() as AddressInfo).port;
    this.url = `http://127.0.0.1:${this.port}`;
    this.server = server;
  }

  /** The proxy is gone: new connections are refused and open ones are cut. */
  async down(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }

  comfyDown(): void {
    this.comfyUp = false;
    for (const job of this.jobs.values()) if (job.status === "running") job.lost = true;
  }

  comfyBack(): void {
    this.comfyUp = true;
    for (const job of this.jobs.values()) if (job.lost) job.status = "expired";
  }

  /** Finish every held job. */
  release(): void {
    this.hold = false;
    for (const job of this.jobs.values()) if (job.status === "running" && !job.lost) job.status = "succeeded";
  }

  running(): FakeJob[] {
    return [...this.jobs.values()].filter((j) => j.status === "running" && !j.lost);
  }

  async close(): Promise<void> {
    await this.down();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.url);
    const path = url.pathname;
    const body = await readAll(req);
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const error = (status: number, code: string, message: string) => json(status, { error: { code, message } });
    const unreachable = () => error(503, "upstream_unreachable", "Could not reach ComfyUI.");

    if (req.method === "GET" && path === "/api/v2/health") return json(200, { status: "healthy", upstream: "http://127.0.0.1:8190" });

    // Assets: uploads are taken at face value; outputs download as a small PNG.
    if (req.method === "HEAD" && path.startsWith("/api/v2/assets/by-hash/")) {
      res.writeHead(404);
      return void res.end();
    }
    if (req.method === "POST" && (path === "/api/v2/assets" || path === "/api/v2/assets/from-hash")) {
      const now = new Date().toISOString();
      const id = `in-${randomUUID()}`;
      return json(201, { id, hash: null, size_bytes: body.length, content_type: "application/octet-stream", created_at: now, url: `${this.url}/api/v2/assets/${id}/content`, url_expires_at: now });
    }
    const content = /^\/api\/v2\/assets\/([^/]+)\/content$/.exec(path);
    if (req.method === "GET" && content) {
      res.writeHead(200, { "content-type": "image/png", "content-length": String(PNG.length) });
      return void res.end(PNG);
    }

    if (req.method === "POST" && path === "/api/v2/jobs") {
      if (!this.comfyUp) return error(503, "upstream_unreachable", "Could not reach ComfyUI to submit the job.");
      const workflow = (JSON.parse(body.toString("utf8")) as { workflow: FakeProxy["submitted"][number] }).workflow;
      this.submitted.push(workflow);
      const outputs = Object.entries(workflow)
        .filter(([, node]) => node.class_type === "SaveImage")
        .map(([nodeId]) => ({ nodeId, name: `fake_${nodeId}_00001_.png` }));
      const job: FakeJob = { id: randomUUID(), status: this.hold ? "running" : "succeeded", createdAt: new Date().toISOString(), lost: false, outputs };
      this.jobs.set(job.id, job);
      return json(201, this.view(job));
    }
    const jobPath = /^\/api\/v2\/jobs\/([^/]+)(\/events|\/cancel)?$/.exec(path);
    if (jobPath) {
      if (!this.comfyUp) return unreachable();
      const job = this.jobs.get(jobPath[1]!);
      if (!job) return error(404, "not_found", `No job ${jobPath[1]}.`);
      if (jobPath[2] === "/events") return error(501, "not_implemented", "Poll GET /jobs/{id} instead.");
      if (jobPath[2] === "/cancel" && req.method === "POST") job.status = "canceled";
      return json(200, this.view(job));
    }
    return error(404, "not_found", `No route ${req.method} ${path}`);
  }

  private view(job: FakeJob) {
    const base = `${this.url}/api/v2/jobs/${job.id}`;
    const expires = new Date(Date.now() + 86_400_000).toISOString();
    return {
      id: job.id,
      status: job.status,
      created_at: job.createdAt,
      started_at: null,
      completed_at: null,
      expires_at: expires,
      queue_position: null,
      progress: null,
      outputs:
        job.status === "succeeded"
          ? job.outputs.map((o) => ({ node_id: o.nodeId, name: o.name, type: "image", content_type: "image/png", size_bytes: 0, id: `out-${job.id}-${o.nodeId}`, hash: null, url: `${this.url}/api/v2/assets/out-${job.id}-${o.nodeId}/content`, url_expires_at: expires }))
          : [],
      error: null,
      urls: { self: base, events: `${base}/events`, cancel: `${base}/cancel` },
    };
  }
}

async function readAll(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
