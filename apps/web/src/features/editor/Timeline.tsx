/**
 * The editor's timeline: Shots, Music, Voice and Captions lanes under a ruler. Cards dragged from the media sidebar
 * (or Media) drop onto the Shots lane where the pointer is; clips drag to reorder and come off with their x or Delete.
 * Songs and voiceovers are made on their own lanes, in a small popover, and their progress and failures show there.
 */
import type { Job, Project, Timeline } from "@nightshift/contract";
import { voices } from "@nightshift/contract";
import { AlertCircle, Plus, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isCanvasDrag, readDrag, setDrag, soundOnTimeline } from "@/features/media/items";
import { assetById, failureText, isActive, jobStatusLine } from "@/features/project/helpers";
import { roughDuration, timecode } from "@/lib/format";
import { useNow } from "@/lib/useNow";
import { useEngine } from "@/store/engine";
import { useInstalledTier } from "@/store/tier";
import { Bar, Button, Notice, Select, Textarea, cx, toast, usePanelFocus } from "@/ui/primitives";
import type { CutEdits } from "./edits";
import { Filmstrip } from "./Filmstrip";

export interface Clip {
  shotId: string;
  assetId: string;
  src: string;
  kind: "image" | "video";
  rung: "still" | "draft" | "final";
  in: number;
  start: number;
  dur: number;
  move: string;
  /** What the card is called in Media. */
  label: string;
}

type Role = "music" | "voice";
type DropLane = "shots" | Role;

