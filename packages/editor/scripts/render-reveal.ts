/**
 * Render a shot's reveal clip from a project folder on disk, without the engine.
 *
 *   pnpm --filter @nightshift/editor exec tsx scripts/render-reveal.ts <projectDir> <outDir> [--shot id] [--aspect 9:16|16:9] [--theme dark|light] [--keep]
 *
 * Reads <projectDir>/project.json and its assets; writes reveal-<aspect>.mp4 into <outDir> and prints the plan.
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ProjectSchema, type Aspect } from "@nightshift/contract";
import { exportReveal } from "../src/reveal/export.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { shot: { type: "string" }, aspect: { type: "string", default: "9:16" }, theme: { type: "string", default: "dark" }, keep: { type: "boolean", default: false }, quality: { type: "string", default: "standard" } },
});
const [projectDir, outDir] = positionals;
if (!projectDir || !outDir) {
  console.error("usage: render-reveal.ts <projectDir> <outDir> [--shot id] [--aspect 9:16|16:9] [--theme dark|light] [--keep]");
  process.exit(2);
}
const project = ProjectSchema.parse(JSON.parse(await readFile(join(projectDir, "project.json"), "utf8")));
const aspect = values.aspect as Aspect;
const outPath = resolve(outDir, `reveal-${aspect.replace(":", "x")}${values.shot ? `-${values.shot}` : ""}.mp4`);
const started = Date.now();
const result = await exportReveal(project, {
  projectDir: resolve(projectDir),
  outPath,
  ...(values.shot ? { shotId: values.shot } : {}),
  aspect,
  theme: values.theme === "light" ? "light" : "dark",
  quality: values.quality === "high" ? "high" : values.quality === "draft" ? "draft" : "standard",
  keepWorkDir: values.keep,
  workDir: values.keep ? resolve(outDir, `work-${aspect.replace(":", "x")}`) : undefined,
  onProgress: (p) => process.stderr.write(`\r${p.stage} ${(p.progress * 100).toFixed(0).padStart(3)}% ${p.message}          `),
});
process.stderr.write("\n");
console.log(JSON.stringify({ outPath: result.outPath, durationSec: result.durationSec, size: `${result.width}x${result.height}`, fps: result.fps, kind: result.kind, freezeFrame: result.freezeFrame, frames: result.frames, plan: result.plan, crop: undefined, warnings: result.warnings, seconds: (Date.now() - started) / 1000 }, null, 2));
