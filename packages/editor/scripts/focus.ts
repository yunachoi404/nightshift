/**
 * Design check: what the focus finder sees in a clip. Prints the crop centre, the subject point, the subject box
 * (head to feet) and the brightness of each horizontal strip, for the frame shape given. With --draw, writes a frame
 * from the middle of each clip with the box and the point painted on it.
 *
 *   tsx scripts/focus.ts [--aspect 9:16] [--draw <out dir>] <clip.mp4 or still.png> ...
 */
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { probeMedia } from "../src/media/ffmpeg.js";
import { run } from "../src/media/process.js";
import { resolveTools } from "../src/media/tools.js";
import { findFocus } from "../src/render/reframe.js";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args.splice(i, 2)[1] as string) : undefined;
};
const aspect = option("aspect") ?? "9:16";
const draw = option("draw");
const [aw, ah] = aspect.split(":").map(Number) as [number, number];
const tools = resolveTools();
const pct = (v: number) => `${Math.round(v * 100)}%`;
if (draw) await mkdir(draw, { recursive: true });

for (const path of args) {
  const info = await probeMedia(tools, path);
  const still = info.kind === "image";
  const srcWidth = info.width ?? 0;
  const srcHeight = info.height ?? 0;
  const seen = await findFocus(tools, path, { start: 0, end: still ? 1 : info.durationSec, srcWidth, srcHeight, frameAspect: aw / ah, still });
  const b = seen.box;
  console.log(`${path} (${srcWidth}x${srcHeight}, ${still ? "still" : `${info.durationSec.toFixed(1)} s`}) -> ${aspect}`);
  console.log(`  crop centre ${pct(seen.x)} ${pct(seen.y)}, subject ${pct(seen.subject.x)} ${pct(seen.subject.y)}`);
  console.log(`  box x ${pct(b.left)}..${pct(b.right)} (${pct(b.right - b.left)} wide), y ${pct(b.top)}..${pct(b.bottom)} (${pct(b.bottom - b.top)} tall)`);
  console.log(`  rows ${seen.rows.map((r) => r.toFixed(2)).join(" ")}`);
  if (draw) {
    const out = join(draw, `${basename(path).replace(/\.[^.]+$/, "")}.png`);
    const box = `drawbox=x=${Math.round(b.left * srcWidth)}:y=${Math.round(b.top * srcHeight)}:w=${Math.round((b.right - b.left) * srcWidth)}:h=${Math.round((b.bottom - b.top) * srcHeight)}:color=lime@0.9:t=4`;
    const dot = `drawbox=x=${Math.round(seen.subject.x * srcWidth) - 6}:y=${Math.round(seen.subject.y * srcHeight) - 6}:w=12:h=12:color=yellow@1:t=fill`;
    await run(tools.ffmpeg, ["-v", "error", "-nostdin", "-y", ...(still ? [] : ["-ss", (info.durationSec / 2).toFixed(3)]), "-i", path, "-vf", `${box},${dot}`, "-frames:v", "1", out]);
  }
}