export function TimelineView({ project, clips, total, time, onSeek, current, timeline, jobs, edits, voiceText }: {
  project: Project;
  clips: Clip[];
  total: number;
  time: number;
  onSeek: (t: number) => void;
  current: Clip | undefined;
  timeline: Timeline;
  jobs: Job[];
  edits: CutEdits;
  /** What the voiceover says until it is edited. */
  voiceText: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pxPerSec = Math.max(28, (width - 24) / Math.max(total, 1));
  const innerW = Math.max(width, total * pxPerSec + 24);
  const x = (t: number) => 12 + t * pxPerSec;
  const ticks: number[] = [];
  const stepSec = total > 40 ? 5 : total > 15 ? 2 : 1;
  for (let t = 0; t <= total; t += stepSec) ticks.push(t);
  // The last label aligns leftward at the edge. Leave it room beside the previous label.
  if (ticks.length > 2 && x(ticks.at(-1)!) > innerW - 40 && (ticks.at(-1)! - ticks.at(-2)!) * pxPerSec < 64) ticks.splice(-2, 1);

  const timeAt = (clientX: number) => {
    const el = scrollRef.current!;
    return (clientX - el.getBoundingClientRect().left + el.scrollLeft - 12) / pxPerSec;
  };
  const seekFromEvent = (e: React.MouseEvent) => onSeek(Math.max(0, Math.min(total, timeAt(e.clientX))));

  // ------------------------------------------------------------ drag and drop
  const [drop, setDrop] = useState<{ lane: DropLane; index: number } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  // A drag that ends anywhere (dropped elsewhere, cancelled) clears the marker.
  useEffect(() => {
    const clear = () => {
      setDrop(null);
      setDragging(null);
    };
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);
  /** Where a drop at `clientX` lands among the clips: before the first clip whose middle is right of it. */
  const indexAt = (clientX: number) => {
    const t = timeAt(clientX);
    const i = clips.findIndex((c) => t < c.start + c.dur / 2);
    return i < 0 ? clips.length : i;
  };
  const end = clips.reduce((e, c) => Math.max(e, c.start + c.dur), 0);
  const laneDrop = (lane: DropLane) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!isCanvasDrag(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = dragging ? "move" : "copy";
      const index = lane === "shots" ? indexAt(e.clientX) : 0;
      if (drop?.lane !== lane || drop.index !== index) setDrop({ lane, index });
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
    },
    onDrop: (e: React.DragEvent) => {
      const payload = readDrag(e);
      if (!payload) return;
      e.preventDefault();
      setDrop(null);
      setDragging(null);
      if (lane === "shots") {
        void edits.place(payload.items, clips.slice(indexAt(e.clientX)).map((c) => c.shotId));
        return;
      }
      const sounds = payload.items.filter((itemId) => assetById(project, itemId)?.kind === "audio");
      if (!sounds.length) {
        toast({ title: lane === "music" ? "Drop a song here" : "Drop a voiceover here", text: "Pictures and clips go on the Shots lane." });
        return;
      }
      void edits.place(sounds);
    },
  });

  // ------------------------------------------------------------ sound lanes
  const music = useSound(project, "music", jobs, total, voiceText);
  const voice = useSound(project, "voice", jobs, total, voiceText);
  const now = useNow(1000, !!music.job || !!voice.job);
  const [open, setOpen] = useState<Role | null>(null);
  const musicHead = useRef<HTMLButtonElement>(null);
  const voiceHead = useRef<HTMLButtonElement>(null);

  // A paced voiceover is one entry per sentence (the same file, trimmed); each is drawn at its own start.
  const entries = (role: Role) =>
    timeline.audio
      .filter((a) => a.role === role)
      .flatMap((a) => {
        const asset = assetById(project, a.assetId);
        if (!asset) return [];
        const length = Math.max(0, Math.min((a.out ?? asset.durationSec ?? total) - (a.in ?? 0), total - a.start));
        return length > 0 ? [{ start: a.start, length, key: `${a.assetId}-${a.start}` }] : [];
      });
  const musicEntries = entries("music");
  const voiceEntries = entries("voice");
  // With no shots on the timeline the lanes have no length: a song or a voiceover made for the cut waits there, ready.
  const waiting = (role: Role) => !clips.length && project.assets.some((a) => a.kind === "audio" && a.role === role && soundOnTimeline(project, a));
  const musicWaits = waiting("music");
  const voiceWaits = waiting("voice");
  const ratio = project.aspect === "9:16" ? 9 / 16 : project.aspect === "1:1" ? 1 : 16 / 9;
  // Lines past the end of the cut (its shots taken off) wait for the engine's next cut.
  const captions = timeline.captions.filter((c) => c.start < total);
  const marker = drop?.lane === "shots" ? (drop.index < clips.length ? x(clips[drop.index]!.start) : x(end)) : undefined;

  return (
    <div className="tl">
      <div className="tl__labels">
        <div className="tl__label" />
        <div className="tl__label">Shots</div>
        <SoundHead role="music" sound={music} on={musicEntries.length > 0 || musicWaits} open={open === "music"} anchor={musicHead} onOpen={(v) => setOpen(v ? "music" : null)} onOff={() => void edits.soundOff("music")} />
        <SoundHead role="voice" sound={voice} on={voiceEntries.length > 0 || voiceWaits} open={open === "voice"} anchor={voiceHead} onOpen={(v) => setOpen(v ? "voice" : null)} onOff={() => void edits.soundOff("voice")} />
        <div className="tl__label">Captions</div>
      </div>
      <div className="tl__scroll" ref={scrollRef}>
        <div className="tl__inner" style={{ width: innerW }}>
          <div className="tl__ruler" role="slider" tabIndex={0} aria-label="Playhead" aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.round(time * 10) / 10} aria-valuetext={timecode(time)} onKeyDown={(e) => {
            const next = e.key === "ArrowRight" ? time + 0.5 : e.key === "ArrowLeft" ? time - 0.5 : e.key === "Home" ? 0 : e.key === "End" ? total : undefined;
            if (next === undefined) return;
            e.preventDefault();
            onSeek(Math.max(0, Math.min(total, next)));
          }} onMouseDown={seekFromEvent}>
            {ticks.map((t) => (
              <span key={t} className={cx("tl__tick", x(t) > innerW - 40 && "tl__tick--end")} style={{ left: x(t) }}>
                <span>{timecode(t, false)}</span>
              </span>
            ))}
          </div>
          <div className={cx("tl__track", "tl__track--shots", drop?.lane === "shots" && "tl__track--drop")} data-lane="shots" onMouseDown={seekFromEvent} {...laneDrop("shots")}>
            {clips.map((c, i) => (
              // Keyed by shot, so a moved clip keeps its filmstrip.
              <div key={clips.findIndex((o) => o.shotId === c.shotId) === i ? c.shotId : `${c.shotId}-${i}`} className={cx("tl__clip", current === c && "tl__clip--on", dragging === c.shotId && "tl__clip--dragging")} style={{ left: x(c.start), width: Math.max(8, c.dur * pxPerSec - 3) }}>
                <button
                  type="button"
                  className="tl__clip-body"
                  draggable
                  aria-label={`Shot ${i + 1}, ${c.label}`}
                  aria-keyshortcuts="Delete"
                  title={`${c.label}, ${Math.round(c.dur * 100) / 100} s. Drag to move it.`}
                  onClick={(e) => {
                    if (e.detail === 0) onSeek(c.start + 0.01);
                  }}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    seekFromEvent(e);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Delete" && e.key !== "Backspace") return;
                    e.preventDefault();
                    void edits.takeOff(c.shotId);
                  }}
                  onDragStart={(e) => {
                    setDrag(e, { items: [c.shotId] });
                    setDragging(c.shotId);
                  }}
                >
                  <Filmstrip src={c.src} kind={c.kind} start={c.in} duration={c.dur} ratio={ratio} count={Math.max(1, Math.ceil((c.dur * pxPerSec) / (60 * ratio)))} />
                  <span className={cx("tl__clip-label", c.rung === "final" && "tl__clip-label--final")}>{i + 1}</span>
                </button>
                <button type="button" className="tl__clip-x" aria-label={`Take shot ${i + 1} off the timeline`} title="Take off the timeline. It stays in Media." onMouseDown={(e) => e.stopPropagation()} onClick={() => void edits.takeOff(c.shotId)}>
                  <X />
                </button>
              </div>
            ))}
            {!clips.length && <div className="tl__empty">Drag cards here from Media</div>}
            {marker !== undefined && <div className="tl__insert" style={{ left: marker }} aria-hidden />}
          </div>
          <SoundTrack role="music" sound={music} now={now} entries={musicEntries} waiting={musicWaits} x={x} pxPerSec={pxPerSec} dropping={drop?.lane === "music"} onSeek={seekFromEvent} onOpen={() => setOpen("music")} drops={laneDrop("music")} />
          <SoundTrack role="voice" sound={voice} now={now} entries={voiceEntries} waiting={voiceWaits} x={x} pxPerSec={pxPerSec} dropping={drop?.lane === "voice"} onSeek={seekFromEvent} onOpen={() => setOpen("voice")} drops={laneDrop("voice")} />
          <div className="tl__track" onMouseDown={seekFromEvent}>
            {captions.length ? (
              captions.map((c, i) => (
                <div
                  key={i}
                  className={cx("tl__caption", x(c.start) > innerW / 2 && "tl__caption--end")}
                  style={{ left: x(c.start), "--cap-w": `${Math.max(6, (c.end - c.start) * pxPerSec - 2)}px` } as React.CSSProperties}
                >
                  {/* Its own box, so a line longer than the chip ends in an ellipsis. Hovering the chip shows all of it. */}
                  <span className="tl__caption-text">{c.text}</span>
                </div>
              ))
            ) : (
              <div className="tl__empty">Captions follow the voice</div>
            )}
          </div>
          <div className="tl__head" style={{ left: x(time) }} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- songs and voiceovers

