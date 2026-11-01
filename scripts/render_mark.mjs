// Writes every copy of the Nightshift mark from one source, apps/web/src/ui/mark-svg.ts:
//   apps/web/public/favicon.svg             the browser tab icon: the glyph alone, ink on light, cream on dark
//   apps/desktop/assets/icon.svg            the Mac icon artwork on Apple's 1024 grid
//   apps/desktop/assets/touch-icon.svg      the full-bleed tile the phone's home screen icon is drawn from
//   docs/brand/*.svg                        the mark for the README, the film and anything else outside the app
//   apps/desktop/assets/icon.png, icon.icns and apps/web/public/apple-touch-icon.png, rasterized (macOS only,
//                                           through apps/desktop/scripts/icon.mjs)
// Run from the repo root: node scripts/render_mark.mjs
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { MARK_CREAM, MARK_INK, markGlyph, markSvg } from "../apps/web/src/ui/mark-svg.ts";

// The tab icon: the glyph alone at its small size, in ink, or cream when the browser is dark.
const favicon = markSvg({ id: "ns", tile: false, small: true }).replace(
  /(<svg[^>]*>)/,
  `$1<style>svg{color:${MARK_INK}}@media (prefers-color-scheme: dark){svg{color:${MARK_CREAM}}}</style>`,
);
writeFileSync("apps/web/public/favicon.svg", favicon + "\n");

// Apple's icon grid: a 1024 canvas with the tile on the inner 824 square.
const inner = (svg) => svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const icon = `<svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">\n<g transform="translate(100 100) scale(8.24)">${inner(markSvg({ id: "ns" }))}</g>\n</svg>\n`;
writeFileSync("apps/desktop/assets/icon.svg", icon);

// A phone rounds its home screen icons itself, so the touch icon is the tile without corners.
const touch = `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" fill="${MARK_INK}"/><g transform="matrix(0.6 0 0 0.6 20 20)">${markGlyph(MARK_CREAM)}</g></svg>\n`;
writeFileSync("apps/desktop/assets/touch-icon.svg", touch);

// The mark outside the app, as clean SVG.
mkdirSync("docs/brand", { recursive: true });
writeFileSync("docs/brand/nightshift-mark.svg", markSvg({ id: "ns" }) + "\n");
writeFileSync("docs/brand/nightshift-mark-day.svg", markSvg({ id: "ns", tone: "day" }) + "\n");
const glyph = (fill) => `<svg viewBox="10 6 86 86" xmlns="http://www.w3.org/2000/svg">${markGlyph(fill)}</svg>\n`;
writeFileSync("docs/brand/nightshift-glyph-cream.svg", glyph(MARK_CREAM));
writeFileSync("docs/brand/nightshift-glyph-ink.svg", glyph(MARK_INK));
console.log("wrote the favicon, the Mac icon and touch icon artwork, and docs/brand");

if (platform() === "darwin") {
  execFileSync("node", ["apps/desktop/scripts/icon.mjs"], { stdio: "inherit" });
} else {
  console.log("skipped icon.png, icon.icns and apple-touch-icon.png: they are built on macOS");
}
