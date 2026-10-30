/**
 * The editor preview's captions: the export's four caption looks (packages/editor/src/render/captions.ts), drawn
 * from the playhead so the preview moves the way the MP4 will. Same faces, sizes and timings as the export; only
 * the placement is simpler (the export also keeps captions off the subject).
 */
import type { Aspect, Caption, TemplateId } from "@nightshift/contract";
import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/archivo/standard.css";
import "@fontsource-variable/bricolage-grotesque/standard.css";
import "@fontsource-variable/instrument-sans/wght.css";
import { cx } from "@/ui/primitives";

/** The UI's caption styles. Clean: karaoke. Boxed: chip. Film: subtitles. Lyrics: kinetic. */
export type CaptionLook = "clean" | "boxed" | "serif" | "lyrics";
export type CaptionPos = "bottom" | "center";

interface TemplateCaptions {
  look: CaptionLook;
  font: string;
  text: string;
  accent: string;
  /** Text on the accent colour. */
  accentText: string;
  scrim: string;
  uppercase: boolean;
  /** Where the block's bottom edge sits, from the frame's bottom, by default. */
  lower: boolean;
  size: number;
}

const INTER = '"Inter Variable", sans-serif';
const TEMPLATES: Record<TemplateId, TemplateCaptions> = {
  // As the export: the cinematic palette and face, with the talking intro's karaoke captions low in the frame.
  blank: { look: "clean", font: '"Instrument Sans Variable", sans-serif', text: "#F3EEE4", accent: "#E7B356", accentText: "#14110C", scrim: "rgba(0,0,0,0.55)", uppercase: false, lower: true, size: 1 },
  what_if: { look: "clean", font: INTER, text: "#ffffff", accent: "#ffd45e", accentText: "#14110c", scrim: "rgba(0,0,0,0.6)", uppercase: false, lower: true, size: 1.6 },
  talking_intro: { look: "clean", font: INTER, text: "#ffffff", accent: "#7DD3FC", accentText: "#0E1116", scrim: "rgba(10,12,16,0.6)", uppercase: false, lower: true, size: 1 },
  product_ad: { look: "boxed", font: '"Archivo Variable", sans-serif', text: "#ffffff", accent: "#FF5A3C", accentText: "#FFF6F1", scrim: "rgba(10,10,14,0.72)", uppercase: false, lower: true, size: 1 },
  music_video: { look: "lyrics", font: '"Bricolage Grotesque Variable", sans-serif', text: "#ffffff", accent: "#D9FF3F", accentText: "#0B0B0B", scrim: "rgba(0,0,0,0.45)", uppercase: true, lower: false, size: 1 },
  cinematic_shot: { look: "serif", font: '"Instrument Sans Variable", sans-serif', text: "#F3EEE4", accent: "#E7B356", accentText: "#14110C", scrim: "rgba(0,0,0,0.55)", uppercase: false, lower: false, size: 1 },
  camera_move: { look: "serif", font: '"Instrument Sans Variable", sans-serif', text: "#F3EEE4", accent: "#E7B356", accentText: "#14110C", scrim: "rgba(0,0,0,0.55)", uppercase: false, lower: false, size: 1 },
  vfx_effect: { look: "serif", font: '"Instrument Sans Variable", sans-serif', text: "#F3EEE4", accent: "#E7B356", accentText: "#14110C", scrim: "rgba(0,0,0,0.55)", uppercase: false, lower: false, size: 1 },
};

export function defaultCaptionLook(template: TemplateId): CaptionLook {
  return TEMPLATES[template].look;
}

export function defaultCaptionSize(template: TemplateId): number {
  return TEMPLATES[template].size;
}

/** Font size per look in units of 1% of the frame's short side, and per frame shape (as the export). */
const SIZE: Record<CaptionLook, { base: number; landscape: number; portrait: number; square: number }> = {
  serif: { base: 3.5, landscape: 1, portrait: 1.3, square: 1.12 },
  clean: { base: 4.6, landscape: 1.15, portrait: 1.3, square: 1.12 },
  boxed: { base: 5, landscape: 1, portrait: 1.3, square: 1.12 },
  lyrics: { base: 9.6, landscape: 1, portrait: 1.3, square: 1.12 },
};

interface Word {
  start: number;
  end: number;
  text: string;
}