interface Sound {
  role: Role;
  /** The song or voiceover being made (or measured), if any. */
  job: Job | undefined;
  /** The newest one the GPU made, when it failed. */
  failed: Job | undefined;
  busy: boolean;
  text: string;
  setText: (v: string) => void;
  voice: string;
  setVoice: (v: string) => void;
  /** Saves the words to the brief and queues the song or the voiceover. */
  make: () => Promise<void>;
}

function useSound(project: Project, role: Role, jobs: Job[], total: number, voiceText: string): Sound {
  const { audio, updateProject } = useEngine();
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState(() => (role === "voice" ? voiceText : typeof project.brief.songPrompt === "string" ? project.brief.songPrompt : ""));
  const [voice, setVoice] = useState(() => (typeof project.brief.voice === "string" ? project.brief.voice : "mara"));
  const job = jobs.find((j) => j.step === role && isActive(j));
  // The newest song or voice the GPU made (analysis jobs only measure one). If it failed, its lane says why.
  const last = jobs.filter((j) => j.step === role && !j.analysis && j.status !== "cancelled").at(-1);
  const failed = last?.status === "failed" ? last : undefined;
  const make = async () => {
    const words = text.trim();
    if (!words) return;
    setBusy(true);
    try {
      if (role === "voice") {
        await updateProject(project.id, { brief: { ...project.brief, script: text, voice } });
        await audio(project.id, { role: "voice", text, voice });
      } else {
        const length = project.template === "music_video" && Number(project.brief.length) > 0 ? Number(project.brief.length) : total;
        await updateProject(project.id, { brief: { ...project.brief, songPrompt: text } });
        await audio(project.id, { role: "music", prompt: text, ...(length > 0 ? { durationSec: length } : {}) });
      }
    } catch (e) {
      toast({ title: "That didn't work", text: e instanceof Error ? e.message : String(e), tone: "bad" });
    } finally {
      setBusy(false);
    }
  };
  return { role, job, failed, busy, text, setText, voice, setVoice, make };
}

