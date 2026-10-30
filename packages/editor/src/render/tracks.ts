/**
 * Keyframe tracks for the composition. Every animated property of every element is one track over the whole
 * timeline, so tracks never fight each other (two WAAPI animations with `fill: both` on the same property would).
 * The page turns each track into one paused Web Animation; HyperFrames seeks them frame by frame.
 */

export const EASE = {
  linear: "linear",
  out: "cubic-bezier(0.22, 0.61, 0.36, 1)",
  outStrong: "cubic-bezier(0.16, 1, 0.3, 1)",
  inOut: "cubic-bezier(0.65, 0, 0.35, 1)",
  in: "cubic-bezier(0.55, 0, 1, 0.45)",
  outBack: "cubic-bezier(0.34, 1.56, 0.64, 1)",
  /** Slow start, hard finish: things leaving. */
  inStrong: "cubic-bezier(0.7, 0, 0.84, 0)",
  /** Even and gentle at both ends: a fill sweeping across a word. */
  sine: "cubic-bezier(0.37, 0, 0.63, 1)",
  step: "step-end",
} as const;

/**
 * A measured length for a keyframe value: the element's layout box (left, top, width or height, in px, relative to
 * its offset parent). The page fills it in once the fonts are in, so a highlight can move from word to word.
 */
export function measure(id: string, side: "x" | "y" | "w" | "h"): string {
  return `{${side}:${id}}`;
}

/** [time in seconds, CSS value, easing towards the next keyframe]. */
export type Keyframe = [number, string | number, string?];

/** A looping animation (film grain): keyframes evenly spaced over `periodSec`, repeating forever. */
export interface Loop {
  id: string;
  prop: string;
  values: string[];
  periodSec: number;
}

export class Tracks {
  private readonly tracks = new Map<string, { id: string; prop: string; kf: Keyframe[] }>();
  readonly loops: Loop[] = [];

  add(id: string, prop: string, t: number, value: string | number, easing?: string): this {
    const key = `${id}\u0000${prop}`;
    let track = this.tracks.get(key);
    if (!track) {
      track = { id, prop, kf: [] };
      this.tracks.set(key, track);
    }
    track.kf.push([Math.max(0, t), value, easing]);
    return this;
  }

  /** Fades an element in over [start, start+fadeIn] and out over [end-fadeOut, end]; hidden outside. */
  window(id: string, start: number, end: number, fadeIn: number, fadeOut: number, easing: string = EASE.inOut): this {
    const length = Math.max(0, end - start);
    const scale = fadeIn + fadeOut > length && fadeIn + fadeOut > 0 ? length / (fadeIn + fadeOut) : 1;
    const a = fadeIn * scale;
    const b = fadeOut * scale;
    this.add(id, "opacity", start, 0, easing);
    this.add(id, "opacity", start + a, 1);
    this.add(id, "opacity", end - b, 1, easing);
    this.add(id, "opacity", end, 0);
    return this;
  }

  has(id: string, prop: string): boolean {
    return this.tracks.has(`${id}\u0000${prop}`);
  }

  /** Tracks as compact JSON for the page: [id, prop, [[ms, value, easing?], ...]]. Keyframes sorted by time. */
  toJSON(): [string, string, [number, string | number, string?][]][] {
    return [...this.tracks.values()].map(({ id, prop, kf }) => {
      const sorted = kf
        .map((k, order) => ({ k, order }))
        .sort((x, y) => x.k[0] - y.k[0] || x.order - y.order)
        .map(({ k }) => {
          const ms = Math.round(k[0] * 1000 * 10) / 10;
          return (k[2] ? [ms, k[1], k[2]] : [ms, k[1]]) as [number, string | number, string?];
        });
      return [id, prop, sorted];
    });
  }
}

/**
 * The in-page animator. Plain ES5 so it runs in any Chrome. Each track becomes one animation over the whole
 * composition with fill both, created paused at 0 so HyperFrames' WAAPI adapter maps composition time 1:1.
 * Values with measured lengths ({x:id} and so on) are filled in from the layout, and again once every font has
 * loaded; until then HyperFrames is told the timelines are still building, so no frame is taken early.
 */
export const PAGE_ANIMATOR = `(function () {
  var data = window.__NIGHTSHIFT__;
  var total = data.durationMs;
  var MEASURE = /\\{([xywh]):([A-Za-z0-9_-]+)\\}/g;
  var measured = [];
  function prop(name) { return name.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); }); }
  function make(el, frames, options) {
    var anim = el.animate(frames, options);
    anim.pause();
    anim.currentTime = 0;
    return anim;
  }
  function value(v) {
    if (typeof v !== "string" || v.indexOf("{") < 0) return v;
    return v.replace(MEASURE, function (_, side, id) {
      var el = document.getElementById(id);
      if (!el) return "0";
      return String(side === "x" ? el.offsetLeft : side === "y" ? el.offsetTop : side === "w" ? el.offsetWidth : el.offsetHeight);
    });
  }
  function framesOf(key, kf) {
    var frames = [];
    if (kf[0][0] > 0) { var f0 = { offset: 0, easing: "linear" }; f0[key] = value(kf[0][1]); frames.push(f0); }
    for (var j = 0; j < kf.length; j++) {
      var f = { offset: Math.min(1, Math.max(0, kf[j][0] / total)), easing: kf[j][2] || "linear" };
      f[key] = value(kf[j][1]);
      frames.push(f);
    }
    var last = kf[kf.length - 1];
    if (last[0] < total) { var fl = { offset: 1 }; fl[key] = value(last[1]); frames.push(fl); }
    return frames;
  }
  for (var i = 0; i < data.tracks.length; i++) {
    var track = data.tracks[i];
    var el = document.getElementById(track[0]);
    if (!el) continue;
    var key = prop(track[1]);
    var anim = make(el, framesOf(key, track[2]), { duration: total, fill: "both" });
    if (JSON.stringify(track[2]).indexOf("{") >= 0) measured.push({ anim: anim, key: key, kf: track[2] });
  }
  if (measured.length && document.fonts) {
    window.__hfTimelinesBuilding = true;
    var done = function () {
      for (var m = 0; m < measured.length; m++) measured[m].anim.effect.setKeyframes(framesOf(measured[m].key, measured[m].kf));
      window.__hfTimelinesBuilding = false;
      window.dispatchEvent(new Event("hf-timelines-built"));
    };
    var loads = [];
    document.fonts.forEach(function (face) { loads.push(face.load().catch(function () {})); });
    Promise.all(loads).then(function () { return document.fonts.ready; }).then(done, done);
  }
  for (var l = 0; l < data.loops.length; l++) {
    var loop = data.loops[l];
    var target = document.getElementById(loop.id);
    if (!target) continue;
    var lk = prop(loop.prop);
    var lf = [];
    for (var v = 0; v < loop.values.length; v++) { var g = { offset: v / loop.values.length, easing: "step-end" }; g[lk] = loop.values[v]; lf.push(g); }
    var end = { offset: 1 }; end[lk] = loop.values[0]; lf.push(end);
    make(target, lf, { duration: loop.periodSec * 1000, iterations: Infinity });
  }
})();`;
