import { timelineDuration, type Asset, type Aspect, type Job, type Project, type Shot, type Take } from "@nightshift/contract";
import { shortDuration } from "@/lib/format";

export function isGpuJob(job: Job): boolean {
  return job.step !== "export" && !job.analysis;
}

export function assetById(p: Project, id: string | undefined): Asset | undefined {
  return id ? p.assets.find((a) => a.id === id) : undefined;
}

export function takeById(p: Project, id: string | undefined): Take | undefined {
  return id ? p.takes.find((t) => t.id === id) : undefined;
}

export function draftsFor(p: Project, shot: Shot): Take[] {
  return p.takes.filter((t) => t.shotId === shot.id && t.rung === "draft");
}

export function finalsFor(p: Project, shot: Shot): Take[] {
  return p.takes.filter((t) => t.shotId === shot.id && t.rung === "final");
}

/** The best picture we have for a shot: final, else chosen draft, else still. */
export function bestAssetFor(p: Project, shot: Shot): { asset: Asset; rung: "final" | "draft" | "still" } | undefined {
  const final = takeById(p, shot.chosenFinalId);
  const fa = assetById(p, final?.videoAssetId);
  if (fa) return { asset: fa, rung: "final" };
  const draft = takeById(p, shot.chosenDraftId);
  const da = assetById(p, draft?.videoAssetId);
  if (da) return { asset: da, rung: "draft" };
  const still = assetById(p, shot.stillAssetId);
  if (still) return { asset: still, rung: "still" };
  return undefined;
}

export function coverFor(p: Project): Asset | undefined {
  for (const s of p.shots) {
    const b = bestAssetFor(p, s);
    if (b) return b.asset;
  }
  return undefined;
}

/**
 * How long the film runs: its cut, which the export renders exactly, once the engine has made one. Before that, the
 * shots added up. Dissolves overlap the shots, so three 2 s drafts make a 5 s film, not a 6 s one.
 */
export function totalDuration(p: Project): number {
  if (p.timeline?.clips.length) return timelineDuration(p.timeline);
  return p.shots.reduce((s, x) => s + x.durationSec, 0);
}

export function frameClass(aspect: Aspect): string {
  return aspect === "9:16" ? "frame--9x16" : aspect === "1:1" ? "frame--1x1" : "frame--16x9";
}

export const stepLabel: Record<Job["step"], string> = {
  text: "Shot list",
  still: "Still",
  video_draft: "Draft",
  video_what_if: "Continuous film",
  video_final_same_take: "Final, same take",
  video_final_remaster: "Final, remaster",
  voice: "Voice",
  music: "Music",
  camera_layout: "Camera path",
  video_camera_move: "Camera move",
  effect_end_frame: "Effect frame",
  video_effect: "Effect",
  export: "Export",
};

/** What a job does, in plain words. An analysis job measures a song or a voice that exists instead of making one. */
export function jobLabel(j: Pick<Job, "step" | "analysis" | "shotId">, project?: Pick<Project, "template">): string {
  if (j.step === "text" && (project?.template === "camera_move" || project?.template === "vfx_effect")) return "Prepare photo";
  if (j.step === "export" && j.shotId) return "Share reveal";
  if (j.analysis) return j.step === "music" ? "Measuring the song" : "Timing the voice";
  return stepLabel[j.step];
}

export const isActive = (j: Job) => j.status === "queued" || j.status === "running";

export function jobsForShot(jobs: Job[], shotId: string): Job[] {
  return jobs.filter((j) => j.shotId === shotId);
}

export function activeJob(jobs: Job[], shotId: string, steps?: Job["step"][]): Job | undefined {
  return jobs.find((j) => j.shotId === shotId && isActive(j) && (!steps || steps.includes(j.step)));
}

export function lastFailed(jobs: Job[], shotId: string, steps?: Job["step"][]): Job | undefined {
  const latest = jobs.filter((j) => j.shotId === shotId && j.status !== "cancelled" && (!steps || steps.includes(j.step))).at(-1);
  return latest?.status === "failed" ? latest : undefined;
}

