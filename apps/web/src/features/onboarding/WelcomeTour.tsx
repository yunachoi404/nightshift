import { cameraMoves } from "@nightshift/contract";
import { Check, Clapperboard, Download, Moon, Play, Plus, RectangleHorizontal, RectangleVertical, RefreshCw, SkipBack, Square } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "@/ui/primitives";
import "./welcome-tour.css";
import { publicUrl } from "@/lib/publicUrl";

/**
 * The welcome's app window: one real project, Northern Lights, walked through the four stages in order. Every
 * picture is a real render from that project (see public/welcome/README.md); every label is one the app uses.
 * It plays on its own, pauses under the pointer, jumps when a stage is clicked, and holds still on Finals
 * when motion is reduced.
 */

const stages = ["storyboard", "takes", "finals", "editor"] as const;
type TourStage = (typeof stages)[number];
const stageLabel: Record<TourStage, string> = { storyboard: "Storyboard", takes: "Takes", finals: "Finals", editor: "Editor" };
/** The tape on the window, relabeled at each stage the way a camera assistant would. It says what is on screen. */
function tapeNote(stage: TourStage, picked: boolean): string {
  if (stage === "storyboard") return "Northern Lights, 7 shots";
  if (stage === "takes") return picked ? "shot 4, take 2 picked" : "shot 4, two takes";
  if (stage === "finals") return "shot 1, same take, final";
  return "30 s, ready to export";
}
const STAGE_MS = 3800;
const PICK_MS = 1400;
/** A stage fades out completely before the next one fades in, so two stages never share a frame. */
const FADE_OUT_MS = 180;

/** The project's shots as written: the first sentence of each prompt and its camera move. */
const shots = [
  { move: "dolly_in", prompt: "Wide symmetrical opening from the frozen lake surface, looking straight toward the snowy far shore." },
  { move: "static", prompt: "Almost motionless view through snow-heavy spruce boughs at the extreme left edge, opening onto the same remote frozen northern lake at midnight." },
  { move: "static", prompt: "Close landscape detail of polished black lake ice, fine white trapped frost lines, and reflected emerald and violet ribbons." },
  { move: "static", prompt: "Medium close view from the frozen lake of the same small dark wooden cabin at midnight." },
  { move: "pan_left", prompt: "Low wide angle close to the snow-covered near shore." },
  { move: "static", prompt: "Locked-off upward view of the green and violet aurora above the same frozen northern lake at midnight." },
  { move: "dolly_out", prompt: "Closing wide view from farther back along the same frozen shore, tall spruce tree in silhouette at left, broad mirror of black ice below a graceful green aurora arch edged in violet." },
];
const moveLabel = (id: string) => cameraMoves.find((c) => c.id === id)?.label ?? "Still camera";
const still = (n: number) => publicUrl(`welcome/still-${n}.jpg`);

/** The edit's cuts in seconds, shot by shot, as the project's timeline has them. */
const cuts: Array<[shot: number, start: number, length: number]> = [
  [1, 0, 3.73],
  [2, 3.73, 3.83],
  [3, 7.57, 2.87],
  [4, 10.44, 3.83],
  [5, 14.27, 3.83],
  [6, 18.09, 3.83],
  [7, 21.93, 3.83],
  [1, 25.75, 3.51],
  [2, 29.27, 0.73],
];
const EDIT_SEC = 30;
/** Peaks of the project's music track, 120 steps over its 30 seconds. */
const music = [38, 47, 65, 44, 56, 47, 36, 26, 21, 56, 47, 29, 31, 30, 43, 23, 39, 46, 27, 8, 56, 77, 65, 59, 46, 45, 31, 42, 27, 15, 73, 57, 49, 29, 30, 28, 12, 18, 10, 68, 45, 86, 78, 82, 69, 85, 78, 42, 24, 18, 72, 67, 64, 82, 75, 45, 29, 74, 24, 53, 28, 17, 83, 74, 100, 36, 93, 87, 29, 34, 22, 88, 63, 84, 78, 60, 28, 72, 20, 22, 28, 15, 87, 76, 92, 58, 81, 79, 33, 25, 28, 89, 58, 42, 85, 86, 44, 72, 32, 35, 39, 17, 22, 100, 68, 80, 82, 72, 80, 30, 22, 37, 79, 45, 45, 48, 35, 28, 79, 27];

