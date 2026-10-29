/**
 * Tiny pure-JS image helpers for placeholder media: an RGBA canvas, a 5x7 bitmap font (the Mac's
 * Homebrew ffmpeg has no drawtext) and a PNG encoder. No native dependencies.
 */
import { createHash } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";

export class Canvas {
  readonly data: Uint8Array;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8Array(width * height * 4);
  }

  /** Alpha-blend one pixel. */
  blend(x: number, y: number, r: number, g: number, b: number, a = 1): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    const d = this.data;
    const inv = 1 - a;
    d[i] = Math.round(r * a + d[i]! * inv);
    d[i + 1] = Math.round(g * a + d[i + 1]! * inv);
    d[i + 2] = Math.round(b * a + d[i + 2]! * inv);
    d[i + 3] = Math.round(255 * a + d[i + 3]! * inv);
  }

  fillRect(x0: number, y0: number, w: number, h: number, rgb: Rgb, a = 1): void {
    for (let y = Math.max(0, y0); y < Math.min(this.height, y0 + h); y++) {
      for (let x = Math.max(0, x0); x < Math.min(this.width, x0 + w); x++) this.blend(x, y, rgb[0], rgb[1], rgb[2], a);
    }
  }

  /** Draw text with the 5x7 font, each font pixel `scale` px square. Unknown characters draw as spaces. */
  text(x0: number, y0: number, text: string, scale: number, rgb: Rgb = [255, 255, 255]): void {
    let x = x0;
    for (const ch of text.toUpperCase()) {
      const glyph = FONT[ch];
      if (glyph) {
        glyph.forEach((row, gy) => {
          for (let gx = 0; gx < 5; gx++) {
            if (row & (1 << (4 - gx))) this.fillRect(x + gx * scale, y0 + gy * scale, scale, scale, rgb);
          }
        });
      }
      x += 6 * scale;
    }
  }

  toPng(text?: Record<string, string>): Buffer {
    return encodePng(this.width, this.height, this.data, text);
  }
}

export type Rgb = [number, number, number];

