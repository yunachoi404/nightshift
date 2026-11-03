import type { PosterWidth } from "@nightshift/contract";
import { useEffect, useRef, useState } from "react";
import { drawFrame, parseMockUrl, stillDataUrl } from "./placeholder";
import { samplePoster } from "@/api/mock/samples";
import { cx } from "@/ui/primitives";

interface MediaProps {
  src: string;
  kind: "image" | "video";
  /** Plays when true. Mock video animates on a canvas. */
  playing?: boolean;
  loop?: boolean;
  muted?: boolean;
  durationSec?: number;
  /** Seek position for mock video, in seconds; used by the editor preview. */
  time?: number;
  className?: string;
  alt?: string;
  fit?: "cover" | "contain";
  onEnded?: () => void;
  onTime?: (t: number) => void;
  /** A picture a real video shows until its first frame decodes, so switching to it never flashes black. */
  poster?: string;
  /**
   * Shown small: the engine's poster at this width (tens of KB) stands in for the file (a still is about 0.7 MB, a final
   * several MB). A video shows its poster until it first plays, and loads only then. A video resting on a later frame
   * (`time`) loads as before, since its poster is its first frame.
   */
  thumb?: PosterWidth;
}

/**
 * Shows an asset. Real engine assets are plain `<img>` or `<video>`. Mock assets (`mock:` URLs) render
 * procedurally so the whole UI works without any media files.
 */
export function Media({ src, kind, playing = false, loop = true, muted = true, durationSec, time, className, alt = "", fit = "cover", onEnded, onTime, poster, thumb }: MediaProps) {
  const spec = parseMockUrl(src);
  if (spec) {
    return <MockCanvas spec={spec} animate={kind === "video"} playing={playing} loop={loop} durationSec={durationSec ?? 4} time={time} className={className} fit={fit} onEnded={onEnded} onTime={onTime} />;
  }
  if (kind === "image") return <img src={thumb ? posterOf(src, thumb) : src} alt={alt} className={cx("media", className)} style={{ objectFit: fit }} draggable={false} />;
  if (thumb && time === undefined) return <LazyVideo src={src} poster={posterOf(src, thumb)} alt={alt} playing={playing} loop={loop} muted={muted} className={className} fit={fit} onEnded={onEnded} onTime={onTime} />;
  return <RealVideo src={src} playing={playing} loop={loop} muted={muted} time={time} className={className} fit={fit} onEnded={onEnded} onTime={onTime} poster={poster} />;
}

/**
 * The engine's poster of an asset at `width`: the asset's URL with `?w=` (see POSTER_WIDTHS in the contract). A sample
 * file of the browser demo has its poster beside it instead.
 */
export function posterOf(assetUrl: string, width: PosterWidth): string {
  if (parseMockUrl(assetUrl)) return assetUrl;
  const sample = samplePoster(assetUrl);
  if (sample) return sample;
  return `${assetUrl}${assetUrl.includes("?") ? "&" : "?"}w=${width}`;
}

/**
 * A video that loads only once it plays: until then its poster stands in, as a plain picture. Once played it stays, so
 * playing it again does not load it again. A poster that does not load gives way to the video.
 */
function LazyVideo({ src, poster, alt, playing, className, fit, ...video }: { src: string; poster: string; alt: string; playing: boolean; loop: boolean; muted: boolean; className?: string; fit: "cover" | "contain"; onEnded?: () => void; onTime?: (t: number) => void }) {
  const [played, setPlayed] = useState(playing);
  const [posterFailed, setPosterFailed] = useState(false);
  useEffect(() => {
    if (playing) setPlayed(true);
  }, [playing]);
  if (!played && !playing && !posterFailed) return <img src={poster} alt={alt} className={cx("media", className)} style={{ objectFit: fit }} draggable={false} onError={() => setPosterFailed(true)} />;
  return <RealVideo src={src} playing={playing} className={className} fit={fit} poster={posterFailed ? undefined : poster} {...video} />;
}

/** How many times a video that fails to load or decode is loaded again before the frame says so, and the waits between. */
const VIDEO_RETRY_MS = [800, 2000, 5000];

/** The browser's media error in plain words, for the console and the fallback. */
export function describeMediaError(error: { code: number; message?: string } | null | undefined): string {
  if (!error) return "The video did not load.";
  const why = error.code === 1 ? "Loading was stopped" : error.code === 2 ? "The connection to the engine dropped" : error.code === 3 ? "This video could not be decoded" : "This video format is not supported here";
  return error.message ? `${why} (${error.message}).` : `${why}.`;
}

