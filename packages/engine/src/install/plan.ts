import type { InstallPlan, ModelFile, Recipe } from "@nightshift/contract";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { GIB, round1 } from "../util.js";
import { searchDirs, type ModelDirs } from "./modelDirs.js";

/** Disk the ComfyUI install itself takes (Python, PyTorch, node packs), on top of the models. */
export const RUNTIME_INSTALL_GB = 9;
/** Never fill the disk to the last byte. */
export const DISK_MARGIN_GB = 5;

/**
 * A model counts as present when a file with its name sits in any folder ComfyUI searches and is at least
 * 90% of the recipe's size (recipes round sizes; a truncated download is far smaller). Checksums are verified
 * at download time, not here: hashing tens of GB on every plan would take minutes.
 */
export async function findModel(model: ModelFile, dirs: ModelDirs, comfyDir: string): Promise<string | undefined> {
  for (const dir of searchDirs(dirs, comfyDir, model.folder)) {
    const path = join(dir, model.filename);
    const s = await stat(path).catch(() => undefined);
    if (s?.isFile() && s.size >= model.sizeGb * GIB * 0.9) return path;
  }
  return undefined;
}

export async function planInstall(o: {
  recipe: Recipe;
  dirs: ModelDirs;
  comfyDir: string;
  freeDiskGb: number;
  runtimeInstalled: boolean;
}): Promise<InstallPlan> {
  const downloads: ModelFile[] = [];
  const alreadyPresent: string[] = [];
  for (const model of o.recipe.models) {
    if (await findModel(model, o.dirs, o.comfyDir)) alreadyPresent.push(model.id);
    else downloads.push(model);
  }
  const totalDownloadGb = round1(downloads.reduce((s, m) => s + m.sizeGb, 0));
  const needGb = totalDownloadGb + (o.runtimeInstalled ? 0 : RUNTIME_INSTALL_GB) + DISK_MARGIN_GB;
  return { tier: o.recipe.tier, downloads, alreadyPresent, totalDownloadGb, freeDiskGb: o.freeDiskGb, fits: needGb <= o.freeDiskGb };
}
