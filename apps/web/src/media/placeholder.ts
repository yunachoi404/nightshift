/**
 * Procedural placeholder pictures for the mock engine. Every mock asset is a `mock:` URL that encodes a
 * scene spec; `<Media>` renders it on a canvas. Real engine assets are plain URLs and never come here.
 *
 * The scenes are deliberately abstract (skies, silhouettes, light) so nothing reads as a fake photo.
 */

export type Quality = "still" | "draft" | "final";
export type SceneKind = "landscape" | "city" | "interior" | "product" | "abstract" | "water";

export interface SceneSpec {
  kind: SceneKind;
  seed: number;
  w: number;
  h: number;
  quality: Quality;
  palette: number;
  /** Camera move id from the shot, drives the animation. */
  move: string;
}

export function mockUrl(spec: SceneSpec): string {
  return `mock:${spec.kind}:${spec.seed}:${spec.w}x${spec.h}:${spec.quality}:${spec.palette}:${spec.move}`;
}

export function parseMockUrl(url: string): SceneSpec | null {
  if (!url.startsWith("mock:")) return null;
  const [, kind, seed, size, quality, palette, move] = url.split(":");
  const [w, h] = (size ?? "768x432").split("x").map(Number);
  return {
    kind: (kind as SceneKind) ?? "landscape",
    seed: Number(seed ?? 1),
    w: w ?? 768,
    h: h ?? 432,
    quality: (quality as Quality) ?? "still",
    palette: Number(palette ?? 0),
    move: move ?? "static",
  };
}

export function kindForPrompt(prompt: string, template: string): SceneKind {
  const p = prompt.toLowerCase();
  if (template === "product_ad") return "product";
  if (/\b(gradient|ink|bokeh|lines|shapes|abstract|dust)\b/.test(p)) return "abstract";
  if (/\b(sea|ocean|pier|pool|lake|water|lighthouse|harbor|shore|waves?)\b/.test(p)) return "water";
  if (/\b(city|street|rooftop|garage|highway|tunnel|overpass|traffic|diner|laundromat|skyline|bus)\b/.test(p)) return "city";
  if (/\b(room|window|desk|kitchen|bedroom|booth|curtains?|cup|page|notebook|lamp)\b/.test(p)) return "interior";
  return "landscape";
}

// ---------------------------------------------------------------- palettes

interface Palette {
  sky: [string, string, string];
  far: string;
  near: string;
  light: string;
  glow: string;
  haze: string;
}

const palettes: Palette[] = [
  // 0 natural
  { sky: ["#6f8fb3", "#b9c7d6", "#e7dcc8"], far: "#55657a", near: "#232b36", light: "#fff4d6", glow: "rgba(255,244,214,0.35)", haze: "rgba(200,210,220,0.25)" },
  // 1 golden hour
  { sky: ["#3a2a4d", "#b65a3a", "#f3b465"], far: "#5b3a3f", near: "#1d1418", light: "#ffd27a", glow: "rgba(255,190,100,0.5)", haze: "rgba(255,170,90,0.22)" },
  // 2 neon night
  { sky: ["#0a0d1f", "#1b1f4a", "#3a2a6a"], far: "#2a2f5c", near: "#0a0b16", light: "#ff5fb5", glow: "rgba(90,210,255,0.45)", haze: "rgba(120,80,200,0.25)" },
  // 3 overcast
  { sky: ["#5c6670", "#8d969e", "#b6bcc2"], far: "#6a737c", near: "#2f353c", light: "#e9edf0", glow: "rgba(233,237,240,0.2)", haze: "rgba(180,188,195,0.35)" },
  // 4 noir
  { sky: ["#070708", "#17181c", "#2b2d33"], far: "#1c1d22", near: "#050506", light: "#e8e8ea", glow: "rgba(232,232,234,0.35)", haze: "rgba(120,120,130,0.2)" },
  // 5 blue dawn
  { sky: ["#0b1430", "#20335f", "#6c84a8"], far: "#2a3550", near: "#0c1020", light: "#ffb454", glow: "rgba(255,180,84,0.45)", haze: "rgba(120,150,200,0.22)" },
  // 6 studio warm (products)
  { sky: ["#1b1714", "#3a302a", "#6e5a4c"], far: "#4a3b32", near: "#120f0d", light: "#ffe6c2", glow: "rgba(255,230,194,0.4)", haze: "rgba(120,100,80,0.2)" },
  // 7 forest
  { sky: ["#1e2b2a", "#4e6b5a", "#a3b79a"], far: "#2f4a3d", near: "#101a15", light: "#f2ffd9", glow: "rgba(242,255,217,0.3)", haze: "rgba(140,170,150,0.25)" },
];

