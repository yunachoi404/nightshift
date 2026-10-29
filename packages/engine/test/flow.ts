/**
 * A project from creation to export through the engine's HTTP API, the way the UI drives it. Shared by the
 * end-to-end tests and scripts/e2e-templates.ts.
 */
import { AssetSchema, JobSchema, ProjectSchema, RuntimeStatusSchema, scriptLines, type Aspect, type Job, type Project, type TemplateId } from "@nightshift/contract";
import { z } from "zod";
import { placeholderScene } from "../src/media/png.js";
import { sleep } from "../src/util.js";

export class Api {
  constructor(readonly url: string) {}

  async call<S extends z.ZodType>(method: string, path: string, schema: S | null, body?: unknown): Promise<z.infer<S>> {
    const res = await fetch(this.url + path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
    const json = text ? JSON.parse(text) : undefined;
    return schema ? schema.parse(json) : json;
  }

  project(id: string): Promise<Project> {
    return this.call("GET", `/api/projects/${id}`, ProjectSchema);
  }

  async job(path: string, body: unknown = {}): Promise<Job> {
    return this.call("POST", path, JobSchema, body);
  }

  async wait(id: string, ms = 300_000): Promise<Job> {
    const end = Date.now() + ms;
    for (;;) {
      const job = (await this.call("GET", "/api/jobs", z.array(JobSchema))).find((j) => j.id === id);
      if (job && ["done", "failed", "cancelled"].includes(job.status)) return job;
      if (Date.now() > end) throw new Error(`job ${id} still ${job?.status}`);
      await sleep(25);
    }
  }

  async run(path: string, body: unknown = {}, ms?: number): Promise<Job> {
    const job = await this.wait((await this.job(path, body)).id, ms);
    if (job.status !== "done") throw new Error(`${job.step} job ${job.status}: ${job.error ?? job.message}`);
    return job;
  }

  /** Wait for every queued or running job of a project. */
  async settle(projectId: string): Promise<void> {
    for (;;) {
      const jobs = await this.call("GET", `/api/jobs?projectId=${projectId}`, z.array(JobSchema));
      const open = jobs.filter((j) => j.status === "queued" || j.status === "running");
      if (open.length === 0) return;
      await this.wait(open[0]!.id);
    }
  }

  async upload(projectId: string, bytes: Uint8Array, filename: string, type: string, role?: string) {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type }), filename);
    const res = await fetch(`${this.url}/api/projects/${projectId}/assets${role ? `?role=${role}` : ""}`, { method: "POST", body: form });
    if (res.status !== 201) throw new Error(`upload ${filename}: ${res.status} ${await res.text()}`);
    return AssetSchema.parse(await res.json());
  }

  async install(tier: string): Promise<void> {
    await this.call("POST", "/api/install", null, { tier, memoryLimitGb: null });
    for (let i = 0; i < 500; i++) {
      const status = await this.call("GET", "/api/status", RuntimeStatusSchema);
      if (status.phase === "ready" && status.tier === tier) return;
      await sleep(20);
    }
    throw new Error(`tier ${tier} did not become ready`);
  }
}

export const BRIEFS: Record<TemplateId, { name: string; brief: Record<string, unknown> }> = {
  what_if: { name: "A moment without gravity", brief: { question: "What if gravity stopped for ten seconds?", look: "cinematic" } },
  cinematic_shot: { name: "Lighthouse", brief: { idea: "a lighthouse on a cliff as a storm rolls in", look: "noir", cameraMove: "dolly_in", sequence: "three", title: "The Keeper" } },
  music_video: { name: "Night drive", brief: { subject: "a late night drive through an empty city", genre: "synth", length: "30", songSource: "write", songPrompt: "slow synthwave, driving at night", title: "Night Drive", artist: "The Lamps" } },
  product_ad: { name: "Lumen ad", brief: { productName: "Lumen", does: "follows the sun across your desk", tone: "warm", voice: "mara", cta: "Order yours today" } },
  talking_intro: {
    name: "Slow ideas",
    brief: { script: "We make time for small things. Each week, one slow idea. Today, how a candle keeps time. Let's start.", visuals: "broll", voice: "june", speakerName: "Ada Park", speakerTitle: "Host" },
  },
  // Quick shots: one shot each, no storyboard writing.
  camera_move: { name: "Harbor move", brief: { prompt: "a quiet harbor at dawn", move: "dolly_in" } },
  vfx_effect: { name: "Statue effect", brief: { prompt: "a marble statue in a museum", effect: "disintegrate" } },
};

const LYRICS = "Headlights on an empty road\nThe city sleeps and we drive on\nNeon rain on the window\nHold on till the morning comes";

export interface FlowResult {
  project: Project;
  exports: { aspect: Aspect; job: Job; assetId: string }[];
}

/**
 * Create a project of a template, storyboard it (stills queue by themselves), draft every shot, finish the first
 * two as same-take finals, add its audio (song, voiceover), then export in each aspect asked for.
 */
export async function runTemplate(api: Api, template: TemplateId, aspect: Aspect, o: { exportAspects?: Aspect[]; quality?: "preview" | "standard" | "high" } = {}): Promise<FlowResult> {
  const { name, brief } = BRIEFS[template];
  let project = await api.call("POST", "/api/projects", ProjectSchema, { name, template, aspect, brief });
  const base = `/api/projects/${project.id}`;
  if (template === "product_ad") {
    const photo = await api.upload(project.id, placeholderScene(768, 768, "lumen product photo").toPng(), "lumen.png", "image/png");
    await api.call("PATCH", base, ProjectSchema, { brief: { ...brief, referenceAssetId: photo.id, referenceKind: "photo" } });
  }
  await api.run(`${base}/storyboard`);
  await api.settle(project.id);
  project = await api.project(project.id);
  for (const shot of project.shots) await api.run(`${base}/shots/${shot.id}/draft`, {});
  project = await api.project(project.id);
  for (const shot of project.shots.slice(0, 2)) await api.run(`${base}/shots/${shot.id}/final`, { draftId: shot.chosenDraftId, kind: "same_take", mode: "now" });

  if (template === "music_video") {
    await api.run(`${base}/audio`, { role: "music", prompt: String(brief.songPrompt), lyrics: LYRICS, durationSec: 30 });
  } else if (template === "product_ad") {
    await api.run(`${base}/audio`, { role: "music", prompt: "warm acoustic bed", durationSec: 20 });
    const lines = (await api.project(project.id)).shots.flatMap((s) => (s.line ? [s.line] : []));
    await api.run(`${base}/audio`, { role: "voice", text: (lines.length ? lines : scriptLines("product_ad", brief)).join(" "), voice: "mara" });
  } else if (template === "talking_intro") {
    await api.run(`${base}/audio`, { role: "voice", text: String(brief.script), voice: "june" });
  } else {
    await api.run(`${base}/audio`, { role: "music", prompt: "slow strings, storm", durationSec: 16 });
    await api.run(`${base}/audio`, { role: "voice", text: "Every night the light still turns. One night, it stops.", voice: "theo" });
  }

  const exports: FlowResult["exports"] = [];
  for (const a of o.exportAspects ?? [aspect]) {
    const job = await api.run(`${base}/export`, { aspect: a, quality: o.quality ?? "preview" }, 600_000);
    exports.push({ aspect: a, job, assetId: job.outputAssetIds[0]! });
  }
  return { project: await api.project(project.id), exports };
}
