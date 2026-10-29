/**
 * A file in `public/`, under the base the UI is served from: "/" from the engine and the Mac app, "/nightshift/" in the
 * static demo on GitHub Pages.
 */
export function publicUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path.replace(/^\/+/, "")}`;
}