const sideProjects = [
  { cover: "aurora", name: "Northern Lights", on: true },
  { cover: "ferry", name: "The Last Ferry" },
  { cover: "forest", name: "What if your coffee grew a forest?" },
  { cover: "gravity", name: "What if gravity stopped for ten seconds?" },
];

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

export function WelcomeTour() {
  const reduced = useReducedMotion();
  // `at` is the stage the switch points to; `shown` is the one on screen, which follows once the last has faded.
  const [at, setAt] = useState<TourStage>(reduced ? "finals" : "storyboard");
  const [shown, setShown] = useState<TourStage>(at);
  const [leaving, setLeaving] = useState(false);
  const [held, setHeld] = useState(false);
  // A click restarts the clock on the stage it chose.
  const [jumps, setJumps] = useState(0);
  const [picked, setPicked] = useState(reduced);

  useEffect(() => {
    if (reduced) setAt("finals");
  }, [reduced]);

  useEffect(() => {
    if (at === shown) return setLeaving(false);
    if (reduced) return setShown(at);
    setLeaving(true);
    const t = window.setTimeout(() => {
      setShown(at);
      setLeaving(false);
    }, FADE_OUT_MS);
    return () => window.clearTimeout(t);
  }, [at, shown, reduced]);

  useEffect(() => {
    if (reduced || held) return;
    const t = window.setTimeout(() => setAt((s) => stages[(stages.indexOf(s) + 1) % stages.length]!), STAGE_MS);
    return () => window.clearTimeout(t);
  }, [at, held, reduced, jumps]);

  // On Takes, the first take starts picked, as the app picks it; a beat later the second one is picked.
  useEffect(() => {
    if (shown !== "takes") return;
    if (reduced) return setPicked(true);
    setPicked(false);
    const t = window.setTimeout(() => setPicked(true), PICK_MS);
    return () => window.clearTimeout(t);
  }, [shown, reduced]);

  const on = (s: TourStage) => shown === s && !leaving;

  return (
    <div className="ob__window" onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)} onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}>
      <div className="pw" role="group" aria-label="Nightshift, one project from storyboard to edit">
        <div className="pw__side" aria-hidden>
          <div className="pw__lights">
            <i />
            <i />
            <i />
          </div>
          <div className="pw__head">Projects</div>
          {sideProjects.map((p) => (
            <div key={p.cover} className={cx("pw__item", p.on && "pw__item--on")}>
              <img src={publicUrl(`welcome/cover-${p.cover}.jpg`)} alt="" />
              <span>{p.name}</span>
            </div>
          ))}
        </div>
        <div className="pw__main">
          <div className="pw__bar">
            <div className="pw__title" aria-hidden>
              <b>Northern Lights</b>
              <small>Music video</small>
            </div>
            <StageSwitch
              at={at}
              onPick={(s) => {
                setAt(s);
                setJumps((n) => n + 1);
              }}
            />
          </div>
          <div className="pw__stages" aria-hidden>
            <Stage on={on("storyboard")}>
              <StoryboardStage />
            </Stage>
            <Stage on={on("takes")}>
              <TakesStage picked={picked} playing={on("takes") && !reduced} />
            </Stage>
            <Stage on={on("finals")}>
              <FinalsStage playing={on("finals") && !reduced} />
            </Stage>
            <Stage on={on("editor")}>
              <EditorStage playing={on("editor") && !reduced} />
            </Stage>
          </div>
        </div>
      </div>
      <span className={cx("ob__tape", leaving && "ob__tape--off")} key={tapeNote(shown, picked)} aria-hidden>
        {tapeNote(shown, picked)}
      </span>
    </div>
  );
}

