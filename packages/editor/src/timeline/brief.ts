import type { Project } from "@nightshift/contract";

/**
 * The template answers the editor reads from `project.brief`. Every field is optional; missing text falls back to
 * the project name or a sensible default. Keys are documented in the README.
 */
export interface EditorBrief {
  title?: string;
  subtitle?: string;
  /** Music video: shown under the title. */
  artist?: string;
  /** Product ad. */
  productName?: string;
  tagline?: string;
  cta?: string;
  /** Asset id of the product photo, shown on the end card. */
  productImageAssetId?: string;
  /** Voiceover or intro script. A voice asset's own `text` wins over it. */
  script?: string;
  /** Talking intro lower third. */
  speakerName?: string;
  speakerTitle?: string;
  /** Music video: how long the cut runs (default: the whole song). Product ad: the length it is paced to (default 15 s). */
  durationSec?: number;
  /** Music video: where in the song the cut starts. */
  songStartSec?: number;
}

export function readBrief(project: Project): EditorBrief {
  const b = project.brief;
  const text = (key: string): string | undefined => {
    const value = b[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const num = (key: string): number | undefined => {
    const value = b[key];
    const n = typeof value === "string" ? Number(value) : value;
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  return {
    title: text("title"),
    subtitle: text("subtitle"),
    artist: text("artist"),
    productName: text("productName"),
    tagline: text("tagline"),
    cta: text("cta"),
    productImageAssetId: text("productImageAssetId"),
    script: text("script"),
    speakerName: text("speakerName"),
    speakerTitle: text("speakerTitle"),
    durationSec: num("durationSec"),
    songStartSec: num("songStartSec"),
  };
}