export function CaptionPreview({ caption, time, look, pos, aspect, scale, template }: { caption: Caption; time: number; look: CaptionLook; pos: CaptionPos; aspect: Aspect; scale: number; template: TemplateId }) {
  const t = TEMPLATES[template];
  const shape = aspect === "9:16" ? "portrait" : aspect === "1:1" ? "square" : "landscape";
  // 1% of the short side, in container units of the frame.
  const unit = shape === "landscape" ? "0.5625cqw" : "1cqw";
  const size = SIZE[look].base * SIZE[look][shape] * scale;
  const width = shape === "portrait" ? 78 : shape === "square" ? 84 : look === "serif" ? 62 : 70;
  const bottom = pos === "center" ? 38 : { landscape: t.lower ? 12 : 8, portrait: t.lower ? 32 : 24, square: t.lower ? 13 : 9 }[shape];
  const words = timedWords(caption);
  const end = caption.end;
  const style = {
    "--cpv-size": `calc(${unit} * ${size})`,
    "--cpv-text": t.text,
    "--cpv-accent": t.accent,
    "--cpv-accent-text": t.accentText,
    "--cpv-scrim": t.scrim,
    fontFamily: t.font,
    width: `${width}%`,
    bottom: `${bottom}%`,
  } as CSSProperties;
  const body =
    look === "clean" ? <Clean words={words} start={caption.start} end={end} time={time} /> : look === "boxed" ? <Boxed words={words} start={caption.start} end={end} time={time} /> : look === "lyrics" ? <Lyrics words={words} start={caption.start} end={end} time={time} /> : <Film words={words} start={caption.start} end={end} time={time} />;
  return (
    <div className="cpv-frame">
      <div className={cx("cpv", `cpv--${look}`, t.uppercase && look === "lyrics" && "cpv--upper")} style={style}>
        {body}
      </div>
    </div>
  );
}

interface LookProps {
  words: Word[];
  start: number;
  end: number;
  time: number;
}

function Film({ words, start, end, time }: LookProps) {
  const length = end - start;
  const inDur = clamp(length * 0.4, 0.2, 0.6);
  const outDur = clamp(length * 0.22, 0.12, 0.34);
  const t0 = start - 0.05;
  const leave = Math.max(t0 + inDur, end - outDur);
  const arrive = ease.out(prog(time, t0, t0 + inDur));
  const gone = ease.in(prog(time, leave, end));
  const mid = (words.length - 1) / 2;
  const gather = ease.out(prog(time, t0, t0 + inDur * 1.6));
  const line: CSSProperties = {
    opacity: Math.min(ease.out(prog(time, t0, t0 + inDur * 0.7)), 1 - gone),
    filter: `blur(${(0.22 * (1 - arrive) + 0.14 * gone).toFixed(3)}em)`,
    translate: `0 ${(0.2 * (1 - ease.out(prog(time, t0, t0 + inDur * 1.2))) - 0.12 * gone).toFixed(3)}em`,
  };
  return (
    <span className="cpv-line" style={line}>
      {words.map((w, j) => {
        const from = mid > 0 ? ((j - mid) / mid) * 0.3 : 0;
        return (
          <span key={j} className="cpv-w" style={{ translate: `${(from * (1 - gather)).toFixed(3)}em 0` }}>
            {w.text}{" "}
          </span>
        );
      })}
    </span>
  );
}

function Clean({ words, start, end, time }: LookProps) {
  const n = words.length;
  const length = end - start;
  const inDur = clamp(length * 0.5, 0.26, 0.62);
  const stagger = Math.min(0.05, (length * 0.3) / n);
  const outDur = clamp(length * 0.2, 0.14, 0.3);
  const outStagger = Math.min(0.025, (length * 0.08) / n);
  const t0 = start - 0.01;
  return (
    <span className="cpv-line">
      {words.map((w, j) => {
        const inAt = t0 + j * stagger;
        const outAt = Math.max(inAt + inDur, end - outDur - (n - 1 - j) * outStagger);
        const rise = ease.out(prog(time, inAt, inAt + inDur));
        const leave = ease.in(prog(time, outAt, outAt + outDur));
        const said = Math.max(w.start, inAt + 0.04);
        const next = words[j + 1]?.start ?? end;
        const filled = Math.max(said + 0.12, Math.min(w.end, next));
        const off = Math.max(filled, next);
        const fill = ease.sine(prog(time, said, filled));
        const lit = j < n - 1 ? 1 - ease.inOut(prog(time, off, off + 0.2)) : 1;
        return (
          <span key={j}>
            <span className="cpv-w">
              <span className="cpv-wi" style={{ translate: `0 ${(1.2 * (1 - rise) - 1.2 * leave).toFixed(3)}em`, opacity: Math.min(ease.out(prog(time, inAt, inAt + inDur * 0.5)), 1 - ease.in(prog(time, outAt + outDur * 0.3, outAt + outDur))) }}>
                {w.text}
                <span className="cpv-wf" aria-hidden="true" style={{ maskPosition: `${(100 * (1 - fill)).toFixed(1)}% 0%`, opacity: lit }}>
                  {w.text}
                </span>
              </span>
            </span>{" "}
          </span>
        );
      })}
    </span>
  );
}