/** The toolbar's segmented control, with a knob that slides to the stage on show. */
function StageSwitch({ at, onPick }: { at: TourStage; onPick: (s: TourStage) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const place = () => {
      const b = el.querySelector<HTMLElement>(`[data-stage="${at}"]`);
      if (b) setKnob({ x: b.offsetLeft, w: b.offsetWidth });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [at]);
  return (
    <div ref={track} className="pw__seg" role="radiogroup" aria-label="Stage">
      {knob && <span className="pw__knob" style={{ width: knob.w, transform: `translateX(${knob.x - 3}px)` }} aria-hidden />}
      {stages.map((s) => (
        <button key={s} type="button" role="radio" data-stage={s} aria-checked={s === at} className={cx("pw__stage-btn", s === at && "pw__stage-btn--on")} onClick={() => onPick(s)}>
          {stageLabel[s]}
        </button>
      ))}
    </div>
  );
}

function Stage({ on, children }: { on: boolean; children: ReactNode }) {
  return <div className={cx("pw__stage", on && "pw__stage--on")}>{children}</div>;
}

/** A clip that plays only while its stage is on screen. */
function Clip({ src, poster, playing }: { src: string; poster: string; playing: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (playing) void v.play().catch(() => undefined);
    else v.pause();
  }, [playing]);
  return <video ref={ref} src={src} poster={poster} muted loop playsInline preload={playing ? "auto" : "metadata"} />;
}

