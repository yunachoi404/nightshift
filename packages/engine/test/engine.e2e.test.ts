/**
 * The whole API end to end, in mock mode: onboarding, a project from brief to export, uploads, cancel,
 * persistence across a restart, static web serving. Every response is checked against the contract.
 */
import {
  AssetSchema,
  ErrorResponseSchema,
  EventSchema,
  HardwareProfileSchema,
  InstallPlanSchema,
  JobSchema,
  ProjectSchema,
  routes,
  RuntimeStatusSchema,
  SettingsSchema,
  TierSummarySchema,
  type Event,
  type HardwareProfile,
  type Job,
  type Project,
} from "@nightshift/contract";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { startEngine, type EngineHandle } from "../src/engine.js";
import { findFfmpeg } from "../src/media/ffmpeg.js";
import { placeholderScene } from "../src/media/png.js";
import { SAMPLE_RECIPES_DIR } from "../src/paths.js";
import { sleep } from "../src/util.js";

const hasFfmpeg = !!(await findFfmpeg());
const dataDir = mkdtempSync(join(tmpdir(), "ns-e2e-"));
const webDir = mkdtempSync(join(tmpdir(), "ns-web-"));
writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Nightshift</title>");
mkdirSync(join(webDir, "assets"));
writeFileSync(join(webDir, "assets", "app-3f9a2b1c.js"), "console.log(1)");

let engine: EngineHandle;
const events: Event[] = [];
let sse: AbortController;

const start = () => startEngine({ port: 0, dataDir, webDir, mock: true, mockSpeed: 0, recipesDir: SAMPLE_RECIPES_DIR, log: () => undefined });

async function api<S extends z.ZodType>(method: string, path: string, schema: S | null, body?: unknown, expectStatus?: number): Promise<z.infer<S>> {
  const res = await fetch(engine.url + path, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (expectStatus !== undefined) expect(res.status, `${method} ${path}: ${text}`).toBe(expectStatus);
  else expect(res.ok, `${method} ${path}: ${res.status} ${text}`).toBe(true);
  return schema ? schema.parse(json) : json;
}

async function listen(): Promise<void> {
  sse = new AbortController();
  const res = await fetch(`${engine.url}/api/events`, { signal: sse.signal });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  void (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of res.body!) {
        buf += decoder.decode(chunk as Uint8Array, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split("\n").find((l) => l.startsWith("data: "));
          if (data) events.push(EventSchema.parse(JSON.parse(data.slice(6))));
        }
      }
    } catch {
      // aborted
    }
  })();
}

// Measuring a song or a voiceover runs ffmpeg and speech timing on the CPU: allow for a busy machine.
async function waitJob(id: string, ms = 60_000): Promise<Job> {
  const end = Date.now() + ms;
  for (;;) {
    const job = (await api("GET", "/api/jobs", z.array(JobSchema))).find((j) => j.id === id);
    if (job && ["done", "failed", "cancelled"].includes(job.status)) return job;
    if (Date.now() > end) throw new Error(`job ${id} still ${job?.status}`);
    await sleep(25);
  }
}

const M4_MAX: HardwareProfile = {
  os: "macos",
  arch: "arm64",
  cpu: "Apple M4 Max",
  ramGb: 128,
  gpus: [{ vendor: "apple", name: "Apple M4 Max", vramGb: 128, unifiedMemory: true }],
  freeDiskGb: 400,
  source: "manual",
};

beforeAll(async () => {
  engine = await start();
  await listen();
});

afterAll(async () => {
  sse?.abort();
  await engine?.stop();
});

