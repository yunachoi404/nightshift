/**
 * Every template from creation to a finished, captioned MP4 through the engine API in mock mode, on the model lab's
 * unified-128-cuda recipe: a 16:9 project exported in all three aspects, and a 9:16 one. Preview quality (540 px)
 * keeps it quick; scripts/e2e-templates.ts renders the same at 1080 px for review.
 */
import { checkTools, probeMedia, resolveTools } from "@nightshift/editor";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Aspect, TemplateId } from "@nightshift/contract";
import { startEngine } from "../src/engine.js";
import { defaultRecipesDir } from "../src/paths.js";
import { Api, runTemplate } from "./flow.js";

const tools = checkTools();
const PREVIEW: Record<Aspect, [number, number]> = { "16:9": [960, 540], "9:16": [540, 960], "1:1": [540, 540] };

describe.skipIf(!tools.chrome || !tools.ffmpeg)("every template, creation to export", () => {
  for (const template of ["cinematic_shot", "music_video", "product_ad", "talking_intro"] as TemplateId[]) {
    it.concurrent(template, async () => {
      const dataDir = mkdtempSync(join(tmpdir(), `ns-tpl-${template}-`));
      const engine = await startEngine({ port: 0, dataDir, mock: true, mockSpeed: 0, recipesDir: defaultRecipesDir(), log: () => undefined });
      try {
        const api = new Api(engine.url);
        await api.install("unified-128-cuda");
        for (const [aspect, exportAspects] of [["16:9", ["16:9", "9:16", "1:1"]], ["9:16", ["9:16"]]] as [Aspect, Aspect[]][]) {
          const { project, exports } = await runTemplate(api, template, aspect, { exportAspects, quality: "preview" });
          const timeline = project.timeline!;
          expect(timeline.edited).toBeUndefined();
          expect(timeline.captions.length, `${template} ${aspect} has captions`).toBeGreaterThan(0);
          expect(timeline.overlays?.length, `${template} ${aspect} has cards`).toBeGreaterThan(0);
          const end = Math.max(...timeline.clips.map((c) => c.start + c.out - c.in), ...(timeline.overlays ?? []).map((o) => o.end));
          for (const e of exports) {
            expect(e.job.message).toMatch(/captions/);
            expect(e.job.message).not.toMatch(/no captions/);
            const asset = project.assets.find((a) => a.id === e.assetId)!;
            expect(asset.role).toBe("export");
            const info = await probeMedia(resolveTools(), join(dataDir, "projects", project.id, asset.path));
            expect([info.width, info.height], `${template} ${aspect} -> ${e.aspect}`).toEqual(PREVIEW[e.aspect]);
            expect(info.hasAudio).toBe(true);
            expect(info.durationSec).toBeCloseTo(end, 0);
          }
          // Shots were made in the project's own shape: 9:16 stills are portrait.
          const still = project.assets.find((a) => a.id === project.shots[0]!.stillAssetId)!;
          expect(still.width! > still.height!).toBe(aspect === "16:9");
        }
      } finally {
        await engine.stop();
      }
    }, 900_000);
  }
});
