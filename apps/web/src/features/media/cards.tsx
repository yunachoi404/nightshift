/**
 * The cards on a board: a shot (its pick, with its versions behind it), an uploaded image, a song or a voiceover.
 * Every card can be dragged to another board or onto the editor's timeline.
 */
import { shotTemplate, type Job } from "@nightshift/contract";
import { Brush, Clapperboard, Film, Layers, ListPlus, Maximize2, Mic, Moon as MoonIcon, Move3d, Music, Pause, Play, Sparkles, Video } from "lucide-react";
import { Moon } from "@/ui/Moon";
import { Star } from "@/ui/Star";
import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { useEngine, useEngineState } from "@/store/engine";
import { useInstalledTier } from "@/store/tier";
import { Button, cx, toast } from "@/ui/primitives";
import { Media } from "@/media/Media";
import { activeJob, failureText, frameClass, isGpuJob, jobElapsed, jobStage, lastFailed } from "@/features/project/helpers";
import { useNow } from "@/lib/useNow";
import { plural, timecode } from "@/lib/format";
import { useMedia, type ImageTool } from "./context";
import { toolBlocked } from "./panel/tools";
import { CARD_STEPS, canAddToTimeline, makeBlocked, placeOnTimeline, restingTime, retryFor, setDrag, shotLabel, type CanvasItem } from "./items";
import { Wave } from "@/features/editor/Wave";
import { useFreshPick } from "@/features/takes/freshPicks";

type ShotItem = Extract<CanvasItem, { kind: "shot" }>;
type ImageItem = Extract<CanvasItem, { kind: "image" }>;
type AudioItem = Extract<CanvasItem, { kind: "audio" }>;

/** Where a drop would land: a line before or after this card. */
export type DropMark = "before" | "after" | undefined;

interface CardProps<T> {
  item: T;
  boardId: string;
  index: number;
  drop?: DropMark;
}