function Boxed({ words, start, end, time }: LookProps) {
  const n = words.length;
  const length = end - start;
  const t0 = start - 0.08;
  const open = clamp(length * 0.4, 0.22, 0.42);
  const outDur = clamp(length * 0.2, 0.12, 0.24);
  const leave = Math.max(t0 + open, end - outDur);
  const stagger = Math.min(0.035, (length * 0.25) / n);
  const refs = useRef<(HTMLSpanElement | null)[]>([]);
  const [boxes, setBoxes] = useState<{ left: number; top: number; width: number; height: number }[]>([]);
  const key = words.map((w) => w.text).join(" ");
  // The block takes each word's place and width, measured once the words are laid out in their face.
  useLayoutEffect(() => {
    const measure = () => setBoxes(refs.current.map((el) => (el ? { left: el.offsetLeft, top: el.offsetTop, width: el.offsetWidth, height: el.offsetHeight } : { left: 0, top: 0, width: 0, height: 0 })));
    measure();
    void document.fonts?.ready.then(measure);
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (refs.current[0]?.parentElement) ro?.observe(refs.current[0].parentElement);
    return () => ro?.disconnect();
  }, [key]);
  const active = words.reduce((k, w, j) => (time >= Math.max(w.start, t0 + 0.1) - 0.07 ? j : k), -1);
  const box = active >= 0 ? boxes[active] : undefined;
  const opened = ease.out(prog(time, t0, t0 + open));
  const gone = ease.in(prog(time, leave, end));
  const plate: CSSProperties = {
    clipPath: `inset(0% ${(50 * (1 - opened)).toFixed(2)}% 0% ${(50 * (1 - opened)).toFixed(2)}% round 0.36em)`,
    opacity: Math.min(ease.out(prog(time, t0, t0 + open * 0.4)), 1 - gone),
    translate: `0 ${(0.18 * gone).toFixed(3)}em`,
  };
  return (
    <span className="cpv-line" style={plate}>
      <span
        className="cpv-hl"
        aria-hidden="true"
        style={box ? { left: `calc(${box.left}px - 0.13em)`, top: `calc(${box.top}px - 0.02em)`, width: `calc(${box.width}px + 0.26em)`, height: `calc(${box.height}px + 0.04em)`, opacity: 1 } : { opacity: 0 }}
      />
      {words.map((w, j) => {
        const inAt = t0 + 0.06 + j * stagger;
        const p = ease.out(prog(time, inAt, inAt + 0.36));
        return (
          <span key={j}>
            <span className={cx("cpv-w", j === active && "cpv-on")} ref={(el) => void (refs.current[j] = el)}>
              <span className="cpv-wi" style={{ opacity: ease.out(prog(time, inAt, inAt + 0.22)), translate: `0 ${(0.4 * (1 - p)).toFixed(3)}em` }}>
                {w.text}
              </span>
            </span>{" "}
          </span>
        );
      })}
    </span>
  );
}

function Lyrics({ words, start, end, time }: LookProps) {
  const n = words.length;
  const lands = words.map((w) => Math.max(start, w.start) - 0.02);
  const lastLand = lands.at(-1) ?? start;
  const outDur = clamp(Math.min((end - start) * 0.18, end - lastLand - 0.14), 0.07, 0.22);
  const leave = Math.max(lastLand + 0.07, end - outDur);
  const gone = ease.in(prog(time, leave, leave + outDur));
  return (
    <span className="cpv-line">
      {words.map((w, j) => {
        const at = lands[j] as number;
        const next = j + 1 < n ? (lands[j + 1] as number) : leave;
        const cool = Math.max(at + 0.12, Math.min(next, leave));
        const settle = ease.out(prog(time, at, at + 0.42));
        const sharp = ease.out(prog(time, at, at + 0.2));
        const lit = 1 - ease.inOut(prog(time, cool, cool + 0.18));
        return (
          <span key={j}>
            <span className="cpv-w">
              <span
                className="cpv-wi"
                style={{
                  opacity: Math.min(ease.out(prog(time, at, at + 0.06)), 1 - gone),
                  scale: (1.22 - 0.22 * settle).toFixed(3),
                  filter: `blur(${(0.07 * (1 - sharp) + 0.06 * gone).toFixed(3)}em)`,
                  translate: `0 ${(-0.14 * gone).toFixed(3)}em`,
                  color: `color-mix(in srgb, var(--cpv-accent) ${(lit * 100).toFixed(1)}%, var(--cpv-text))`,
                }}
              >
                {w.text}
              </span>
            </span>{" "}
          </span>
        );
      })}
    </span>
  );
}

/** The caption's words with times: its own, or spread over the caption by length (as the export does). */
function timedWords(caption: Caption): Word[] {
  if (caption.words?.length) return caption.words;
  const texts = caption.text.split(/\s+/).filter(Boolean);
  const total = texts.reduce((n, t) => n + t.length + 1, 0);
  const length = Math.max(0.1, caption.end - caption.start);
  let at = caption.start;
  return texts.map((text) => {
    const share = ((text.length + 1) / total) * length;
    const word = { start: at, end: at + share * 0.9, text };
    at += share;
    return word;
  });
}

function prog(time: number, a: number, b: number): number {
  return b <= a ? (time >= b ? 1 : 0) : clamp((time - a) / (b - a), 0, 1);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** Close matches for the export's easing curves. */
const ease = {
  out: (x: number) => 1 - Math.pow(1 - x, 4),
  in: (x: number) => x * x * x,
  inOut: (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  sine: (x: number) => (1 - Math.cos(Math.PI * x)) / 2,
};
