/**
 * Renders every template through the engine API in mock mode at full size, for review: a 16:9 project exported in
 * all three aspects and a 9:16 one, on the model lab's unified-128-cuda recipe. MP4s and contact sheets (one frame a
 * second) go to outputs/engine-e2e/.
 *
 *   pnpm --filter @nightshift/engine e2e:templates [-- --quality preview|standard|high] [-- --templates music_video,product_ad]
 */
import type { Aspect, TemplateId } from "@nightshift/contract";
import { resolveTools } from "@nightshift/editor";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startEngine } from "../src/engine.js";
import { defaultRecipesDir, REPO_ROOT } from "../src/paths.js";
import { Api, runTemplate } from "../test/flow.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const quality = (arg("quality") ?? "standard") as "preview" | "standard" | "high";
const templates = (arg("templates")?.split(",") ?? ["cinematic_shot", "music_video", "product_ad", "talking_intro"]) as TemplateId[];
const outDir = join(REPO_ROOT, "outputs", "engine-e2e");
mkdirSync(outDir, { recursive: true });
const { ffmpeg } = resolveTools();

const started = Date.now();
await Promise.all(
  templates.map(async (template) => {
    const dataDir = mkdtempSync(join(tmpdir(), `ns-e2e-${template}-`));
    const engine = await startEngine({ port: 0, dataDir, mock: true, mockSpeed: 0, recipesDir: defaultRecipesDir(), log: () => undefined });
    try {
      const api = new Api(engine.url);
      await api.install("unified-128-cuda");
      for (const [aspect, exportAspects] of [["16:9", ["16:9", "9:16", "1:1"]], ["9:16", ["9:16"]]] as [Aspect, Aspect[]][]) {
        const { project, exports } = await runTemplate(api, template, aspect, { exportAspects, quality });
        for (const e of exports) {
          const asset = project.assets.find((a) => a.id === e.assetId)!;
          const name = `${template}_${aspect.replace(":", "x")}_to_${e.aspect.replace(":", "x")}`;
          const mp4 = join(outDir, `${name}.mp4`);
          copyFileSync(join(dataDir, "projects", project.id, asset.path), mp4);
          const cols = e.aspect === "9:16" ? 8 : 6;
          execFileSync(ffmpeg, ["-v", "error", "-y", "-i", mp4, "-vf", `fps=1,scale=${e.aspect === "16:9" ? 320 : 240}:-2,tile=${cols}x4`, "-frames:v", "1", join(outDir, `${name}.png`)]);
          console.log(`${mp4}  ${e.job.message}`);
        }
      }
    } finally {
      await engine.stop();
    }
  }),
);
console.log(`Done in ${((Date.now() - started) / 1000).toFixed(0)} s: ${outDir}`);