const NAMES: Record<Role, { lane: string; make: string; failed: string; off: string; drop: string; ready: string }> = {
  music: { lane: "Music", make: "Make a song", failed: "The music didn't finish", off: "Take the music off the timeline", drop: "or drag a song here", ready: "Song ready." },
  voice: { lane: "Voice", make: "Write voiceover", failed: "The voice didn't finish", off: "Take the voice off the timeline", drop: "or drag a voiceover here", ready: "Voiceover ready." },
};

function SoundHead({ role, sound, on, open, anchor, onOpen, onOff }: { role: Role; sound: Sound; on: boolean; open: boolean; anchor: React.RefObject<HTMLButtonElement | null>; onOpen: (v: boolean) => void; onOff: () => void }) {
  const names = NAMES[role];
  return (
    <div className="tl__label tl__label--sound">
      <span className="tl__label-name">{names.lane}</span>
      <span className="tl__label-actions">
        {on && (
          <button type="button" className="tl__icon" aria-label={names.off} title={names.off} onClick={onOff}>
            <X />
          </button>
        )}
        <button ref={anchor} type="button" className={cx("tl__icon", open && "tl__icon--on")} aria-label={names.make} title={names.make} aria-expanded={open} aria-haspopup="dialog" onClick={() => onOpen(!open)}>
          <Plus />
        </button>
      </span>
      {open && <SoundPopover sound={sound} anchor={anchor} onClose={() => onOpen(false)} />}
    </div>
  );
}

function SoundTrack({ role, sound, now, entries, waiting, x, pxPerSec, dropping, onSeek, onOpen, drops }: {
  role: Role;
  sound: Sound;
  now: number;
  entries: { start: number; length: number; key: string }[];
  /** A song or voiceover is the cut's, but there are no shots on the timeline to play it under yet. */
  waiting: boolean;
  x: (t: number) => number;
  pxPerSec: number;
  dropping: boolean;
  onSeek: (e: React.MouseEvent) => void;
  onOpen: () => void;
  drops: { onDragOver: (e: React.DragEvent) => void; onDragLeave: (e: React.DragEvent) => void; onDrop: (e: React.DragEvent) => void };
}) {
  const names = NAMES[role];
  const [dismissed, setDismissed] = useState<string | null>(null);
  const failed = !sound.job && sound.failed && sound.failed.id !== dismissed ? sound.failed : undefined;
  let note: ReactNode = null;
  if (sound.job) {
    note = (
      <div className="tl__note" role="status">
        <span className="pulse" />
        <span className="tl__note-text">{jobStatusLine(sound.job, now)}</span>
        <Bar value={sound.job.progress} className="tl__note-bar" />
      </div>
    );
  } else if (sound.busy) {
    note = (
      <div className="tl__note" role="status">
        <span className="pulse" />
        <span className="tl__note-text">Starting</span>
      </div>
    );
  } else if (failed) {
    const why = failureText(failed);
    note = (
      <div className="tl__note tl__note--bad" role="alert" title={why} onMouseDown={(e) => e.stopPropagation()}>
        <AlertCircle className="tl__note-icon" />
        <span className="tl__note-text">
          <b>{names.failed}.</b> {why}
        </span>
        <Button size="s" variant="quiet" onClick={() => (sound.text.trim() ? void sound.make() : onOpen())}>
          Try again
        </Button>
        <button type="button" className="tl__icon" aria-label="Dismiss" title="Dismiss" onClick={() => setDismissed(failed.id)}>
          <X />
        </button>
      </div>
    );
  } else if (waiting && !entries.length) {
    note = (
      <div className="tl__note tl__note--ready" role="status">
        <span className="tl__note-text">
          <b>{names.ready}</b> It plays once shots are on the timeline.
        </span>
      </div>
    );
  }
  return (
    <div className={cx("tl__track", dropping && "tl__track--drop")} data-lane={role} onMouseDown={onSeek} {...drops}>
      {entries.map((m, i) => (
        <div key={m.key} className={cx("tl__audio", role === "voice" && "tl__audio--voice")} style={{ left: x(m.start), width: Math.max(4, m.length * pxPerSec - 2) }}>
          <Wave seed={(role === "voice" ? 9 : 3) + i} n={Math.floor((m.length * pxPerSec) / 3)} speech={role === "voice"} />
        </div>
      ))}
      {!entries.length && !note && (
        <div className="tl__empty tl__empty--sound">
          {/* The lane label's + does the same for the keyboard and screen readers. */}
          <button type="button" className="tl__make" tabIndex={-1} aria-hidden onMouseDown={(e) => e.stopPropagation()} onClick={onOpen}>
            {names.make}
          </button>
          <span>{names.drop}</span>
        </div>
      )}
      {note}
    </div>
  );
}

