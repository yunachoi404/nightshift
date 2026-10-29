// Writes every copy of the Nightshift mark from one source, apps/web/src/ui/mark-svg.ts:
//   apps/web/public/favicon.svg      the browser tab icon
//   apps/desktop/assets/icon.svg     the Mac icon artwork on Apple's 1024 grid
//   apps/desktop/assets/icon.png     rasterized (macOS only, through apps/desktop/scripts/icon.mjs)
//   apps/desktop/assets/icon.icns    the icon set electron-builder packs
// Run from the repo root: node scripts/render_mark.mjs
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { platform } from "node:os";
import { markSvg } from "../apps/web/src/ui/mark-svg.ts";

const favicon = markSvg({ id: "ns" });
writeFileSync("apps/web/public/favicon.svg", favicon + "\n");

// Apple's icon grid: a 1024 canvas with the tile on the inner 824 square. The tile keeps its 25% corner.
const inner = markSvg({ id: "ns" }).replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const icon = `<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">\n<g transform="translate(100 100) scale(12.875)">${inner}</g>\n</svg>\n`;
writeFileSync("apps/desktop/assets/icon.svg", icon);
console.log("wrote apps/web/public/favicon.svg and apps/desktop/assets/icon.svg");

if (platform() === "darwin") {
  execFileSync("node", ["apps/desktop/scripts/icon.mjs"], { stdio: "inherit" });
} else {
  console.log("skipped icon.png and icon.icns: they are built on macOS");
}