describe("mock engine, end to end", () => {
  let project: Project;

  it("serves every route in the contract", async () => {
    for (const spec of Object.values(routes)) {
      const [method, path] = spec.split(" ") as [string, string];
      if (path === "/api/events") continue; // streams; checked separately
      if (spec === routes.onboardingSample) continue; // makes the sample project; onboarding.e2e.test.ts covers it
      const url = path.split("?")[0]!.replace(/:(\w+)/g, "x_$1");
      const res = await fetch(engine.url + url, { method, ...(method === "GET" || method === "DELETE" ? {} : { body: "{}", headers: { "content-type": "application/json" } }) });
      const body = await res.text();
      expect(body, spec).not.toContain("No route");
      if (!res.ok) expect(ErrorResponseSchema.safeParse(JSON.parse(body)).success, spec).toBe(true);
    }
  });

  it("onboarding: hardware, manual override, tiers, plan, install", async () => {
    const detected = await api("GET", "/api/hardware", HardwareProfileSchema);
    expect(detected.source).toBe("detected");
    const manual = await api("POST", "/api/hardware", HardwareProfileSchema, { ...M4_MAX, source: "detected" });
    expect(manual).toMatchObject({ source: "manual", cpu: "Apple M4 Max" });
    // Free disk is always measured, never taken from the manual entry. Other programs can write between the two reads.
    expect(manual.freeDiskGb).not.toBe(M4_MAX.freeDiskGb);
    expect(Math.abs(manual.freeDiskGb - detected.freeDiskGb)).toBeLessThan(2);

    const tiers = await api("GET", "/api/tiers", z.array(TierSummarySchema));
    expect(tiers.filter((t) => t.recommended).map((t) => t.tier)).toEqual(["apple-64"]);
    const apple64 = tiers.find((t) => t.tier === "apple-64")!;
    expect(apple64.steps).toContain("video_final_remaster");
    expect(tiers.find((t) => t.tier === "apple-16")!.steps).not.toContain("video_final_remaster");
    expect(apple64.defaultMemoryLimitGb).toBe(96);
    expect(apple64.estimates?.video_draft).toMatchObject({ peakGb: expect.any(Number), measured: false });

    const plan = await api("GET", "/api/install/plan?tier=apple-64", InstallPlanSchema);
    expect(plan.downloads.length).toBeGreaterThan(0);
    expect(plan.totalDownloadGb).toBeGreaterThan(10);
    expect((await api("GET", "/api/install/plan", InstallPlanSchema)).tier).toBe("apple-64"); // defaults to the recommended tier
    await api("GET", "/api/install/plan?tier=nope", ErrorResponseSchema, undefined, 404);

    // The mode is there from the first request, so the UI can label a demo before anything is installed.
    expect(await api("GET", "/api/status", RuntimeStatusSchema)).toMatchObject({ phase: "not_installed", mode: "mock" });
    expect(events.find((e) => e.type === "runtime")).toMatchObject({ status: { mode: "mock" } });
    expect(plan.simulated).toBe(true);
    await api("POST", "/api/install", ErrorResponseSchema, { tier: "apple-64", memoryLimitGb: -1 }, 400);
    const accepted = await api("POST", "/api/install", RuntimeStatusSchema, { tier: "apple-64", memoryLimitGb: 96 }, 202);
    expect(accepted.phase).toBe("installing");
    for (let i = 0; i < 200 && (await api("GET", "/api/status", RuntimeStatusSchema)).phase !== "ready"; i++) await sleep(20);
    expect(await api("GET", "/api/status", RuntimeStatusSchema)).toMatchObject({ phase: "ready", tier: "apple-64" });
    expect(await api("GET", "/api/settings", SettingsSchema)).toMatchObject({ tier: "apple-64", memoryLimitGb: 96 });

    const installEvents = events.filter((e): e is Extract<Event, { type: "install" }> => e.type === "install");
    expect(installEvents.at(-1)?.progress.message).toBe("Installed");
    expect(installEvents.some((e) => e.progress.modelId !== null && e.progress.doneGb > 0)).toBe(true);
    expect(events.filter((e) => e.type === "runtime").map((e) => (e as Extract<Event, { type: "runtime" }>).status.phase)).toEqual(
      expect.arrayContaining(["not_installed", "installing", "starting", "ready"]),
    );

    await api("DELETE", "/api/hardware", HardwareProfileSchema);
  });

  it("settings: partial updates and validation", async () => {
    const s = await api("PATCH", "/api/settings", SettingsSchema, { overnight: { enabled: true } });
    expect(s.overnight).toEqual({ enabled: true, startAt: "23:00", endAt: "07:00" });
    await api("PATCH", "/api/settings", ErrorResponseSchema, { overnight: { startAt: "25:00" } }, 400);
  });

  it("project: create, upload a reference the way the UI does, storyboard, stills queue by themselves", async () => {
    await api("POST", "/api/projects", ErrorResponseSchema, { name: "", template: "cinematic_shot", aspect: "16:9" }, 400);
    const brief = { idea: "a lighthouse in a storm", look: "noir", cameraMove: "orbit_left", sequence: "three" };
    project = await api("POST", "/api/projects", ProjectSchema, { name: "Lighthouse", template: "cinematic_shot", aspect: "16:9", brief }, 201);
    expect(project).toMatchObject({ takes: [], assets: [], timeline: null });
    // A new film starts with its template's shot list on one board, and queues nothing.
    expect(project.shots.map((s) => [s.index, s.cameraMove, s.stillAssetId])).toEqual([[0, "static", undefined], [1, "orbit_left", undefined], [2, "handheld", undefined]]);
    expect(project.boards).toEqual([{ id: "board_main", name: "Shots", items: project.shots.map((s) => s.id) }]);
    expect(await api("GET", `/api/jobs?projectId=${project.id}`, z.array(JobSchema))).toEqual([]);

    // Multipart with a "file" field, as apps/web/src/api/http.ts sends it.
    const png = placeholderScene(64, 36, "ref").toPng();
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "photo.png");
    const res = await fetch(`${engine.url}/api/projects/${project.id}/assets`, { method: "POST", body: form });
    expect(res.status).toBe(201);
    const ref = AssetSchema.parse(await res.json());
    expect(ref).toMatchObject({ kind: "image", role: "reference", width: 64, height: 36 });
    const bytes = Buffer.from(await (await fetch(`${engine.url}/api/projects/${project.id}/assets/${ref.id}`)).arrayBuffer());
    expect(bytes.equals(png)).toBe(true);
    // Raw bytes still work, and a multipart body without "file" is a clear 400.
    const raw = await fetch(`${engine.url}/api/projects/${project.id}/assets?filename=song.wav`, { method: "POST", body: Buffer.from("RIFF....WAVE"), headers: { "content-type": "audio/wav" } });
    expect(AssetSchema.parse(await raw.json())).toMatchObject({ kind: "audio", role: "reference" });
    const wrongField = new FormData();
    wrongField.append("photo", new Blob([new Uint8Array(png)], { type: "image/png" }), "photo.png");
    expect((await fetch(`${engine.url}/api/projects/${project.id}/assets`, { method: "POST", body: wrongField })).status).toBe(400);
    const text = new FormData();
    text.append("file", new Blob(["hello"], { type: "text/plain" }), "notes.txt");
    expect((await fetch(`${engine.url}/api/projects/${project.id}/assets`, { method: "POST", body: text })).status).toBe(415);

    project = await api("PATCH", `/api/projects/${project.id}`, ProjectSchema, { brief: { ...brief, referenceAssetId: ref.id, referenceKind: "photo" } });
    const job = await api("POST", `/api/projects/${project.id}/storyboard`, JobSchema, undefined, 202);
    expect(await waitJob(job.id)).toMatchObject({ status: "done", step: "text" });
    project = await api("GET", `/api/projects/${project.id}`, ProjectSchema);
    expect(project.shots.map((s) => [s.index, s.cameraMove, s.durationSec])).toEqual([
      [0, "static", 4],
      [1, "orbit_left", 4],
      [2, "handheld", 3.5],
    ]);
    expect(project.shots[0]!.prompt).toContain("Hard single light, black and silver");
    expect(events.some((e) => e.type === "project" && e.project.id === project.id && e.project.shots.length === 3)).toBe(true);
    // Like the UI mock, the engine queues a still for every shot.
    const stills = (await api("GET", `/api/jobs?projectId=${project.id}`, z.array(JobSchema))).filter((j) => j.step === "still");
    expect(stills.map((j) => j.shotId).sort()).toEqual(project.shots.map((s) => s.id).sort());
  });

  // A real 1080p render: give it room when other test files render at the same time.
  it("still, draft, same-take final, remaster, music, voice, export", { skip: !hasFfmpeg, timeout: 240_000 }, async () => {
    const shot = project.shots[0]!;
    const base = `/api/projects/${project.id}`;
    for (const j of (await api("GET", `/api/jobs?projectId=${project.id}`, z.array(JobSchema))).filter((x) => x.step === "still")) await waitJob(j.id);
    project = await api("GET", base, ProjectSchema);
    expect(project.shots.every((s) => s.stillAssetId)).toBe(true);
    // A shot added by hand has no still yet: its draft has to wait for one.
    const bare = { id: "shot_bare", index: 3, prompt: "Gulls", durationSec: 2, locked: false };
    project = await api("PATCH", base, ProjectSchema, { shots: [...project.shots, bare] });
    await api("POST", `${base}/shots/${bare.id}/draft`, ErrorResponseSchema, {}, 409);
    project = await api("PATCH", base, ProjectSchema, { shots: project.shots.filter((s) => s.id !== bare.id) });

    const still = await waitJob((await api("POST", `${base}/shots/${shot.id}/still`, JobSchema, { seed: 7 }, 202)).id);
    expect(still).toMatchObject({ status: "done", outputAssetIds: [expect.any(String)] });
    expect(still.peakGb).toBeGreaterThan(0);

    const queued = await api("POST", `${base}/shots/${shot.id}/draft`, JobSchema, { seed: 1234 }, 202);
    expect((await api("GET", base, ProjectSchema)).takes).toEqual([]); // takes appear when the job is done
    const draftJob = await waitJob(queued.id);
    expect(draftJob.status).toBe("done");
    project = await api("GET", base, ProjectSchema);
    const draft = project.takes.find((t) => t.rung === "draft")!;
    expect(draft).toMatchObject({ seed: 1234, videoAssetId: expect.any(String), latentAssetId: expect.any(String), jobId: queued.id });
    expect(project.shots[0]).toMatchObject({ stillAssetId: still.outputAssetIds[0], chosenDraftId: draft.id });
    const video = project.assets.find((a) => a.id === draft.videoAssetId)!;
    expect(video).toMatchObject({ kind: "video", width: expect.any(Number), durationSec: expect.any(Number) });

    // Video seeking needs Range support.
    const ranged = await fetch(`${engine.url}${base}/assets/${video.id}`, { headers: { Range: "bytes=0-99" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-type")).toBe("video/mp4");
    expect((await ranged.arrayBuffer()).byteLength).toBe(100);
    const head = await fetch(`${engine.url}${base}/assets/${video.id}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(Number(head.headers.get("content-length"))).toBeGreaterThan(1000);

    const same = await waitJob((await api("POST", `${base}/shots/${shot.id}/final`, JobSchema, { draftId: draft.id, kind: "same_take", mode: "now" }, 202)).id);
    expect(same).toMatchObject({ status: "done", step: "video_final_same_take" });
    const remaster = await waitJob((await api("POST", `${base}/shots/${shot.id}/final`, JobSchema, { draftId: draft.id, kind: "remaster", mode: "now" }, 202)).id);
    expect(remaster.status).toBe("done");
    project = await api("GET", base, ProjectSchema);
    const finals = project.takes.filter((t) => t.rung === "final");
    expect(finals.map((t) => [t.finalKind, t.parentTakeId, t.seed])).toEqual([
      ["same_take", draft.id, 1234],
      ["remaster", draft.id, 1234],
    ]);
    expect(project.shots[0]!.chosenFinalId).toBe(finals[1]!.id);

    await api("POST", `${base}/audio`, ErrorResponseSchema, { role: "voice" }, 400);
    const song = await waitJob((await api("POST", `${base}/audio`, JobSchema, { role: "music", prompt: "slow synthwave", durationSec: 6 }, 202)).id);
    const voice = await waitJob((await api("POST", `${base}/audio`, JobSchema, { role: "voice", text: "The light still turns. Then it stops.", voice: "mara" }, 202)).id);
    // Each track is measured by an analysis job on the CPU worker after the GPU made it.
    const analyses = (await api("GET", `/api/jobs?projectId=${project.id}`, z.array(JobSchema))).filter((j) => j.analysis);
    expect(analyses.map((j) => j.step).sort()).toEqual(["music", "voice"]);
    for (const j of analyses) expect(await waitJob(j.id)).toMatchObject({ status: "done", message: expect.stringMatching(/measured/) });
    project = await api("GET", base, ProjectSchema);
    expect(project.assets.filter((a) => a.kind === "audio").map((a) => a.role)).toEqual(["reference", "music", "voice"]);
    expect([song.status, voice.status]).toEqual(["done", "done"]);
    // Both tracks land on a default cut of the shots, and the voice brings captions.
    expect(project.timeline!.clips.map((c) => c.shotId)).toEqual(project.shots.map((s) => s.id));
    expect(project.timeline!.audio.map((a) => [a.role, a.assetId])).toEqual([
      ["music", song.outputAssetIds[0]],
      ["voice", voice.outputAssetIds[0]],
    ]);
    expect(project.timeline!.captions.map((c) => c.text)).toEqual(["The light still turns.", "Then it stops."]);
    expect(project.timeline!.captions[0]!.words?.map((w) => w.text)).toEqual(["The", "light", "still", "turns."]);

    const exp = await waitJob((await api("POST", `${base}/export`, JobSchema, { aspect: "9:16" }, 202)).id, 120_000);
    expect(exp.status, exp.error).toBe("done");
    expect(exp.message).toMatch(/^Exported 1080x1920, [\d.]+ s, [\d.]+ MB, captions/);
    project = await api("GET", base, ProjectSchema);
    const out = project.assets.find((a) => a.id === exp.outputAssetIds[0])!;
    expect(out).toMatchObject({ kind: "video", role: "export", width: 1080, height: 1920 });

    const jobEvents = events.filter((e): e is Extract<Event, { type: "job" }> => e.type === "job" && e.job.projectId === project.id);
    expect(new Set(jobEvents.map((e) => e.job.status))).toEqual(new Set(["queued", "running", "done"]));
  });

  it("overnight finals wait for the window and can be cancelled without leaving a take", { skip: !hasFfmpeg }, async () => {
    const base = `/api/projects/${project.id}`;
    const shot = project.shots[0]!;
    const draft = project.takes.find((t) => t.rung === "draft")!;
    // A one-minute window two hours from now, so the final waits whatever the time of day the tests run.
    const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toTimeString().slice(0, 5);
    await api("PATCH", "/api/settings", SettingsSchema, { overnight: { enabled: true, startAt: at(120), endAt: at(121) } });
    const job = await api("POST", `${base}/shots/${shot.id}/final`, JobSchema, { draftId: draft.id, kind: "remaster", mode: "overnight" }, 202);
    await sleep(100);
    expect((await api("GET", `/api/jobs?projectId=${project.id}`, z.array(JobSchema))).find((j) => j.id === job.id)?.status).toBe("queued");
    expect(await api("POST", `/api/jobs/${job.id}/cancel`, JobSchema)).toMatchObject({ status: "cancelled" });
    expect((await api("GET", base, ProjectSchema)).takes.some((t) => t.jobId === job.id)).toBe(false);
  });

  it("shot edits are validated and the array order becomes the storyboard order", async () => {
    const base = `/api/projects/${project.id}`;
    const current = await api("GET", base, ProjectSchema);
    const extra = { id: "shot_extra", index: 9, prompt: "Waves on rocks", durationSec: 3, locked: true };
    const updated = await api("PATCH", base, ProjectSchema, { shots: [extra, ...current.shots] });
    expect(updated.shots.map((s) => [s.id, s.index])).toEqual([["shot_extra", 0], ...current.shots.map((s, i) => [s.id, i + 1])]);
    // A stale copy that leaves out the job-set links does not wipe them.
    const { stillAssetId: _s, chosenDraftId: _d, chosenFinalId: _f, ...stale } = current.shots[0]!;
    const kept = await api("PATCH", base, ProjectSchema, { shots: [extra, stale] });
    expect(kept.shots[1]).toMatchObject({ stillAssetId: current.shots[0]!.stillAssetId, chosenDraftId: current.shots[0]!.chosenDraftId });
    await api("PATCH", base, ErrorResponseSchema, { shots: [{ ...extra, chosenDraftId: "take_nope" }] }, 400);
    await api("PATCH", base, ErrorResponseSchema, { shots: [extra, extra] }, 400);
  });

  it("serves the web UI with a SPA fallback, and JSON 404s under /api", async () => {
    const index = await fetch(`${engine.url}/projects/abc`);
    expect(index.headers.get("content-type")).toContain("text/html");
    expect(await index.text()).toContain("<title>Nightshift</title>");
    const asset = await fetch(`${engine.url}/assets/app-3f9a2b1c.js`);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await fetch(`${engine.url}/../../etc/passwd`)).status).toBe(200); // normalized to the SPA, never outside webDir
    const missing = await fetch(`${engine.url}/api/nope`);
    expect(missing.status).toBe(404);
    expect(ErrorResponseSchema.parse(await missing.json()).error).toContain("No route");
  });

  it("allows the UI dev server's localhost origin, nothing else", async () => {
    const ok = await fetch(`${engine.url}/api/status`, { headers: { Origin: "http://localhost:5173" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    const other = await fetch(`${engine.url}/api/status`, { headers: { Origin: "https://evil.example" } });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses writes from other sites' pages and DNS-rebound hosts", async () => {
    const evil = await fetch(`${engine.url}/api/projects`, { method: "POST", headers: { Origin: "https://evil.example", "content-type": "text/plain" }, body: "{}" });
    expect(evil.status).toBe(403);
    expect(ErrorResponseSchema.parse(await evil.json()).error).toContain("Origin");
    // Reads carry no risk from Origin alone (the browser hides the answer without CORS).
    expect((await fetch(`${engine.url}/api/status`, { headers: { Origin: "https://evil.example" } })).status).toBe(200);
    // Same-origin and loopback dev servers are fine.
    expect((await fetch(`${engine.url}/api/settings`, { method: "PATCH", headers: { Origin: engine.url, "content-type": "application/json" }, body: "{}" })).status).toBe(200);
    const { request } = await import("node:http");
    const rebound = await new Promise<number>((resolve) => {
      const r = request(`${engine.url}/api/status`, { headers: { Host: "attacker.example:8740" } }, (res) => resolve(res.statusCode ?? 0));
      r.end();
    });
    expect(rebound).toBe(403);
  });

  it("malformed URLs and invalid ranges", async () => {
    expect((await fetch(`${engine.url}/api/projects/%E0%A4%A`)).status).toBe(400);
    const asset = project.assets[0]!;
    const res = await fetch(`${engine.url}/api/projects/${project.id}/assets/${asset.id}`, { headers: { Range: "bytes=5-3" } });
    expect(res.status).toBe(200);
  });

  it("everything survives a restart", async () => {
    sse.abort();
    await engine.stop();
    engine = await start();
    for (let i = 0; i < 200 && (await api("GET", "/api/status", RuntimeStatusSchema)).phase !== "ready"; i++) await sleep(20);
    expect((await api("GET", "/api/status", RuntimeStatusSchema)).tier).toBe("apple-64");
    const projects = await api("GET", "/api/projects", z.array(ProjectSchema));
    expect(projects.map((p) => p.id)).toEqual([project.id]);
    const jobs = await api("GET", `/api/jobs?projectId=${project.id}`, z.array(JobSchema));
    expect(jobs.length).toBeGreaterThan(1);
    await api("DELETE", `/api/projects/${project.id}`, null, undefined, 204);
    await api("GET", `/api/projects/${project.id}`, ErrorResponseSchema, undefined, 404);
  });
});