/** The popover a lane's + opens: the words, the voice, and the button that makes it. */
function SoundPopover({ sound, anchor, onClose }: { sound: Sound; anchor: React.RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const ref = usePanelFocus<HTMLDivElement>();
  const tier = useInstalledTier();
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [ref, anchor, onClose]);
  const voice = sound.role === "voice";
  const seconds = tier?.estimates?.[sound.role]?.seconds;
  const submit = () => {
    if (!sound.text.trim() || sound.job) return;
    onClose();
    void sound.make();
  };
  return (
    <div
      ref={ref}
      className="lane-pop"
      role="dialog"
      aria-label={voice ? "Write voiceover" : "Make a song"}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        }
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="lane-pop__title">{voice ? "Voiceover" : "Song"}</div>
      {sound.failed && !sound.job && (
        <Notice tone="bad" title={NAMES[sound.role].failed}>
          {failureText(sound.failed)}
        </Notice>
      )}
      <Textarea
        aria-label={voice ? "Voice script" : "Music prompt"}
        value={sound.text}
        onChange={(e) => sound.setText(e.target.value)}
        placeholder={voice ? "What the voice says. Each sentence becomes a caption." : "Slow piano, warm, a little hopeful"}
        rows={voice ? 4 : 3}
      />
      <div className="lane-pop__text">
        {voice ? "Captions follow the words." : "Songs are instrumental, with no singing."}
        {seconds ? ` Takes ${roughDuration(seconds)}.` : ""}
      </div>
      <div className="lane-pop__row">
        {voice ? (
          <Select value={sound.voice} onChange={(e) => sound.setVoice(e.target.value)} aria-label="Voice" className="lane-pop__voice">
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}, {v.hint.toLowerCase()}
              </option>
            ))}
          </Select>
        ) : (
          <span />
        )}
        <Button size="s" variant="primary" disabled={!sound.text.trim() || !!sound.job} onClick={submit}>
          {voice ? "Make voice" : "Make song"}
        </Button>
      </div>
      {sound.job && <div className="lane-pop__text">One is being made. Wait for it to finish.</div>}
    </div>
  );
}

function Wave({ seed, n, speech }: { seed: number; n: number; speech?: boolean }) {
  const bars = useMemo(() => {
    let a = seed * 7919 + 13;
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      a = (a * 1103515245 + 12345) & 0x7fffffff;
      const r = (a % 1000) / 1000;
      const env = speech ? (Math.sin(i / 6) > -0.3 ? 1 : 0.15) : 0.6 + 0.4 * Math.sin(i / 11);
      out.push(0.15 + r * 0.85 * env);
    }
    return out;
  }, [seed, n, speech]);
  return (
    <div className="tl__wave" aria-hidden>
      {bars.map((h, i) => (
        <i key={i} style={{ height: `${h * 100}%` }} />
      ))}
    </div>
  );
}
