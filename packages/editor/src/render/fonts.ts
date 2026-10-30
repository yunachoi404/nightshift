import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { FontId } from "../style.js";

/**
 * Fonts ship as files with the package (through Fontsource) so every render looks the same. Every family here is
 * under the SIL Open Font License 1.1 (OFL-1.1): Inter, Playfair Display, Bebas Neue, Cormorant Garamond, Fraunces,
 * Instrument Sans, Archivo, Syne and Bricolage Grotesque.
 */
interface FontFace {
  file: string;
  style: "normal" | "italic";
  weight: string;
  range: "latin" | "latin-ext";
}

interface FontFamily {
  family: string;
  pkg: string;
  /**
   * Generic fallback only. A named family here (Impact, Georgia) makes HyperFrames fetch it from Google Fonts at
   * render time, which breaks offline renders.
   */
  fallback: "sans-serif" | "serif";
  faces: FontFace[];
  /** Which of weight and style the browser may fake. A family with no italic file must not get a slanted one. */
  synthesis: "weight style" | "weight" | "none";
}

const RANGES = {
  latin:
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  "latin-ext":
    "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
} as const;

interface VariableOptions {
  /**
   * Fontsource's file variant: `wght` carries the weight axis, `opsz` weight and optical size, `standard` every axis
   * the family has (width too, for Archivo and Bricolage).
   */
  axes?: "wght" | "opsz" | "standard";
  weight?: string;
  italic?: boolean;
}

/** A variable family from a `@fontsource-variable` package: one file per script range and style. */
function variable(name: string, pkg: string, family: string, fallback: FontFamily["fallback"], options: VariableOptions = {}): FontFamily {
  const axes = options.axes ?? "wght";
  const italic = options.italic ?? true;
  const faces: FontFace[] = [];
  for (const range of ["latin", "latin-ext"] as const) {
    for (const style of italic ? (["normal", "italic"] as const) : (["normal"] as const)) faces.push({ file: `${name}-${range}-${axes}-${style}.woff2`, style, weight: options.weight ?? "100 900", range });
  }
  return { family, pkg, fallback, faces, synthesis: italic ? "weight style" : "weight" };
}

/** A static family from a `@fontsource` package: one file per weight, style and range. */
function fixed(name: string, pkg: string, family: string, fallback: FontFamily["fallback"], weights: number[], italic: boolean): FontFamily {
  const faces: FontFace[] = [];
  for (const range of ["latin", "latin-ext"] as const) {
    for (const weight of weights) {
      for (const style of italic ? (["normal", "italic"] as const) : (["normal"] as const)) faces.push({ file: `${name}-${range}-${weight}-${style}.woff2`, style, weight: String(weight), range });
    }
  }
  return { family, pkg, fallback, faces, synthesis: weights.length > 1 ? (italic ? "weight style" : "weight") : "none" };
}

const FONTS: Record<FontId, FontFamily> = {
  inter: variable("inter", "@fontsource-variable/inter", "NS Inter", "sans-serif"),
  // The same files' optical sizes: at caption sizes the browser picks Inter Display, tighter and finer.
  "inter-display": variable("inter", "@fontsource-variable/inter", "NS Inter Display", "sans-serif", { axes: "opsz" }),
  "playfair-display": variable("playfair-display", "@fontsource-variable/playfair-display", "NS Playfair Display", "serif"),
  "bebas-neue": fixed("bebas-neue", "@fontsource/bebas-neue", "NS Bebas Neue", "sans-serif", [400], false),
  "cormorant-garamond": fixed("cormorant-garamond", "@fontsource/cormorant-garamond", "NS Cormorant Garamond", "serif", [400, 500, 600], true),
  fraunces: variable("fraunces", "@fontsource-variable/fraunces", "NS Fraunces", "serif", { axes: "opsz" }),
  "instrument-sans": variable("instrument-sans", "@fontsource-variable/instrument-sans", "NS Instrument Sans", "sans-serif", { weight: "400 700" }),
  archivo: variable("archivo", "@fontsource-variable/archivo", "NS Archivo", "sans-serif", { axes: "standard" }),
  syne: variable("syne", "@fontsource-variable/syne", "NS Syne", "sans-serif", { weight: "400 800", italic: false }),
  "bricolage-grotesque": variable("bricolage-grotesque", "@fontsource-variable/bricolage-grotesque", "NS Bricolage Grotesque", "sans-serif", { axes: "standard", weight: "200 800", italic: false }),
};

export function fontStack(id: FontId): string {
  const font = FONTS[id];
  return `"${font.family}", ${font.fallback}`;
}

export function fontSynthesis(id: FontId): string {
  return FONTS[id].synthesis;
}

const require = createRequire(import.meta.url);

function packageDir(pkg: string): string {
  return dirname(require.resolve(`${pkg}/package.json`));
}

/** Copies the font files a composition uses into `<dir>/fonts` and returns their @font-face rules. */
export async function installFonts(ids: Iterable<FontId>, dir: string): Promise<string> {
  const fontsDir = join(dir, "fonts");
  await mkdir(fontsDir, { recursive: true });
  const rules: string[] = [];
  for (const id of new Set(ids)) {
    const font = FONTS[id];
    const from = join(packageDir(font.pkg), "files");
    for (const face of font.faces) {
      await copyFile(join(from, face.file), join(fontsDir, face.file));
      rules.push(
        `@font-face{font-family:"${font.family}";font-style:${face.style};font-weight:${face.weight};font-display:block;` +
          `src:url("fonts/${face.file}") format("woff2");unicode-range:${RANGES[face.range]};}`,
      );
    }
  }
  return rules.join("\n");
}