export function textWidth(text: string, scale: number): number {
  return Math.max(0, text.length * 6 - 1) * scale;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

export function encodePng(width: number, height: number, rgba: Uint8Array, text: Record<string, string> = {}): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const texts = Object.entries(text).map(([k, v]) => chunk("tEXt", Buffer.concat([Buffer.from(k, "latin1"), Buffer.from([0]), Buffer.from(v, "latin1")])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...texts,
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Width and height from a PNG header, without decoding. */
export function pngSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Deterministic pseudo-random numbers from a string, for placeholders that look the same every run. */
export function seededRandom(seed: string): () => number {
  let h = createHash("sha256").update(seed).digest().readUInt32LE(0) || 1;
  return () => {
    h ^= h << 13;
    h ^= h >>> 17;
    h ^= h << 5;
    return ((h >>> 0) % 1_000_000) / 1_000_000;
  };
}

function hsl(h: number, s: number, l: number): Rgb {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * A calm placeholder "film still": a sky gradient, a sun, two layers of hills. Colors and shapes come
 * from the seed text, so a prompt and seed always give the same picture.
 */
export function placeholderScene(width: number, height: number, seedText: string): Canvas {
  const rnd = seededRandom(seedText);
  const hue = rnd() * 360;
  const top = hsl(hue, 0.55, 0.22 + rnd() * 0.15);
  const horizon = hsl((hue + 30 + rnd() * 40) % 360, 0.7, 0.6 + rnd() * 0.15);
  const far = hsl((hue + 180) % 360, 0.25, 0.32);
  const near = hsl((hue + 200) % 360, 0.3, 0.16);
  const sun: Rgb = hsl((hue + 40) % 360, 0.9, 0.82);
  const horizonY = height * (0.55 + rnd() * 0.15);
  // The sun is the scene's subject, and an export crops around the subject: near the middle, the crop stays near the
  // middle too, where the shot's tag is.
  const sunX = width * (0.45 + rnd() * 0.1);
  const sunY = horizonY - height * (0.08 + rnd() * 0.2);
  const sunR = height * (0.06 + rnd() * 0.06);
  const waves = [rnd() * 6, rnd() * 6, 1 + rnd() * 3, 2 + rnd() * 4];
  const c = new Canvas(width, height);
  for (let y = 0; y < height; y++) {
    const sky = mix(top, horizon, Math.min(1, y / horizonY));
    for (let x = 0; x < width; x++) {
      let col = sky;
      const d = Math.hypot(x - sunX, y - sunY);
      if (d < sunR) col = sun;
      else if (d < sunR * 3) col = mix(sky, sun, 0.35 * (1 - (d - sunR) / (sunR * 2)) ** 2);
      const u = x / width;
      const farY = horizonY - height * 0.06 * (1 + Math.sin(u * waves[2]! * 3 + waves[0]!));
      const nearY = horizonY + height * 0.08 * (1 + Math.sin(u * waves[3]! * 2 + waves[1]!)) * 0.6;
      if (y > nearY) col = mix(near, [0, 0, 0], Math.min(0.6, (y - nearY) / height));
      else if (y > farY) col = mix(far, horizon, 0.15);
      c.blend(x, y, col[0], col[1], col[2], 1);
    }
  }
  return c;
}

/**
 * The part of a frame that an export keeps whichever aspect it crops the shot to around its centre (16:9, 9:16, 1:1):
 * as wide as a 9:16 crop of a landscape frame, as tall as a 16:9 crop of a portrait one.
 */
export function cropSafeArea(width: number, height: number): { x: number; y: number; width: number; height: number } {
  const w = Math.min(width, (height * 9) / 16);
  const h = Math.min(height, (width * 9) / 16);
  // Whole pixels inside the crop, never past its edge.
  const x = Math.ceil((width - w) / 2);
  const y = Math.ceil((height - h) / 2);
  return { x, y, width: Math.floor((width + w) / 2) - x, height: Math.floor((height + h) / 2) - y };
}

/**
 * How wide a shot tag may be: half the crop-safe area. An export crops around the shot's subject, not exactly its
 * centre, and a mock camera pan moves the subject by about 6% of the width; the other half is room for that.
 */
const tagRoom = (width: number, height: number) => cropSafeArea(width, height).width * 0.5;

/** A tag's lines: "Final · same take" is "FINAL" over "SAME TAKE", half as wide as one line. */
const tagLines = (text: string) => text.split(" · ");

/** Whether `text` fits a shot tag in the crop-safe area of a frame, at the smallest size. */
export function tagFits(width: number, height: number, text: string): boolean {
  return Math.max(...tagLines(text).map((l) => textWidth(l, 1))) + 8 <= tagRoom(width, height);
}

/**
 * Where a shot's tag sits: centred, at the top of the crop-safe area, inset by 5% of the short side, so an export
 * that crops the shot to any aspect around its centre, or pushes in slowly, keeps it whole.
 */
export function tagPosition(width: number, height: number, tagWidth: number): { x: number; y: number } {
  const safe = cropSafeArea(width, height);
  return { x: Math.max(0, Math.round((width - tagWidth) / 2)), y: safe.y + Math.round(Math.min(width, height) * 0.05) };
}

/**
 * The mock's tag on a placeholder shot ("Draft · seed 12", "Final · same take"): light pixel text on a dark box, one
 * line per part, sized from the frame's short side and narrow enough for the crop-safe area, so a 9:16 export of a
 * 16:9 shot keeps it whole. `min` makes the box at least that big, to cover an older tag under it.
 */
export function shotTag(width: number, height: number, text: string, min: { width: number; height: number } = { width: 0, height: 0 }): Canvas {
  const lines = tagLines(text);
  const widest = (scale: number) => Math.max(...lines.map((l) => textWidth(l, scale)));
  let scale = Math.max(1, Math.floor((Math.max(14, Math.round(Math.min(width, height) * 0.075)) * 0.6) / 7));
  while (scale > 1 && widest(scale) + scale * 8 > tagRoom(width, height)) scale--;
  const lineGap = 2 * scale;
  const textH = lines.length * 7 * scale + (lines.length - 1) * lineGap;
  const pad = Math.max(3, Math.round(2.5 * scale));
  const boxH = Math.min(height, Math.max(textH + 2 * pad, min.height));
  const boxW = Math.min(width, Math.max(widest(scale) + scale * 8, min.width));
  const c = new Canvas(boxW, boxH);
  c.fillRect(0, 0, boxW, boxH, [12, 12, 16], 1);
  const top = Math.round((boxH - textH) / 2);
  lines.forEach((line, i) => c.text(Math.round((boxW - textWidth(line, scale)) / 2), top + i * (7 * scale + lineGap), line, scale, [245, 240, 225]));
  return c;
}

const FONT: Record<string, number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30], E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  "0": [14, 17, 19, 21, 25, 17, 14], "1": [4, 12, 4, 4, 4, 4, 14], "2": [14, 17, 1, 2, 4, 8, 31],
  "3": [31, 2, 4, 2, 1, 17, 14], "4": [2, 6, 10, 18, 31, 2, 2], "5": [31, 16, 30, 1, 1, 17, 14],
  "6": [6, 8, 16, 30, 17, 17, 14], "7": [31, 1, 2, 4, 8, 8, 8], "8": [14, 17, 17, 14, 17, 17, 14],
  "9": [14, 17, 17, 15, 1, 2, 12],
  " ": [0, 0, 0, 0, 0, 0, 0], ".": [0, 0, 0, 0, 0, 12, 12], ",": [0, 0, 0, 0, 12, 4, 8],
  "-": [0, 0, 0, 31, 0, 0, 0], ":": [0, 12, 12, 0, 12, 12, 0], "/": [1, 2, 2, 4, 8, 8, 16],
  "!": [4, 4, 4, 4, 4, 0, 4], "?": [14, 17, 1, 2, 4, 0, 4], "'": [4, 4, 8, 0, 0, 0, 0],
  "#": [10, 10, 31, 10, 31, 10, 10], "(": [2, 4, 8, 8, 8, 4, 2], ")": [8, 4, 2, 2, 2, 4, 8],
  "&": [12, 18, 20, 8, 21, 18, 13], "+": [0, 4, 4, 31, 4, 4, 0], "·": [0, 0, 0, 12, 12, 0, 0],
};