/** The shell every card shares: its place on the board (for drops) and its drag. */
function CardShell({ id, boardId, index, drop, className, children, label }: { id: string; boardId: string; index: number; drop?: DropMark; className?: string; children: ReactNode; label: string }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className={cx("mp-card", className, drop && `mp-card--drop-${drop}`, dragging && "mp-card--dragging")}
      data-index={index}
      data-card={id}
      aria-label={label}
      role="group"
      draggable
      onDragStart={(e: DragEvent) => {
        setDrag(e, { items: [id], fromBoard: boardId });
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
    >
      {children}
    </div>
  );
}

/** A card the cut uses: a quiet film mark, with its words on a picture. */
function OnTimeline({ onMedia = true }: { onMedia?: boolean }) {
  if (!onMedia)
    return (
      <span className="mp-card__ontl" role="img" aria-label="On the timeline" title="On the timeline">
        <Film />
      </span>
    );
  return (
    <span className="mp-onmedia mp-onmedia--quiet" role="img" aria-label="On the timeline" title="On the timeline">
      <Film />
      <span aria-hidden>On the timeline</span>
    </span>
  );
}

/** Adds cards to the end of the timeline. */
function useAddToTimeline(): (ids: string[]) => void {
  const { edit } = useMedia();
  return (ids) => void edit((p) => placeOnTimeline(p, ids));
}

// ---------------------------------------------------------------- shot

const TOOL_STEP_LABEL: Partial<Record<Job["step"], string>> = {
  effect_end_frame: "Effect",
  video_effect: "Effect",
  camera_layout: "Camera move",
  video_camera_move: "Camera move",
  video_draft: "Video",
};

/**
 * A card being made: a soft light moves across the empty frame (or over the old picture, dimmed), with the step, the
 * time so far and a moon that waxes from new to full as it renders. A card that waits for tonight wears the crescent;
 * while the GPU is away it says why it waits.
 */
function MakingState({ job, onMedia, now }: { job: Job; onMedia: boolean; now: number }) {
  const { status, settings } = useEngineState();
  const night = job.mode === "overnight";
  const stage = jobStage(job);
  const elapsed = jobElapsed(job, now);
  const gpuAway = !!status && status.phase === "ready" && !status.comfyui.running && isGpuJob(job);
  // Not rendering yet: waiting for the GPU, or queued behind other work. It reads still, without the warm glow or a ring.
  const waiting = gpuAway || stage === "Waiting for the GPU" || job.status === "queued";
  const remote = status?.mode === "remote" ? settings?.remote : null;
  const where = remote ? (remote.name ?? remote.url.replace(/^https?:\/\//, "")) : null;
  const pct = Math.round(job.progress * 100);
  // While the GPU is away, even a job it had started waits: the chip names what it waits for.
  const label = gpuAway ? (where ? `Waiting for ${where}` : "Waiting for the GPU") : stage;
  return (
    <>
      {!onMedia && <div className={cx("mp-making", night && "mp-making--night", waiting && "mp-making--waiting")} aria-hidden />}
      <div className={cx("mp-card__state mp-card__state--making", onMedia && "mp-card__state--onmedia")} role="status">
        <span className={cx("mp-making__chip", waiting && "mp-making__chip--waiting")}>
          {waiting ? (
            night && !gpuAway ? <MoonIcon className="mp-making__tonight" aria-hidden /> : <span className={cx("pulse", "pulse--idle")} />
          ) : (
            <Moon phase={Math.max(0.04, job.progress)} night={night} label={`${pct}% done`} />
          )}
          <span className="mp-making__stage">{label}</span>
          {elapsed && !waiting && <span className="mp-making__time">{elapsed}</span>}
        </span>
        {gpuAway && <span className="mp-making__why">{where ? "The GPU computer is busy or can't be reached. This starts when it is free." : "This starts when the GPU is free"}</span>}
      </div>
      {/* A waiting job's old progress would read as work happening: the line shows only while it renders. */}
      {!waiting && (
        <div className={cx("frame__progress", night && "frame__progress--night")}>
          <div style={{ width: `${job.progress * 100}%` }} />
        </div>
      )}
    </>
  );
}

export function ShotCard({ item, boardId, index, drop }: CardProps<ShotItem>) {
  const { project, jobs, picking, pickSource, openCard, sourceCardId } = useMedia();
  const { client, still, draft, final } = useEngine();
  const addToTimeline = useAddToTimeline();
  const [hover, setHover] = useState(false);
  const { shot, pick, history } = item;
  const fresh = useFreshPick(shot);
  const job = activeJob(jobs, shot.id, CARD_STEPS);
  const failed = job ? undefined : lastFailed(jobs, shot.id, CARD_STEPS);
  const now = useNow(1000, job?.status === "running");
  const pickable = picking && !!shot.stillAssetId;
  const versions = history.length;
  // Until its first take lands, a card made with a tool is named by it ("Effect, Levitate"), not by the subject it was
  // given; a card without words says what is making it.
  const firstTake = !history.some((v) => v.rung !== "still") && job ? job : undefined;
  const making = firstTake?.tool ? shotLabel(project, shot, history, firstTake.tool) : firstTake && !shot.prompt.trim() ? TOOL_STEP_LABEL[firstTake.step] : undefined;
  const label = making ?? item.label;
  const resting = pick ? restingTime(pick, shot.durationSec) : undefined;
  // A draft or a final is a clip: its length shows on the picture, so it never reads as a still.
  const clip = pick && pick.rung !== "still" ? (pick.asset.durationSec ?? shot.durationSec) : undefined;
  // What "Try again" runs: the failed request when it is known exactly, else the card opens to choose again.
  const again = failed ? retryFor(project, shot, failed.step) : undefined;

  const retry = async (j: Job) => {
    const r = retryFor(project, shot, j.step);
    if (!r || r.kind === "story") return openCard(shot.id);
    try {
      if (r.kind === "still") await still(project.id, shot.id);
      else if (r.kind === "draft") await draft(project.id, shot.id);
      else if (shot.chosenDraftId) await final(project.id, shot.id, { draftId: shot.chosenDraftId, kind: r.finalKind, mode: j.mode });
    } catch (e) {
      toast({ title: "Couldn't start", text: e instanceof Error ? e.message : String(e), tone: "bad" });
    }
  };

  return (
    <CardShell
      id={shot.id}
      boardId={boardId}
      index={index}
      drop={drop}
      label={label}
      className={cx(picking && (pickable ? "mp-card--pickable" : "mp-card--unpickable"), sourceCardId === shot.id && "mp-card--source")}
    >
      <div
        className={cx("frame mp-card__frame", frameClass(shot.aspect ?? project.aspect), !pick && "frame--empty", job && pick && "frame--working", job && !pick && "mp-card__frame--making")}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {pick && (
          <Media
            src={client.assetUrl(project.id, pick.asset.id)}
            kind={pick.rung === "still" ? "image" : "video"}
            playing={hover && !picking}
            durationSec={shot.durationSec}
            // An effect or a camera move rests on a late frame, where the change shows, and plays from the start on hover.
            {...(resting !== undefined ? { time: hover && !picking ? 0 : resting } : {})}
          />
        )}
        <button
          type="button"
          className="mp-card__open"
          aria-label={pickable ? `Use the still of ${label}` : `Open ${label}`}
          disabled={picking && !pickable}
          onClick={() => (picking ? shot.stillAssetId && pickSource(shot.stillAssetId, shot.id) : openCard(shot.id))}
        />
        {!pick && !job && !failed && (
          <div className="mp-card__state">
            {shotTemplate(project, shot) === "what_if" ? (
              <Link to={`/p/${project.id}/storyboard`} className="btn btn--s">
                Open the story
              </Link>
            ) : shot.prompt.trim() ? (
              <Button size="s" onClick={() => void still(project.id, shot.id).catch((e) => toast({ title: "Couldn't start", text: String(e), tone: "bad" }))}>
                Draw the still
              </Button>
            ) : (
              <span>Empty shot</span>
            )}
          </div>
        )}
        {job && <MakingState job={job} onMedia={!!pick} now={now} />}
        {failed && (
          <div className="mp-card__state mp-card__state--failed" role="alert">
            <span className="mp-card__fail">{failureText(failed)}</span>
            {again?.kind === "story" ? (
              // A What if? beat or film is made again from its story, where the beat to redraw is chosen.
              <Link to={`/p/${project.id}/storyboard`} className="btn btn--s">
                Open the story
              </Link>
            ) : (
              <Button size="s" onClick={() => void retry(failed)}>
                Try again
              </Button>
            )}
          </div>
        )}
        {(pick?.rung === "final" || versions > 1 || fresh) && (
          <div className="mp-card__marks">
            {/* A take that landed and replaced the pick says so until the card is opened. */}
            {fresh && (
              <span className="mp-mark mp-mark--new" title="A new take landed and is now the pick. Open the card to keep the one before.">
                New take
              </span>
            )}
            {pick?.rung === "final" && (
              <span className="mp-mark mp-mark--final">
                <Star />
                Final
              </span>
            )}
            {/* New take says there is more than one; the count would crowd the clip's length on a narrow card. */}
            {versions > 1 && !fresh && (
              <span className="mp-mark" title={plural(versions, "version")}>
                <Layers aria-hidden />
                {versions}
                <span className="visually-hidden"> versions</span>
              </span>
            )}
          </div>
        )}
        {clip !== undefined && (
          <div className="mp-card__marks mp-card__marks--end">
            <span className="mp-mark mp-mark--clip" title={`A ${pick?.rung === "final" ? "final" : "draft"} clip`}>
              <Play aria-hidden />
              {timecode(clip, false)}
              <span className="visually-hidden"> video</span>
            </span>
          </div>
        )}
        {/* A micro drama's line, set on its picture like the subtitle it becomes. */}
        {project.template === "micro_drama" && pick && shot.line?.trim() && !picking && <p className="mp-card__line">{shot.line.trim()}</p>}
        {picking ? (
          pickable && <div className="mp-card__pickhint">Use this still</div>
        ) : (
          // Under the pointer: the card's words, its versions and what it can do. At rest the picture is the card.
          <div className="mp-card__band">
            <div className="mp-card__band-text">
              {versions > 1 && (
                <div className="mp-card__dots" aria-hidden>
                  {history.map((v) => (
                    <span key={v.key} className={cx("mp-card__dot", v.pick && "mp-card__dot--pick", v.rung === "final" && "mp-card__dot--final")} />
                  ))}
                </div>
              )}
              <span className="mp-card__caption">{label}</span>
            </div>
            <div className="mp-card__hover">
              {/* An extra card of a What if? film or a quick shot stays in Media: its timeline is the project's own shot. */}
              {item.onTimeline ? (
                <OnTimeline />
              ) : (
                canAddToTimeline(project, shot.id) && (
                  <button type="button" className="mp-onmedia" onClick={() => addToTimeline([shot.id])}>
                    <ListPlus /> Add to timeline
                  </button>
                )
              )}
              <button type="button" className="mp-onmedia mp-onmedia--icon" aria-label={`Open ${label}`} title="Open" tabIndex={-1} onClick={() => openCard(shot.id)}>
                <Maximize2 />
              </button>
            </div>
          </div>
        )}
      </div>
    </CardShell>
  );
}

// ---------------------------------------------------------------- image

const IMAGE_TOOLS: Array<{ tool: ImageTool; label: string; icon: ReactNode }> = [
  { tool: "video", label: "Make video", icon: <Video /> },
  { tool: "edit", label: "Edit", icon: <Brush /> },
  { tool: "effect", label: "Effect", icon: <Sparkles /> },
  { tool: "camera_move", label: "Camera move", icon: <Move3d /> },
];

/** The box an uploaded image takes on the board: its own shape when known. */
export function imageRatio(item: Pick<ImageItem, "asset">, fallback: number): number {
  const { width, height } = item.asset;
  return width && height ? width / height : fallback;
}

export function ImageCard({ item, boardId, index, drop, fallbackRatio }: CardProps<ImageItem> & { fallbackRatio: number }) {
  const { project, picking, pickSource, withImage, sourceCardId } = useMedia();
  const { client } = useEngine();
  const tier = useInstalledTier();
  const addToTimeline = useAddToTimeline();
  const ratio = imageRatio(item, fallbackRatio);
  // A quick shot makes its own shot before any card. A What if? film or a quick shot takes no second shot.
  const tools = !makeBlocked(project);
  const toTimeline = canAddToTimeline(project, item.id);
  // A reference carries its name on the picture. A plain upload has no words worth showing.
  const named = project.references?.some((r) => r.assetId === item.asset.id) ?? false;
  return (
    <CardShell id={item.id} boardId={boardId} index={index} drop={drop} label={item.label} className={cx(picking && "mp-card--pickable", sourceCardId === item.id && "mp-card--source")}>
      <div className="frame mp-card__frame" style={{ aspectRatio: String(ratio) } as CSSProperties}>
        <Media src={client.assetUrl(project.id, item.asset.id)} kind="image" alt={item.label} />
        <button
          type="button"
          className="mp-card__open"
          aria-label={picking ? `Use ${item.label}` : item.label}
          tabIndex={picking ? 0 : -1}
          onClick={() => picking && pickSource(item.asset.id, item.id)}
        />
        {picking ? (
          <div className="mp-card__pickhint">Use this image</div>
        ) : (
          (tools || toTimeline) && (
            <div className="mp-card__hover mp-card__hover--tools">
              {tools &&
                IMAGE_TOOLS.filter((t) => !toolBlocked(tier, t.tool)).map((t) => (
                  <button key={t.tool} type="button" className="mp-onmedia mp-onmedia--icon" aria-label={`${t.label} from ${item.label}`} title={t.label} onClick={() => withImage(item.asset.id, t.tool, item.id)}>
                    {t.icon}
                  </button>
                ))}
              {toTimeline && (
                <button type="button" className="mp-onmedia mp-onmedia--icon" aria-label={`Add ${item.label} to the timeline`} title="Add to timeline" onClick={() => addToTimeline([item.id])}>
                  <ListPlus />
                </button>
              )}
            </div>
          )
        )}
        {named && (
          <div className="mp-card__marks">
            <span className="mp-mark">{item.label}</span>
          </div>
        )}
      </div>
    </CardShell>
  );
}

// ---------------------------------------------------------------- song, voiceover

export function AudioTile({ item, boardId, index, drop, name = item.label }: CardProps<AudioItem> & { name?: string }) {
  const { project } = useMedia();
  const { client } = useEngine();
  const addToTimeline = useAddToTimeline();
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const url = client.assetUrl(project.id, item.asset.id);
  // Mock assets have no sound to play.
  const playable = !url.startsWith("mock:");
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    if (playing) void a.play().catch(() => setPlaying(false));
    else a.pause();
  }, [playing]);
  const words = item.asset.text?.trim();
  const voice = item.role === "voice";
  return (
    <CardShell id={item.id} boardId={boardId} index={index} drop={drop} label={item.label} className={cx("mp-card--audio", playing && "mp-card--playing")}>
      <div className="mp-audio" title={words || undefined}>
        <button type="button" className="mp-audio__play" aria-label={playing ? `Pause the ${item.label.toLowerCase()}` : `Play the ${item.label.toLowerCase()}`} disabled={!playable} title={playable ? undefined : "No sound in the demo"} onClick={() => setPlaying((v) => !v)}>
          {playing ? <Pause /> : <Play />}
        </button>
        <div className="mp-audio__text">
          <div className="mp-audio__name">
            {voice ? <Mic /> : <Music />}
            <span className="mp-audio__label">{name}</span>
            {item.asset.durationSec ? <span className="mp-audio__dur">{timecode(item.asset.durationSec, false)}</span> : null}
          </div>
          {words ? <div className="mp-audio__words">{words}</div> : <Wave seed={hashSeed(item.id)} n={56} speech={voice} className="mp-audio__wave" />}
        </div>
        {item.onTimeline ? (
          <OnTimeline onMedia={false} />
        ) : (
          <Button size="s" variant="quiet" icon={<ListPlus />} iconOnly aria-label={`Add the ${item.label.toLowerCase()} to the timeline`} title="Add to timeline" onClick={() => addToTimeline([item.id])} />
        )}
        {playable && <audio ref={ref} src={url} preload="none" onEnded={() => setPlaying(false)} />}
      </div>
    </CardShell>
  );
}

/** A small number from an id, so each song draws its own shape. */
function hashSeed(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % 997;
}

/** A frame waiting for its first picture: the shot list being written. It shimmers only while the writing runs. */
export function PlaceholderCard({ aspect, rendering }: { aspect: string; rendering?: boolean }) {
  return (
    <div className="mp-card" aria-hidden>
      <div className={cx("frame", rendering ? "shimmer" : "frame--empty", aspect)}>
        <div className="mp-card__state">
          <Clapperboard />
        </div>
      </div>
    </div>
  );
}
