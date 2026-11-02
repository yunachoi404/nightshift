/**
 * Posters: small previews of a project's pictures and videos for the UI's small pictures (project cards, the sidebar,
 * queue rows). A still is about 0.7 MB and a final several MB; over a slow link a page of cards took a minute to fill.
 * A poster is the picture, or a video's first frame, scaled to one of `POSTER_WIDTHS` with ffmpeg: tens of KB. Each is
 * made once, on first ask, and kept in the project's folder (`posters/`), so it goes when the project goes.
 */
import { POSTER_WIDTHS, type Asset, type PosterWidth } from "@nightshift/contract";
import { execFile } from "node:child_process";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, newId, runStreaming, type Logger } from "../util.js";
import { findFfmpeg } from "./ffmpeg.js";

/** The poster width for a width asked for: the next one up, else the widest. */
export function posterWidth(asked: number): PosterWidth {
  return POSTER_WIDTHS.find((w) => w >= asked) ?? POSTER_WIDTHS[POSTER_WIDTHS.length - 1]!;
}

/** Posters made at once. A page of cold cards asks for dozens together; each takes a tenth of a second. */
const AT_ONCE = 3;
/** A poster that takes longer than this is not made. */
const TIMEOUT_MS = 30_000;

export class Posters {
  /** The posters being made, by their file, so two asks for one make it once. */
  private readonly making = new Map<string, Promise<string | undefined>>();
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly log: Logger) {}

  /**
   * The file of `asset`'s poster at `width` (one of `POSTER_WIDTHS`), made first if it is not there yet. Undefined when
   * it cannot be made: ffmpeg is missing, or the file is not a picture or a video it can read.
   */
  async get(projectDir: string, asset: Asset, source: string, width: PosterWidth): Promise<string | undefined> {
    if (asset.kind !== "image" && asset.kind !== "video") return undefined;
    const dir = postersDir(projectDir);
    const base = join(dir, `${asset.id}-w${width}`);
    for (const ext of [".jpg", ".png"]) if (await isFile(base + ext)) return base + ext;
    let pending = this.making.get(base);
    if (!pending) {
      pending = this.limit(() => this.make(asset, source, dir, base, width)).finally(() => this.making.delete(base));
      this.making.set(base, pending);
    }
    return pending;
  }

  private async make(asset: Asset, source: string, dir: string, base: string, width: PosterWidth): Promise<string | undefined> {
    const bin = await findFfmpeg();
    if (!bin) return undefined;
    // A cutout stays one: a picture with see-through pixels gets a PNG poster. Everything else, a JPEG.
    const ext = asset.kind === "image" && (await seeThrough(bin, source)) ? ".png" : ".jpg";
    const out = base + ext;
    // Written beside its place under a name of its own, then moved there, so a half-written poster is never sent.
    const part = join(dir, `${newId("part")}${ext}`);
    try {
      await mkdir(dir, { recursive: true });
      const quality = ext === ".jpg" ? ["-q:v", "4"] : [];
      const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", source, "-frames:v", "1", "-vf", `scale=w='min(iw,${width})':h=-2:flags=lanczos`, ...quality, "-update", "1", part];
      await runStreaming(bin, args, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      await rename(part, out);
      return out;
    } catch (err) {
      this.log(`no poster for asset ${asset.id} at ${width} px: ${errorMessage(err)}`);
      await rm(part, { force: true });
      return undefined;
    }
  }

  /** Runs `work` once fewer than `AT_ONCE` posters are being made. A slot that frees passes straight to the next in line. */
  private async limit<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= AT_ONCE) await new Promise<void>((go) => this.waiting.push(go));
    else this.running += 1;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running -= 1;
    }
  }
}

/** Where a project keeps its posters. */
function postersDir(projectDir: string): string {
  return join(projectDir, "posters");
}

/** Removes every poster of an asset: called when the asset itself goes. */
export async function removePosters(projectDir: string, assetId: string): Promise<void> {
  const dir = postersDir(projectDir);
  const names = await readdir(dir).catch(() => [] as string[]);
  await Promise.all(names.filter((n) => n.startsWith(`${assetId}-w`)).map((n) => rm(join(dir, n), { force: true })));
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isFile() ?? false;
}

/**
 * Whether a picture has see-through pixels: its alpha, scaled down, has a value under full. Many pictures carry an alpha
 * channel that is opaque everywhere (the engine's own placeholder stills, most screenshots); those make JPEG posters.
 */
function seeThrough(ffmpeg: string, path: string): Promise<boolean> {
  const args = ["-hide_banner", "-loglevel", "error", "-i", path, "-frames:v", "1", "-vf", "scale=w='min(iw,160)':h=-2:flags=area,format=rgba,alphaextract,format=gray", "-f", "rawvideo", "-"];
  return new Promise((resolve) => {
    execFile(ffmpeg, args, { encoding: "buffer", timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, alpha) => resolve(!err && alpha.some((a) => a < 255)));
  });
}