/** Where a project is in the ladder, for the home card and the stage nav. */
export function projectStage(p: Project, jobs: Job[]): { label: string; tone?: "accent" | "night" | "ok" | "bad" } {
  const active = jobs.filter((j) => j.projectId === p.id && isActive(j));
  const overnight = active.filter((j) => j.mode === "overnight");
  if (overnight.length) return { label: `${overnight.length} ${overnight.length === 1 ? "final" : "finals"} tonight`, tone: "night" };
  const running = active.find((j) => j.status === "running");
  if (running) return { label: running.analysis ? jobLabel(running) : running.step === "text" ? (p.template === "camera_move" || p.template === "vfx_effect" ? "Preparing photo" : "Writing shots") : `Making ${stepLabel[running.step].toLowerCase()}`, tone: "accent" };
  if (active.length) return { label: `${active.length} queued`, tone: "accent" };
  if (!p.shots.length) return { label: "No shots yet" };
  const finals = p.shots.filter((s) => s.chosenFinalId).length;
  if (finals === p.shots.length) return { label: "Ready to export", tone: "ok" };
  if (finals) return { label: `${finals} of ${p.shots.length} finals` };
  const drafts = p.shots.filter((s) => s.chosenDraftId).length;
  if (drafts === p.shots.length) return { label: "Drafts picked" };
  if (drafts) return { label: `${drafts} of ${p.shots.length} drafts` };
  const stills = p.shots.filter((s) => s.stillAssetId).length;
  if (stills === p.shots.length) return { label: "Storyboard ready" };
  return { label: `${stills} of ${p.shots.length} stills` };
}

/**
 * What a job is doing, in calm words. The engine's messages can be node counts ("Node 5 of 5") that sit still
 * through a long model load, so those become a stage read from progress. Messages that already say something
 * ("Loading draft latent", "Waiting for the GPU") are kept. ComfyUI's own queue note becomes a wait for the GPU.
 */
export function jobStage(j: Pick<Job, "status" | "progress" | "message" | "mode" | "step" | "analysis">): string {
  const m = j.message?.trim() ?? "";
  if (j.status === "queued") {
    if (/waiting for the gpu/i.test(m)) return "Waiting for the GPU";
    if (/comfyui queue|waiting in .*queue/i.test(m)) return "Waiting for the GPU";
    if (m && !/node \d+ of \d+/i.test(m)) return m;
    return j.mode === "overnight" ? "Queued for tonight" : "Queued";
  }
  if (j.status !== "running") return m;
  if (/comfyui queue|waiting in .*queue/i.test(m)) return "Waiting for the GPU";
  if (m && !/^node \d+ of \d+/i.test(m) && !/^step \d+ of \d+/i.test(m)) return m;
  if (j.step === "export") return j.progress < 0.9 ? "Rendering the video" : "Writing the file";
  if (j.step === "text") return "Writing";
  if (j.analysis) return j.step === "music" ? "Measuring the song" : "Timing the voice";
  if (j.progress < 0.08) return "Starting";
  if (j.progress < 0.3) return "Loading the model";
  if (j.progress < 0.92) return "Generating";
  return "Saving";
}

const firstLine = (error: string | undefined) => error?.split("\n")[0]?.trim() ?? "";
const OUT_OF_MEMORY = /out of memory|would exceed allowed memory/i;

/**
 * Why a job failed, in a few plain words, for a queue row. The engine's message when it says why ("Ran out of graphics
 * memory. Other apps are using 3.5 GB (python)."), else the first line of the error (ComfyUI appends allocator dumps
 * and tracebacks). A job that ran out of memory before the engine said so plainly reads the same.
 */
export function failureReason(j: Pick<Job, "message" | "error">): string {
  const message = j.message?.trim();
  if (message && message !== "Failed") return message;
  const first = firstLine(j.error);
  if (OUT_OF_MEMORY.test(first)) return "Ran out of graphics memory.";
  return first || "It stopped without saying why.";
}

/**
 * Why a job failed, for a notice: the plain reason, what to do when the graphics card ran out of memory (another app
 * holding it is the usual cause on a small card), and the error's first line when the reason is not that line.
 */
export function failureText(j: Pick<Job, "message" | "error">): string {
  const reason = failureReason(j);
  const first = firstLine(j.error);
  const advice = !/ran out of graphics memory/i.test(reason) ? "" : /other apps are using/i.test(reason) ? " Close them, then try again." : " Close other apps that use the graphics card, then try again.";
  return [`${reason}${advice}`, first && first !== reason ? first : ""].filter(Boolean).join(" ");
}

/** "1 min 20 s" since the job started, or "" when it has not. */
export function jobElapsed(j: Pick<Job, "status" | "startedAt">, now = Date.now()): string {
  if (j.status !== "running" || !j.startedAt) return "";
  const sec = (now - new Date(j.startedAt).getTime()) / 1000;
  return sec >= 1 ? shortDuration(sec) : "";
}

/** "Generating, 1 min 20 s". The stage alone while queued. */
export function jobStatusLine(j: Pick<Job, "status" | "progress" | "message" | "mode" | "step" | "analysis" | "startedAt">, now = Date.now()): string {
  const stage = jobStage(j);
  const elapsed = jobElapsed(j, now);
  return elapsed ? `${stage}, ${elapsed}` : stage;
}
