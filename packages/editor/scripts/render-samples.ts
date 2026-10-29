/**
 * Renders every template in every aspect from fixture media, with contact sheets to check the frames.
 *
 *   pnpm --filter @nightshift/editor samples [--templates music_video,product_ad] [--aspects 9:16] [--short-side 720]
 *
 * Output: <repo>/outputs/editor-samples/<template>_<aspect>.mp4, .sheet.png, .timeline.json, and summary.json.
 * Shots: the first real project's footage from <repo>/outputs/demo (or NIGHTSHIFT_DEMO_DIR) and the LTX smoke render
 * from <repo>/outputs/smoke/render (or NIGHTSHIFT_SMOKE_DIR) when present; generated shots stand in otherwise.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Aspect, TemplateId } from "@nightshift/contract";
import { assembleTimeline } from "../src/timeline/assemble.js";
import { buildCompositionFolder, exportVideo } from "../src/render/export.js";
import { shootFrames } from "./frames.js";
import { resolveTools } from "../src/media/tools.js";
import { run } from "../src/media/process.js";
import { makeFixtures, sampleProject } from "./fixtures.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const TEMPLATES: TemplateId[] = ["cinematic_shot", "music_video", "product_ad", "talking_intro"];
const ASPECTS: Aspect[] = ["16:9", "9:16", "1:1"];

async function main(): Promise<void> {
  const templates = (arg("templates")?.split(",") as TemplateId[] | undefined) ?? TEMPLATES;
  const aspects = (arg("aspects")?.split(",") as Aspect[] | undefined) ?? ASPECTS;
  const shortSide = Number(arg("short-side") ?? 1080);
  const outDir = resolve(arg("out") ?? join(repo, "outputs", "editor-samples"));
  const smokeDir = process.env.NIGHTSHIFT_SMOKE_DIR ?? findOutputs("smoke", "render");
  const demoDir = process.env.NIGHTSHIFT_DEMO_DIR ?? findOutputs("demo");
  const fixtureDir = join(repo, "outputs", "editor-fixtures");
  const compose = arg("compose");
  await mkdir(outDir, { recursive: true });

  console.log(`Fixtures in ${fixtureDir} (real footage: ${existsSync(demoDir) ? demoDir : "not found"}; smoke render: ${existsSync(smokeDir) ? smokeDir : "not found"})`);
  const fx = await makeFixtures(fixtureDir, existsSync(smokeDir) ? smokeDir : undefined, process.argv.includes("--fresh"), existsSync(demoDir) ? demoDir : undefined);
  const tools = resolveTools();
  const summary: unknown[] = [];

  for (const template of templates) {
    const project = sampleProject(template, fx);
    const started = Date.now();
    const assembled = await assembleTimeline(project, { projectDir: fixtureDir });
    const assembleSec = (Date.now() - started) / 1000;
    await writeFile(join(outDir, `${template}.timeline.json`), JSON.stringify(assembled.timeline, null, 2));
    console.log(`\n${template}: ${assembled.timeline.clips.length} clips, ${assembled.durationSec}s, captions ${assembled.timeline.captions.length} (${assembled.analysis.captionMethod ?? "none"}), assembled in ${assembleSec.toFixed(1)}s`);
    for (const w of assembled.warnings) console.log(`  warning: ${w}`);

    for (const aspect of aspects) {
      const name = `${template}_${aspect.replace(":", "x")}`;
      if (compose) {
        // Design check: the composition and stills at chosen moments, no render.
        const dir = join(outDir, "compose", name);
        const folder = await buildCompositionFolder(project, assembled.timeline, { projectDir: fixtureDir, outDir: dir, aspect, shortSide });
        const times = compose === "auto" ? designMoments(assembled.timeline, folder.duration) : compose.split(",").map(Number);
        const shots = await shootFrames(dir, join(dir, "frames"), times);
        const sheet = join(outDir, `${name}.frames.png`);
        await tile(tools.ffmpeg, shots, sheet, aspect);
        console.log(`  ${aspect}: ${sheet} (${times.map((t) => t.toFixed(2)).join(", ")})`);
        continue;
      }
      const outPath = join(outDir, `${name}.mp4`);
      const t0 = Date.now();
      let last = -1;
      const result = await exportVideo(project, assembled.timeline, {
        projectDir: fixtureDir,
        outPath,
        aspect,
        shortSide,
        keepWorkDir: process.argv.includes("--keep"),
        onProgress: (p) => {
          const pct = Math.floor(p.progress * 10) * 10;
          if (pct !== last) {
            last = pct;
            process.stdout.write(`  ${aspect} ${pct}%\r`);
          }
        },
      });
      const seconds = (Date.now() - t0) / 1000;
      await contactSheet(tools.ffmpeg, outPath, join(outDir, `${name}.sheet.png`), result.durationSec, aspect);
      console.log(`  ${aspect}: ${result.width}x${result.height}@${result.fps} ${result.durationSec.toFixed(2)}s, ${(result.sizeBytes / 1e6).toFixed(1)} MB, master ${result.audio.lufs.master ?? "silent"} LUFS, ${seconds.toFixed(1)}s${result.workDir ? `, work ${result.workDir}` : ""}`);
      for (const w of result.warnings) console.log(`    warning: ${w}`);
      summary.push({ template, aspect, seconds, ...result });
    }
  }
  await writeFile(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`\nDone: ${outDir}`);
}

/** Renders live in the main checkout's outputs/ (gitignored), which a worktree does not have. */
function findOutputs(...parts: string[]): string {
  const local = join(repo, "outputs", ...parts);
  if (existsSync(local)) return local;
  try {
    const common = execFileSync("git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
    return join(dirname(common), "outputs", ...parts);
  } catch {
    return local;
  }
}

/** Moments worth looking at: each card's middle, each caption's middle, just after each cut. */
function designMoments(timeline: import("@nightshift/contract").Timeline, duration: number): number[] {
  const times = new Set<number>();
  for (const o of timeline.overlays ?? []) times.add(Math.min(duration - 0.05, o.start + Math.min(1.5, (o.end - o.start) * 0.6)));
  timeline.captions.slice(0, 4).forEach((c) => times.add((c.start + c.end) / 2));
  timeline.clips.slice(1, 4).forEach((c) => times.add(c.start + 0.12));
  return [...times].sort((a, b) => a - b).slice(0, 10);
}

async function tile(ffmpeg: string, files: string[], out: string, aspect: Aspect): Promise<void> {
  const width = aspect === "9:16" ? 300 : aspect === "1:1" ? 400 : 560;
  const height = Math.round((width * { "16:9": 9 / 16, "9:16": 16 / 9, "1:1": 1 }[aspect]) / 2) * 2;
  const columns = Math.min(files.length, aspect === "9:16" ? 6 : 4);
  const inputs = files.flatMap((f) => ["-i", f]);
  const scaled = files.map((_, i) => `[${i}]scale=${width}:${height}[s${i}]`).join(";");
  const layout = files.map((_, i) => `${(i % columns) * (width + 4)}_${Math.floor(i / columns) * (height + 4)}`).join("|");
  const graph = files.length === 1 ? `${scaled};[s0]null` : `${scaled};${files.map((_, i) => `[s${i}]`).join("")}xstack=inputs=${files.length}:layout=${layout}:fill=0x202020`;
  await run(ffmpeg, ["-v", "error", "-nostdin", "-y", ...inputs, "-filter_complex", graph, "-frames:v", "1", out]);
}

/** Eight frames across the video, tiled. */
async function contactSheet(ffmpeg: string, video: string, out: string, duration: number, aspect: Aspect): Promise<void> {
  const columns = aspect === "9:16" ? 8 : 4;
  const rows = aspect === "9:16" ? 1 : 2;
  const width = aspect === "9:16" ? 240 : aspect === "1:1" ? 360 : 480;
  const fps = 8 / Math.max(0.5, duration);
  await run(ffmpeg, ["-v", "error", "-nostdin", "-y", "-i", video, "-vf", `fps=${fps.toFixed(4)},scale=${width}:-2,tile=${columns}x${rows}:padding=4:color=0x202020`, "-frames:v", "1", out]);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
