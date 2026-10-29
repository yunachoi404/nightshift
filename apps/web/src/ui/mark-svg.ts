/**
 * The Nightshift mark: a crescent moon cut from a rounded video screen, white on a black tile. This string is the
 * single source for the in-app mark (`Mark`), the favicon and the Mac icon, so keep it plain SVG with no CSS
 * variables. `id` is kept for callers that place several marks on one page. The glyph carries the `mark__frame`
 * class so a screen can animate it.
 */
export function markSvg({ id = "nsm", tile = true }: { id?: string; tile?: boolean } = {}): string {
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" focusable="false" data-mark="${id}">
${tile ? `<rect width="64" height="64" rx="15" fill="#0b0b0c"/><rect x="0.5" y="0.5" width="63" height="63" rx="14.5" fill="none" stroke="rgba(255,255,255,0.12)"/>` : ""}
<g transform="translate(10.4 10.4) scale(1.8)">
<path class="mark__frame" fill="${tile ? "#f5f5f7" : "currentColor"}" fill-rule="evenodd" d="M4 4.5 H20 Q22 4.5 22 6.5 V17.5 Q22 19.5 20 19.5 H4 Q2 19.5 2 17.5 V6.5 Q2 4.5 4 4.5 Z M 11.50975 6.76452 A 5.25 5.25 0 1 0 15.97093 15.31512 A 4.85 4.85 0 0 1 11.50975 6.76452 Z"/>
</g>
</svg>`;
}
