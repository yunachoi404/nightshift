import { useEffect, useRef } from "react";
import { Media } from "@/media/Media";
import { parseMockUrl } from "@/media/placeholder";

/** Sample a clip with one decoder, instead of keeping a video element for every thumbnail. */
export function Filmstrip({ src, kind, start, duration, count, ratio }: {
  src: string; kind: "image" | "video"; start: number; duration: number; count: number; ratio: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const target = canvas.current;
    if (!target || parseMockUrl(src)) return;
    const context = target.getContext("2d");
    if (!context) return;
    const abort = new AbortController();
    const height = 128;
    const width = Math.round(height * ratio);
    target.width = width * count;
    target.height = height;
    const draw = (source: CanvasImageSource, sourceWidth: number, sourceHeight: number, index: number) => {
      const scale = Math.max(width / sourceWidth, height / sourceHeight);
      const sw = width / scale, sh = height / scale;
      context.drawImage(source, (sourceWidth - sw) / 2, (sourceHeight - sh) / 2, sw, sh, index * width, 0, width, height);
    };
    const ready = (element: HTMLElement, event: string) => new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        element.removeEventListener(event, done);
        element.removeEventListener("error", failed);
        abort.signal.removeEventListener("abort", failed);
      };
      const done = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error("Thumbnail unavailable")); };
      element.addEventListener(event, done, { once: true });
      element.addEventListener("error", failed, { once: true });
      abort.signal.addEventListener("abort", failed, { once: true });
    });
    const video = kind === "video" ? document.createElement("video") : null;
    void (async () => {
      if (!video) {
        const image = new Image();
        const loaded = ready(image, "load");
        image.src = src;
        await loaded;
        for (let n = 0; n < count; n++) draw(image, image.naturalWidth, image.naturalHeight, n);
        return;
      }
      video.muted = true;
      video.preload = "auto";
      const loaded = ready(video, "loadeddata");
      video.src = src;
      await loaded;
      for (let n = 0; n < count && !abort.signal.aborted; n++) {
        const time = Math.max(0, Math.min(start + duration * n / count, video.duration - 0.05));
        if (Math.abs(video.currentTime - time) > 0.001) {
          const sought = ready(video, "seeked");
          video.currentTime = time;
          await sought;
        }
        draw(video, video.videoWidth, video.videoHeight, n);
      }
    })().catch(() => { /* An unmounted or unavailable clip leaves its media background. */ }).finally(() => {
      if (video) { video.removeAttribute("src"); video.load(); }
    });
    return () => {
      abort.abort();
      if (video) { video.removeAttribute("src"); video.load(); }
    };
  }, [src, kind, start, duration, count, ratio]);
  if (parseMockUrl(src)) return <span className="tl__filmstrip" style={{ display: "flex" }} aria-hidden="true">
    {Array.from({ length: count }, (_, n) => <span key={n} style={{ height: "100%", aspectRatio: ratio, flex: "none" }}>
      <Media src={src} kind={kind} playing={false} time={start + duration * n / count} />
    </span>)}
  </span>;
  return <canvas ref={canvas} className="tl__filmstrip" aria-hidden="true" />;
}
