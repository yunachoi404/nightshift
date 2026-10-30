import { Check, Clapperboard, Download, Film, Image as ImageIcon, Moon, Move3d, Play, Plus, RectangleHorizontal, RectangleVertical, RotateCcw, SkipBack, Sparkles, Square, Sun, Video, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "@/ui/primitives";
import "./welcome-tour.css";
import { publicUrl } from "@/lib/publicUrl";

/**
 * The welcome's app window: one real project, Northern Lights, walked through the app's two areas. Media first: the
 * shots as cards on one board, then shot 4's card opened over it, where a second take becomes the pick. Then the
 * Editor. Every picture is a real render from that project (see public/welcome/README.md); every label is one the app
 * uses. It plays on its own, pauses under the pointer, jumps when an area is clicked, and holds still on the open card
 * when motion is reduced.
 */

const stages = ["media", "card", "editor"] as const;
type TourStage = (typeof stages)[number];
/** The toolbar's two areas. The card opens over the board, so it is part of Media. */
const areas = ["media", "editor"] as const;
type Area = (typeof areas)[number];
const areaLabel: Record<Area, string> = { media: "Media", editor: "Editor" };
const areaOf = (s: TourStage): Area => (s === "editor" ? "editor" : "media");
/** The tape on the window, relabeled at each stage the way a camera assistant would. It says what is on screen. */
function tapeNote(stage: TourStage, picked: boolean): string {
  if (stage === "media") return "Northern Lights, one board";
  if (stage === "card") return picked ? "shot 4, take 2 picked" : "shot 4, two versions";
  return "30 s, ready to export";
}
const STAGE_MS = 3800;
const PICK_MS = 1400;
/** A stage fades out completely before the next one fades in, so two areas never share a frame. */
const FADE_OUT_MS = 180;

/** The project's shots as written: the first sentence of each prompt. A card is labeled with it. */
const shots = [
  "Wide symmetrical opening from the frozen lake surface, looking straight toward the snowy far shore.",
  "Almost motionless view through snow-heavy spruce boughs at the extreme left edge, opening onto the same remote frozen northern lake at midnight.",
  "Close landscape detail of polished black lake ice, fine white trapped frost lines, and reflected emerald and violet ribbons.",
  "Medium close view from the frozen lake of the same small dark wooden cabin at midnight.",
  "Low wide angle close to the snow-covered near shore.",
  "Locked-off upward view of the green and violet aurora above the same frozen northern lake at midnight.",
  "Closing wide view from farther back along the same frozen shore, tall spruce tree in silhouette at left, broad mirror of black ice below a graceful green aurora arch edged in violet.",
];
const still = (n: number) => publicUrl(`welcome/still-${n}.jpg`);
const take = (n: number, ext: "jpg" | "mp4") => publicUrl(`welcome/take-${n}.${ext}`);
/** The shot whose card opens: its two takes are the project's real drafts, the second one picked and finished. */
const OPENED = 4;

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
  // `at` is the stage the tour is on; `shown` is the one on screen, which follows once the last has faded.
  const [at, setAt] = useState<TourStage>(reduced ? "card" : "media");
  const [shown, setShown] = useState<TourStage>(at);
  const [leaving, setLeaving] = useState(false);
  const [held, setHeld] = useState(false);
  // A click restarts the clock on the stage it chose.
  const [jumps, setJumps] = useState(0);
  const [picked, setPicked] = useState(reduced);

  useEffect(() => {
    if (reduced) setAt("card");
  }, [reduced]);

  // Between areas the old one fades out first. Within Media the board stays put and only the card opens or closes.
  useEffect(() => {
    if (at === shown) return setLeaving(false);
    if (reduced || areaOf(at) === areaOf(shown)) return setShown(at);
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

  // On the board, shot 4's first take is its pick, as the app picks it. A beat after its card opens, the second is.
  useEffect(() => {
    if (reduced) return setPicked(true);
    if (shown === "editor") return;
    setPicked(false);
    if (shown !== "card") return;
    const t = window.setTimeout(() => setPicked(true), PICK_MS);
    return () => window.clearTimeout(t);
  }, [shown, reduced]);

  const on = (s: TourStage) => shown === s && !leaving;

  return (
    <div className="ob__window" onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)} onFocus={() => setHeld(true)} onBlur={() => setHeld(false)}>
      <div className="pw" role="group" aria-label="Nightshift, one project from media to edit">
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
            <AreaSwitch
              at={areaOf(at)}
              onPick={(a) => {
                setAt(a);
                setJumps((n) => n + 1);
              }}
            />
          </div>
          <div className="pw__stages" aria-hidden>
            <Stage on={on("media") || on("card")}>
              {/* The card stays open while the window fades to the Editor, so it leaves as it was. */}
              <MediaStage picked={picked} open={shown === "card"} playing={on("card") && !reduced} />
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

/** The toolbar's segmented control, with a knob that slides to the area on show. */
function AreaSwitch({ at, onPick }: { at: Area; onPick: (a: Area) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const place = () => {
      const b = el.querySelector<HTMLElement>(`[data-area="${at}"]`);
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
      {areas.map((a) => (
        <button key={a} type="button" role="radio" data-area={a} aria-checked={a === at} className={cx("pw__stage-btn", a === at && "pw__stage-btn--on")} onClick={() => onPick(a)}>
          {areaLabel[a]}
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

/** Media: the prompt panel that makes new cards, the board of shots, and the timeline strip under it. */
function MediaStage({ picked, open, playing }: { picked: boolean; open: boolean; playing: boolean }) {
  return (
    <div className="pw-md">
      <div className="pw-md__panel">
        <div className="pw-md__tools">
          <span className="pw-md__tool pw-md__tool--on">
            <ImageIcon />
            Image
          </span>
          <span className="pw-md__tool">
            <Video />
            Video
          </span>
          <span className="pw-md__tool">
            <Sparkles />
            Effect
          </span>
          <span className="pw-md__tool">
            <Move3d />
            Camera move
          </span>
        </div>
        <div className="pw-md__label">Prompt</div>
        <div className="pw-md__prompt">Snow falling past the cabin window, the aurora above</div>
        <div className="pw-md__go">
          <div className="pw-md__into">
            Into <b>Shots</b>
          </div>
          <span className="pw-btn pw-btn--ink pw-md__generate">
            <Sparkles />
            Generate
          </span>
        </div>
      </div>
      <div className="pw-md__main">
        <div className="pw-md__board">
          <div className="pw-md__head">
            <b>Shots</b>
            <span>{shots.length} cards</span>
            <span className="pw-btn pw-btn--quiet pw-btn--s pw-md__new">
              <Plus />
              New board
            </span>
          </div>
          <div className="pw-sb">
            {shots.map((prompt, i) => {
              const n = i + 1;
              // Shot 1's pick is its final; shot 4 has two takes, the one picked on show.
              const final = n === 1;
              const versions = n === 1 || n === OPENED ? 2 : 1;
              const pick = n === 1 ? publicUrl("welcome/window.jpg") : n === OPENED ? take(picked ? 2 : 1, "jpg") : still(n);
              return (
                <div key={n} className={cx("pw-shot", n === OPENED && "pw-shot--opened")} style={{ "--i": i } as React.CSSProperties}>
                  <div className="pw-frame">
                    <img src={pick} alt="" />
                    {final && <span className="tag tag--onmedia tag--night pw-frame__tag">Final</span>}
                    {versions > 1 && <span className="tag tag--onmedia pw-frame__tag pw-frame__tag--right">{versions} versions</span>}
                  </div>
                  <div className="pw-shot__meta">
                    <span className="pw-shot__label">{prompt}</span>
                    <span className="pw-shot__ontl">
                      <Film />
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="pw-md__strip">
          <Film />
          <b>On the timeline: {shots.length} shots, 0:30</b>
          <span className="tag">Music</span>
          <span className="pw-md__hint">Drag cards here to add them</span>
          <span className="pw-btn pw-btn--s">Open editor</span>
        </div>
      </div>
      <CardPopup open={open} picked={picked} playing={playing} />
    </div>
  );
}

/** Shot 4's card, opened over the board: its versions side by side, the pick marked, and the ways to go on. */
function CardPopup({ open, picked, playing }: { open: boolean; picked: boolean; playing: boolean }) {
  const chosen = picked ? 2 : 1;
  return (
    <div className={cx("pw-cd", open && "pw-cd--open")}>
      <div className="pw-cd__dlg">
        <div className="pw-cd__main">
          <div className="pw-cd__takes">
            {[1, 2].map((n) => (
              <div key={n} className="pw-take">
                <div className={cx("pw-frame", n === chosen && "pw-frame--picked")}>
                  <Clip src={take(n, "mp4")} poster={take(n, "jpg")} playing={playing} />
                  {n === chosen && (
                    <span className="tag tag--onmedia pw-frame__tag">
                      <Check />
                      Pick
                    </span>
                  )}
                </div>
                <div className="pw-take__meta">
                  <b>Take {n}</b>
                  <span className="pw-extra">Draft, 4 s</span>
                  {n === chosen ? (
                    <span className="pw-take__pick">The pick</span>
                  ) : (
                    <span className="pw-btn pw-btn--s">
                      <RotateCcw />
                      Restore
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="pw-cd__side">
          <div className="pw-cd__head">
            <div>
              <div className="pw-cd__title">{shots[OPENED - 1]}</div>
              <div className="pw-cd__sub">On the timeline, 4 s, 2 versions</div>
            </div>
            <X />
          </div>
          <div className="pw-cd__sec pw-extra">
            <div className="pw-cd__h">New version</div>
            <div className="pw-cd__row">
              <span className="pw-btn pw-btn--s">
                <Clapperboard />
                Another take
              </span>
              <span className="pw-btn pw-btn--s">
                <Sparkles />
                Effect
              </span>
              <span className="pw-btn pw-btn--s">
                <Move3d />
                Camera move
              </span>
            </div>
          </div>
          <div className="pw-cd__sec">
            <div className="pw-cd__h">Final</div>
            <p className="pw-cd__text">The take you picked at full quality. Same motion, same framing.</p>
            <div className="pw-cd__row">
              <span className="pw-btn pw-btn--s pw-btn--ink pw-extra">
                <Sun />
                Finish now
              </span>
              <span className="pw-btn pw-btn--s pw-btn--night">
                <Moon />
                Finish tonight
              </span>
            </div>
          </div>
        </div>
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