/**
 * A real `<video>` that heals itself: when the element fails (the engine restarted under an open stream, a decoder
 * hiccup, a file still settling) it loads the same source again a few times before giving up. A video that still
 * fails is not left as a black box: the frame says so and keeps the file reachable through the surrounding controls.
 */
function RealVideo({ src, playing, loop, muted, time, className, fit, onEnded, onTime, poster }: { src: string; playing: boolean; loop: boolean; muted: boolean; time?: number; className?: string; fit: "cover" | "contain"; onEnded?: () => void; onTime?: (t: number) => void; poster?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const attempts = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playingRef = useRef(playing);
  playingRef.current = playing;

  // A new source starts over: no failure shown, no retries pending.
  useEffect(() => {
    attempts.current = 0;
    setFailed(null);
    return () => {
      if (retry.current) clearTimeout(retry.current);
      retry.current = null;
    };
  }, [src]);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (playing) void v.play().catch(() => undefined);
    else v.pause();
  }, [playing, failed]);
  useEffect(() => {
    const v = ref.current;
    if (v && time !== undefined && Math.abs(v.currentTime - time) > 0.25) v.currentTime = time;
  }, [time]);

  const onError = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget;
    const wait = VIDEO_RETRY_MS[attempts.current];
    const reason = describeMediaError(v.error);
    if (wait === undefined) {
      console.error(`Video gave up after ${attempts.current} retries: ${reason} ${src}`);
      setFailed(reason);
      return;
    }
    attempts.current += 1;
    console.warn(`Video failed (${reason}), loading again in ${wait} ms: ${src}`);
    retry.current = setTimeout(() => {
      retry.current = null;
      const was = v.currentTime;
      v.load();
      if (Number.isFinite(was) && was > 0) v.currentTime = was;
      if (playingRef.current) void v.play().catch(() => undefined);
    }, wait);
  };

  return (
    <>
      <video
        ref={ref}
        src={src}
        poster={poster}
        loop={loop}
        muted={muted}
        playsInline
        className={cx("media", className)}
        style={{ objectFit: fit }}
        onEnded={onEnded}
        onTimeUpdate={(e) => onTime?.(e.currentTarget.currentTime)}
        onError={onError}
        onLoadedData={() => {
          // A source that loads after a retry is healthy again.
          attempts.current = 0;
          setFailed(null);
        }}
      />
      {failed && (
        <div className="media__failed" role="status" title={failed}>
          <span className="media__failed-title">Preview unavailable</span>
          <span className="media__failed-text">{failed}</span>
        </div>
      )}
    </>
  );
}

function MockCanvas({ spec, animate, playing, loop, durationSec, time, className, fit, onEnded, onTime }: { spec: NonNullable<ReturnType<typeof parseMockUrl>>; animate: boolean; playing: boolean; loop: boolean; durationSec: number; time?: number; className?: string; fit: "cover" | "contain"; onEnded?: () => void; onTime?: (t: number) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const tRef = useRef(time ?? 0);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  // Track the element's rendered size so the canvas stays crisp.
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.max(2, Math.round(r.width * dpr));
      const h = Math.max(2, Math.round(r.height * dpr));
      setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }));
    });
    ro.observe(c);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (time !== undefined) tRef.current = time;
  }, [time]);

  useEffect(() => {
    const c = ref.current;
    if (!c || !size) return;
    c.width = size.w;
    c.height = size.h;
    // Keep the scene's aspect: contain or cover inside the element box.
    const draw = () => drawFrame(c, spec, tRef.current, durationSec, animate);
    if (!animate || !playing) {
      draw();
      return;
    }
    let raf = 0;
    let last = performance.now();
    const loopFn = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      tRef.current += dt;
      if (tRef.current >= durationSec) {
        if (loop) tRef.current = tRef.current % durationSec;
        else {
          tRef.current = durationSec;
          draw();
          onEnded?.();
          return;
        }
      }
      onTime?.(tRef.current);
      draw();
      raf = requestAnimationFrame(loopFn);
    };
    raf = requestAnimationFrame(loopFn);
    return () => cancelAnimationFrame(raf);
  }, [spec.kind, spec.seed, spec.w, spec.h, spec.quality, spec.palette, spec.move, size, animate, playing, loop, durationSec, time]); // eslint-disable-line react-hooks/exhaustive-deps

  return <canvas ref={ref} className={cx("media", "media--canvas", className)} style={{ objectFit: fit }} aria-label={animate ? "Video preview" : "Still"} />;
}

/** A tiny poster image URL for places that need an `<img>` (drag previews, favicons). */
export function posterUrl(src: string): string | null {
  const spec = parseMockUrl(src);
  return spec ? stillDataUrl(spec, 320) : src;
}