// ---------------------------------------------------------------- rng

function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- scene drawing

const sceneCache = new Map<string, HTMLCanvasElement>();
const grainCache = new Map<number, HTMLCanvasElement>();

function grain(size: number, seed: number): HTMLCanvasElement {
  const key = seed % 7;
  const cached = grainCache.get(key);
  if (cached) return cached;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(size, size);
  const r = rng(seed + 99);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 110 + Math.floor(r() * 90);
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  grainCache.set(key, c);
  return c;
}

function ridge(ctx: CanvasRenderingContext2D, w: number, h: number, y0: number, amp: number, r: () => number, color: string, peaks: number) {
  ctx.beginPath();
  ctx.moveTo(0, h);
  ctx.lineTo(0, y0 + (r() - 0.5) * amp);
  const steps = peaks;
  for (let i = 1; i <= steps; i++) {
    const x = (i / steps) * w;
    const y = y0 + (r() - 0.5) * amp * (i % 2 ? 1.3 : 0.6);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

function drawBase(ctx: CanvasRenderingContext2D, w: number, h: number, spec: SceneSpec) {
  const pal = palettes[spec.palette % palettes.length]!;
  const r = rng(spec.seed);
  // sky
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, pal.sky[0]);
  sky.addColorStop(0.55, pal.sky[1]);
  sky.addColorStop(1, pal.sky[2]);
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  const horizon = h * (0.56 + r() * 0.16);
  const lightX = w * (0.25 + r() * 0.5);
  const lightY = spec.kind === "interior" ? h * 0.42 : horizon - h * (0.05 + r() * 0.25);

  // light source and glow
  if (spec.kind !== "abstract" && spec.kind !== "product") {
    const glow = ctx.createRadialGradient(lightX, lightY, 0, lightX, lightY, w * 0.55);
    glow.addColorStop(0, pal.glow);
    glow.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);
    if (spec.kind !== "interior") {
      ctx.beginPath();
      ctx.arc(lightX, lightY, h * (0.035 + r() * 0.03), 0, Math.PI * 2);
      ctx.fillStyle = pal.light;
      ctx.fill();
    }
  }

  switch (spec.kind) {
    case "landscape": {
      ridge(ctx, w, h, horizon - h * 0.08, h * 0.16, r, pal.far, 7);
      ctx.fillStyle = pal.haze;
      ctx.fillRect(0, horizon - h * 0.1, w, h * 0.12);
      ridge(ctx, w, h, horizon + h * 0.06, h * 0.12, r, pal.near, 9);
      // a small figure
      if (r() > 0.4) {
        const fx = w * (0.3 + r() * 0.4);
        const fy = horizon + h * 0.12;
        ctx.fillStyle = pal.near;
        ctx.fillRect(fx - h * 0.006, fy - h * 0.06, h * 0.012, h * 0.06);
        ctx.beginPath();
        ctx.arc(fx, fy - h * 0.07, h * 0.012, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "water": {
      ridge(ctx, w, h, horizon - h * 0.05, h * 0.1, r, pal.far, 5);
      // sea
      const sea = ctx.createLinearGradient(0, horizon, 0, h);
      sea.addColorStop(0, pal.far);
      sea.addColorStop(1, pal.near);
      ctx.fillStyle = sea;
      ctx.fillRect(0, horizon, w, h - horizon);
      // reflection streak
      const refl = ctx.createLinearGradient(0, horizon, 0, h);
      refl.addColorStop(0, pal.glow);
      refl.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = refl;
      for (let i = 0; i < 18; i++) {
        const y = horizon + (i / 18) * (h - horizon);
        const ww = w * (0.04 + (i / 18) * 0.16) * (0.6 + r() * 0.8);
        ctx.fillRect(lightX - ww / 2, y, ww, 2 + (i / 18) * 4);
      }
      // pier or lighthouse
      if (r() > 0.5) {
        const px = w * (0.15 + r() * 0.2);
        ctx.fillStyle = pal.near;
        ctx.fillRect(px, horizon - h * 0.18, h * 0.03, h * 0.18);
        ctx.fillStyle = pal.light;
        ctx.fillRect(px + h * 0.006, horizon - h * 0.17, h * 0.018, h * 0.012);
      }
      break;
    }
    case "city": {
      ctx.fillStyle = pal.far;
      let x = 0;
      while (x < w) {
        const bw = w * (0.03 + r() * 0.08);
        const bh = h * (0.12 + r() * 0.3);
        ctx.fillRect(x, horizon - bh, bw, bh + 2);
        x += bw + w * 0.004;
      }
      ctx.fillStyle = pal.haze;
      ctx.fillRect(0, horizon - h * 0.15, w, h * 0.17);
      ctx.fillStyle = pal.near;
      x = -w * 0.02;
      const windows: Array<[number, number]> = [];
      while (x < w) {
        const bw = w * (0.05 + r() * 0.12);
        const bh = h * (0.2 + r() * 0.45);
        ctx.fillRect(x, horizon + h * 0.1 - bh, bw, bh + h);
        const cols = Math.max(1, Math.floor(bw / (w * 0.016)));
        const rows = Math.max(1, Math.floor(bh / (h * 0.045)));
        for (let c = 0; c < cols; c++)
          for (let rr = 0; rr < rows; rr++)
            if (r() > 0.72) windows.push([x + (c + 0.5) * (bw / cols), horizon + h * 0.1 - bh + (rr + 0.5) * (bh / rows)]);
        x += bw + w * 0.006;
      }
      ctx.fillStyle = pal.light;
      ctx.globalAlpha = 0.75;
      for (const [wx, wy] of windows) ctx.fillRect(wx - 1.5, wy - 1.5, 3, 3);
      ctx.globalAlpha = 1;
      // wet street reflection
      const street = ctx.createLinearGradient(0, horizon + h * 0.1, 0, h);
      street.addColorStop(0, pal.haze);
      street.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = street;
      ctx.fillRect(0, horizon + h * 0.1, w, h);
      break;
    }
    case "interior": {
      ctx.fillStyle = pal.near;
      ctx.fillRect(0, 0, w, h);
      // window
      const wx = w * (0.18 + r() * 0.3);
      const wy = h * (0.12 + r() * 0.1);
      const ww = w * (0.2 + r() * 0.12);
      const wh = h * (0.45 + r() * 0.15);
      const win = ctx.createLinearGradient(0, wy, 0, wy + wh);
      win.addColorStop(0, pal.sky[1]);
      win.addColorStop(1, pal.sky[2]);
      ctx.fillStyle = win;
      ctx.fillRect(wx, wy, ww, wh);
      ctx.fillStyle = pal.near;
      ctx.fillRect(wx + ww / 2 - 2, wy, 4, wh);
      ctx.fillRect(wx, wy + wh / 2 - 2, ww, 4);
      // light shaft onto floor
      ctx.beginPath();
      ctx.moveTo(wx, wy + wh);
      ctx.lineTo(wx + ww, wy + wh);
      ctx.lineTo(wx + ww * 1.9, h);
      ctx.lineTo(wx - ww * 0.3, h);
      ctx.closePath();
      const shaft = ctx.createLinearGradient(0, wy + wh, 0, h);
      shaft.addColorStop(0, pal.glow);
      shaft.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = shaft;
      ctx.fill();
      // table and lamp
      const ty = h * 0.72;
      ctx.fillStyle = pal.far;
      ctx.fillRect(w * 0.55, ty, w * 0.4, h * 0.02);
      ctx.fillRect(w * 0.6, ty, w * 0.012, h * 0.28);
      ctx.fillRect(w * 0.9, ty, w * 0.012, h * 0.28);
      const lx = w * 0.78;
      const lampGlow = ctx.createRadialGradient(lx, ty - h * 0.12, 0, lx, ty - h * 0.12, h * 0.3);
      lampGlow.addColorStop(0, pal.glow);
      lampGlow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = lampGlow;
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = pal.light;
      ctx.beginPath();
      ctx.moveTo(lx - h * 0.06, ty - h * 0.1);
      ctx.lineTo(lx + h * 0.06, ty - h * 0.1);
      ctx.lineTo(lx + h * 0.035, ty - h * 0.18);
      ctx.lineTo(lx - h * 0.035, ty - h * 0.18);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "product": {
      const p = palettes[6]!;
      const bg = ctx.createRadialGradient(w * 0.5, h * 0.45, 0, w * 0.5, h * 0.45, w * 0.7);
      bg.addColorStop(0, p.far);
      bg.addColorStop(1, p.near);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
      // pedestal
      const cx = w * 0.5;
      const py = h * 0.72;
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.beginPath();
      ctx.ellipse(cx, py + h * 0.02, w * 0.22, h * 0.05, 0, 0, Math.PI * 2);
      ctx.fill();
      // product body
      const bw = w * (0.12 + r() * 0.06);
      const bh = h * (0.3 + r() * 0.12);
      const grd = ctx.createLinearGradient(cx - bw / 2, 0, cx + bw / 2, 0);
      grd.addColorStop(0, "#3a3430");
      grd.addColorStop(0.45, "#8a7b6c");
      grd.addColorStop(0.55, "#d9c6ad");
      grd.addColorStop(1, "#2a2522");
      ctx.fillStyle = grd;
      roundRect(ctx, cx - bw / 2, py - bh, bw, bh, w * 0.02);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      roundRect(ctx, cx - bw * 0.35, py - bh + h * 0.03, bw * 0.08, bh * 0.5, 3);
      ctx.fill();
      // key light
      const key = ctx.createRadialGradient(w * 0.3, h * 0.1, 0, w * 0.3, h * 0.1, w * 0.6);
      key.addColorStop(0, p.glow);
      key.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = key;
      ctx.fillRect(0, 0, w, h);
      break;
    }
    case "abstract": {
      ctx.fillStyle = pal.sky[0];
      ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 9; i++) {
        const cx = w * r();
        const cy = h * r();
        const rad = w * (0.08 + r() * 0.3);
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
        const col = i % 3 === 0 ? pal.glow : i % 3 === 1 ? pal.haze : "rgba(255,255,255,0.12)";
        g.addColorStop(0, col);
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
      ctx.strokeStyle = pal.light;
      ctx.globalAlpha = 0.25;
      ctx.lineWidth = 1;
      for (let i = 0; i < 5; i++) {
        ctx.beginPath();
        const y = h * r();
        ctx.moveTo(0, y);
        ctx.bezierCurveTo(w * 0.3, y + (r() - 0.5) * h * 0.6, w * 0.7, y + (r() - 0.5) * h * 0.6, w, h * r());
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      break;
    }
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** The static scene at the spec's resolution, cached. Drafts render at half size so they come out soft. */
export function sceneCanvas(spec: SceneSpec): HTMLCanvasElement {
  const key = mockUrl(spec);
  const cached = sceneCache.get(key);
  if (cached) return cached;
  const scale = spec.quality === "draft" ? 0.5 : 1;
  const c = document.createElement("canvas");
  c.width = Math.round(spec.w * scale);
  c.height = Math.round(spec.h * scale);
  const ctx = c.getContext("2d")!;
  // Draw oversize so animation can pan without showing edges.
  const w = c.width;
  const h = c.height;
  drawBase(ctx, w, h, spec);
  if (spec.quality === "draft") {
    ctx.fillStyle = "rgba(120,130,150,0.08)";
    ctx.fillRect(0, 0, w, h);
  }
  sceneCache.set(key, c);
  return c;
}

export function moveTransform(move: string, t: number, dur: number): { scale: number; dx: number; dy: number } {
  const p = dur > 0 ? Math.min(1, t / dur) : 0;
  const ease = p * p * (3 - 2 * p);
  switch (move) {
    case "dolly_in":
      return { scale: 1.08 + ease * 0.14, dx: 0, dy: 0 };
    case "dolly_out":
      return { scale: 1.24 - ease * 0.14, dx: 0, dy: 0 };
    case "crash_zoom":
      return { scale: 1.08 + Math.pow(p, 3) * 0.3, dx: 0, dy: 0 };
    case "pan_left":
      return { scale: 1.14, dx: -0.06 + ease * 0.12, dy: 0 };
    case "pan_right":
      return { scale: 1.14, dx: 0.06 - ease * 0.12, dy: 0 };
    case "crane_up":
      return { scale: 1.14, dx: 0, dy: 0.05 - ease * 0.1 };
    case "orbit_left":
      return { scale: 1.16 + Math.sin(p * Math.PI) * 0.04, dx: 0.05 - ease * 0.1, dy: 0 };
    case "handheld":
      return { scale: 1.1, dx: Math.sin(t * 1.7) * 0.006 + Math.sin(t * 0.6) * 0.008, dy: Math.cos(t * 1.3) * 0.006 };
    default:
      return { scale: 1.06 + ease * 0.02, dx: 0, dy: 0 };
  }
}

/** Draws one frame onto `target` (which should already have the display size). */
export function drawFrame(target: HTMLCanvasElement, spec: SceneSpec, t: number, dur: number, animate: boolean) {
  const ctx = target.getContext("2d");
  if (!ctx) return;
  const scene = sceneCanvas(spec);
  const W = target.width;
  const H = target.height;
  const tr = animate ? moveTransform(spec.move, t, dur) : { scale: 1.04, dx: 0, dy: 0 };
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = spec.quality === "draft" ? "low" : "high";
  ctx.translate(W / 2 + tr.dx * W, H / 2 + tr.dy * H);
  ctx.scale(tr.scale, tr.scale);
  ctx.drawImage(scene, -W / 2, -H / 2, W, H);
  ctx.restore();

  // flicker for drafts: a touch of exposure drift
  if (animate && spec.quality === "draft") {
    ctx.fillStyle = `rgba(255,255,255,${0.02 + Math.sin(t * 9) * 0.015})`;
    ctx.fillRect(0, 0, W, H);
  }
  // vignette
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, spec.quality === "final" ? "rgba(0,0,0,0.42)" : "rgba(0,0,0,0.3)");
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
  // grain
  const g = grain(128, spec.seed + (animate ? Math.floor(t * 24) : 0));
  ctx.save();
  ctx.globalAlpha = spec.quality === "draft" ? 0.16 : spec.quality === "final" ? 0.07 : 0.1;
  ctx.globalCompositeOperation = "overlay";
  const pat = ctx.createPattern(g, "repeat");
  if (pat) {
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, W, H);
  }
  ctx.restore();
}

const dataUrlCache = new Map<string, string>();

/** A PNG data URL for `<img>` use (posters, drag previews). */
export function stillDataUrl(spec: SceneSpec, w = 480): string {
  const key = `${mockUrl(spec)}@${w}`;
  const cached = dataUrlCache.get(key);
  if (cached) return cached;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = Math.round((w * spec.h) / spec.w);
  drawFrame(c, spec, 0, 1, false);
  const url = c.toDataURL("image/png");
  dataUrlCache.set(key, url);
  return url;
}