function StoryboardStage() {
  return (
    <div className="pw-page">
      <div className="pw-head">
        <div>
          <div className="pw-h">Storyboard</div>
          <p className="pw-sub">7 shots, 28 s. Edit the words, drag to reorder, lock what you like.</p>
        </div>
        <div className="pw-actions">
          <span className="pw-btn pw-btn--quiet pw-btn--extra">
            <RefreshCw />
            Rewrite shot list
          </span>
          <span className="pw-btn pw-btn--quiet pw-btn--extra">
            <Plus />
            Add shot
          </span>
          <span className="pw-btn pw-btn--ink">
            <Clapperboard />
            Make drafts
          </span>
        </div>
      </div>
      <div className="pw-sb">
        {shots.slice(0, 6).map((s, i) => (
          <div key={i} className="pw-shot" style={{ "--i": i } as React.CSSProperties}>
            <div className="pw-frame">
              <img src={still(i + 1)} alt="" />
            </div>
            <div className="pw-shot__meta">
              <b>Shot {i + 1}</b>
              <span>4 s</span>
              <span className="pw-shot__move">{moveLabel(s.move)}</span>
            </div>
            <p className="pw-shot__prompt">{s.prompt}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function TakesStage({ picked, playing }: { picked: boolean; playing: boolean }) {
  const takes = [1, 2];
  const chosen = picked ? 2 : 1;
  return (
    <div className="pw-tk">
      <div className="pw-tk__rail">
        <div className="pw__head">Shots</div>
        {[1, 2, 3, 4, 5, 6].map((n) => (
          <div key={n} className={cx("pw-tk__item", n === 4 && "pw-tk__item--on")}>
            <img src={still(n)} alt="" />
            <span>
              <b>Shot {n}</b>
              <small>Take {n === 4 ? chosen : 1} picked</small>
            </span>
            <Check />
          </div>
        ))}
      </div>
      <div className="pw-page pw-tk__main">
        <div className="pw-head">
          <div>
            <div className="pw-h">Shot 4</div>
            <p className="pw-sub">{shots[3]!.prompt}</p>
          </div>
          <div className="pw-actions">
            <span className="pw-btn pw-btn--extra">Compare</span>
            <span className="pw-btn">
              <Plus />
              Another take
            </span>
          </div>
        </div>
        <div className="pw-tk__takes">
          {takes.map((n) => (
            <div key={n} className="pw-take">
              <div className={cx("pw-frame", n === chosen && "pw-frame--picked")}>
                <Clip src={publicUrl(`welcome/take-${n}.mp4`)} poster={publicUrl(`welcome/take-${n}.jpg`)} playing={playing} />
                <span className="tag tag--onmedia pw-frame__tag">Draft</span>
              </div>
              <div className="pw-take__meta">
                <b>Take {n}</b>
                <span>4 s</span>
                <span className={cx("pw-btn pw-btn--s", n === chosen && "pw-btn--ink")}>
                  {n === chosen && <Check />}
                  {n === chosen ? "Picked" : "Pick"}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function FinalsStage({ playing }: { playing: boolean }) {
  return (
    <div className="pw-fn">
      <div className="pw__viewer">
        <Clip src={publicUrl("welcome/window.mp4")} poster={publicUrl("welcome/window.jpg")} playing={playing} />
        <span className="tag tag--onmedia tag--night pw__tag">Final, same take</span>
      </div>
      <div className="pw__insp">
        <div className="pw__insp-title">
          <Moon />
          Tonight
        </div>
        <div className="pw__kv">
          <span>Queued</span>
          <b>3 finals</b>
        </div>
        <div className="pw__kv">
          <span>Starts</span>
          <b>11 pm</b>
        </div>
        <div className="pw__kv">
          <span>Done by</span>
          <b>about 2:40 am</b>
        </div>
        <span className="pw__night">Finish overnight</span>
      </div>
    </div>
  );
}

function EditorStage({ playing }: { playing: boolean }) {
  const pct = (s: number) => `${(s / EDIT_SEC) * 100}%`;
  // The playhead runs while the stage is on, and the timecode with it.
  const [t, setT] = useState(0);
  useEffect(() => {
    setT(0);
    if (!playing) return;
    const start = performance.now();
    const id = window.setInterval(() => setT(Math.min(STAGE_MS, performance.now() - start) / 1000), 100);
    return () => window.clearInterval(id);
  }, [playing]);
  return (
    <div className="pw-ed">
      <div className="pw-ed__top">
        <div className="pw-ed__viewer">
          <div className="pw-ed__picture">
            <Clip src={publicUrl("welcome/window.mp4")} poster={publicUrl("welcome/window.jpg")} playing={playing} />
          </div>
        </div>
        <div className="pw-ed__insp">
          <div className="pw-ed__row">
            <b>Captions</b>
            <span className="pw-switch" />
          </div>
          <div className="pw-ed__row">
            <b>Export</b>
            <span className="pw-ed__seg">
              <span className="pw-ed__seg-on">
                <RectangleHorizontal />
                16:9
              </span>
              <span>
                <RectangleVertical />
                9:16
              </span>
              <span>
                <Square />
                1:1
              </span>
            </span>
          </div>
          <span className="pw-btn pw-btn--ink pw-ed__export">
            <Download />
            Export video
          </span>
        </div>
      </div>
      <div className="pw-ed__transport">
        <SkipBack />
        <Play />
        <span className="pw-ed__time">
          0:{t.toFixed(1).padStart(4, "0")} <span>/ 0:30.0</span>
        </span>
        <span className="tag tag--night">Final</span>
      </div>
      <div className="pw-tl">
        <div className="pw-tl__labels">
          <span>Shots</span>
          <span>Music</span>
          <span>Voice</span>
          <span>Captions</span>
        </div>
        <div className={cx("pw-tl__lanes", playing && "pw-tl__lanes--playing")}>
          <div className="pw-tl__lane pw-tl__lane--shots">
            {cuts.map(([n, start, len], i) => (
              <div key={i} className="pw-tl__clip" style={{ left: pct(start), width: pct(len) }}>
                <img src={still(n)} alt="" />
                <span>{n}</span>
              </div>
            ))}
          </div>
          <div className="pw-tl__lane pw-tl__lane--music">
            <svg viewBox={`0 0 ${music.length} 100`} preserveAspectRatio="none" aria-hidden>
              {music.map((v, i) => (
                <rect key={i} x={i + 0.15} width={0.7} y={50 - v * 0.42} height={Math.max(4, v * 0.84)} rx={0.35} />
              ))}
            </svg>
          </div>
          <div className="pw-tl__lane">
            <span className="pw-tl__empty">No voice yet</span>
          </div>
          <div className="pw-tl__lane">
            <span className="pw-tl__empty">Captions follow the voice</span>
          </div>
          <span className="pw-tl__head" style={{ left: `calc(10px + (100% - 24px) * ${t / EDIT_SEC})` }} />
        </div>
      </div>
    </div>
  );
}
