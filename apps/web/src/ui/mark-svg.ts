/**
 * The Nightshift mark, the owner's design: a crescent moon holding a play mark in its hollow, with a small four-point
 * star to its upper right, on a rounded tile. The shapes are kept exactly as drawn; only the colors are ours. On the
 * night tile the glyph is moonlight cream on night ink; on the day tile it is night ink on cream. Without a tile the
 * glyph draws in `currentColor` for the sidebar and small sizes, with the star a touch larger so it still reads.
 *
 * This string is the single source for the in-app mark (`Mark`), the favicon and the Mac icon
 * (`node scripts/render_mark.mjs`), so it stays plain SVG with no CSS variables and no raster.
 */

/** Night ink, the tile on dark. */
export const MARK_INK = "#0b1026";
/** Moonlight cream, the glyph on the night tile and the day tile itself. */
export const MARK_CREAM = "#fff7e0";

/** The crescent on the 100 grid. Its outer edge is the circle of radius 36 round (50, 50). */
export const CRESCENT = "M51.18 14.02 A36 36 0 1 0 83.67 62.75 A30 30 0 1 1 51.18 14.02 Z";
const PLAY = "52,34 52,55 70,44.5";
/** The four-point star, radius 1 round (0, 0). */
export const STAR = "M0 -1 C0.12 -0.12 0.12 -0.12 1 0 C0.12 0.12 0.12 0.12 0 1 C-0.12 0.12 -0.12 0.12 -1 0 C-0.12 -0.12 -0.12 -0.12 0 -1 Z";

/** The glyph on the design's 100 grid. `star` is the star's radius: 4.4 as drawn, larger for small sizes. */
export function markGlyph(fill: string, star = 4.4): string {
  return [
    `<path d="${CRESCENT}" fill="${fill}"/>`,
    `<polygon points="${PLAY}" fill="${fill}" stroke="${fill}" stroke-width="3" stroke-linejoin="round"/>`,
    `<path d="${STAR}" transform="matrix(${star} 0 0 ${star} 85 16)" fill="${fill}"/>`,
  ].join("");
}

export type MarkTone = "night" | "day";

/**
 * `edge` draws a 1px hairline round the night tile, for a small tile on the app's black window; icons and files for
 * use elsewhere leave it off.
 */
export function markSvg({ id = "nsm", tile = true, tone = "night", small = false, edge = false }: { id?: string; tile?: boolean; tone?: MarkTone; small?: boolean; edge?: boolean } = {}): string {
  if (!tile) {
    // The glyph alone, framed close: the crescent from x 14, the star's tips inside the frame at its small size.
    return `<svg viewBox="10 6 86 86" xmlns="http://www.w3.org/2000/svg" focusable="false" data-mark="${id}">${markGlyph("currentColor", small ? 8.4 : 4.4)}</svg>`;
  }
  const night = tone === "night";
  const ground = night ? MARK_INK : MARK_CREAM;
  const ink = night ? MARK_CREAM : MARK_INK;
  const hairline = night && edge ? `<rect x="0.5" y="0.5" width="99" height="99" rx="21.9" fill="none" stroke="rgba(255,255,255,0.12)" vector-effect="non-scaling-stroke"/>` : "";
  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" focusable="false" data-mark="${id}"><rect width="100" height="100" rx="22.4" fill="${ground}"/>${hairline}<g transform="matrix(0.6 0 0 0.6 20 20)">${markGlyph(ink, small ? 7.6 : 4.4)}</g></svg>`;
}
