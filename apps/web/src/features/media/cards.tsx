/**
 * The cards on a board: a shot (its pick, with its versions behind it), an uploaded image, a song or a voiceover.
 * Every card can be dragged to another board or onto the editor's timeline.
 */
import type { Job } from "@nightshift/contract";
import { Brush, Clapperboard, Film, Layers, ListPlus, Maximize2, Mic, Move3d, Music, Pause, Play, Sparkles, Video } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { useEngine } from "@/store/engine";
import { useInstalledTier } from "@/store/tier";
import { Button, cx, toast } from "@/ui/primitives";
import { Media } from "@/media/Media";
import { activeJob, failureText, frameClass, lastFailed, jobStatusLine } from "@/features/project/helpers";
import { useNow } from "@/lib/useNow";
import { plural, timecode } from "@/lib/format";
import { useMedia, type ImageTool } from "./context";
import { toolBlocked } from "./panel/tools";
import { CARD_STEPS, makeBlocked, placeOnTimeline, restingTime, retryFor, setDrag, type CanvasItem } from "./items";

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

/** A card the cut uses: a quiet film mark, the words on hover. */
function OnTimeline() {
  return (
    <span className="mp-card__ontl" role="img" aria-label="On the timeline" title="On the timeline">
      <Film />
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

export function ShotCard({ item, boardId, index, drop }: CardProps<ShotItem>) {
  const { project, jobs, picking, pickSource, openCard, sourceCardId } = useMedia();
  const { client, still, draft, final } = useEngine();
  const addToTimeline = useAddToTimeline();
  const [hover, setHover] = useState(false);
  const { shot, pick, history } = item;
  const job = activeJob(jobs, shot.id, CARD_STEPS);
  const failed = job ? undefined : lastFailed(jobs, shot.id, CARD_STEPS);
  const now = useNow(1000, job?.status === "running");
  const pickable = picking && !!shot.stillAssetId;
  const versions = history.length;
  // A card without words of its own (an effect or a camera move on an image) says what is making it until its take lands.
  const making = !shot.prompt.trim() && !history.some((v) => v.rung !== "still") && job ? TOOL_STEP_LABEL[job.step] : undefined;
  const label = making ?? item.label;
  const resting = pick ? restingTime(pick, shot.durationSec) : undefined;
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
        className={cx("frame mp-card__frame", frameClass(shot.aspect ?? project.aspect), !pick && "frame--empty", job && pick && "frame--working")}
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
            {project.template === "what_if" ? (
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
        {job && (
          <>
            <div className={cx("mp-card__state", pick && "mp-card__state--onmedia")}>
              <span className={cx("pulse", job.mode === "overnight" && "pulse--night")} />
              <span>{jobStatusLine(job, now)}</span>
            </div>
            <div className={cx("frame__progress", job.mode === "overnight" && "frame__progress--night")}>
              <div style={{ width: `${job.progress * 100}%` }} />
            </div>
          </>
        )}
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
        {(pick?.rung === "final" || versions > 1) && (
          <div className="mp-card__marks">
            {pick?.rung === "final" && <span className="mp-mark mp-mark--final">Final</span>}
            {versions > 1 && (
              <span className="mp-mark" title={plural(versions, "version")}>
                <Layers aria-hidden />
                {versions}
                <span className="visually-hidden"> versions</span>
              </span>
            )}
          </div>
        )}
        {versions > 1 && (
          <div className="mp-card__dots" aria-hidden>
            {history.map((v) => (
              <span key={v.key} className={cx("mp-card__dot", v.pick && "mp-card__dot--pick", v.rung === "final" && "mp-card__dot--final")} />
            ))}
          </div>
        )}
        {picking ? (
          pickable && <div className="mp-card__pickhint">Use this still</div>
        ) : (
          <div className="mp-card__hover">
            {!item.onTimeline && (
              <button type="button" className="mp-onmedia" onClick={() => addToTimeline([shot.id])}>
                <ListPlus /> Add to timeline
              </button>
            )}
            <button type="button" className="mp-onmedia mp-onmedia--icon" aria-label={`Open ${label}`} title="Open" tabIndex={-1} onClick={() => openCard(shot.id)}>
              <Maximize2 />
            </button>
          </div>
        )}
      </div>
      <div className="mp-card__meta">
        <span className="mp-card__label" title={label}>
          {label}
        </span>
        {item.onTimeline && <OnTimeline />}
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
  // The engine makes no new cards in a What if? film or a quick shot, and a What if? film takes no second shot.
  const tools = !makeBlocked(project);
  const toTimeline = project.template !== "what_if";
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
      </div>
      <div className="mp-card__meta">
        <span className="mp-card__label" title={item.label}>
          {item.label}
        </span>
      </div>
    </CardShell>
  );
}

// ---------------------------------------------------------------- song, voiceover

export function AudioTile({ item, boardId, index, drop }: CardProps<AudioItem>) {
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
  return (
    <CardShell id={item.id} boardId={boardId} index={index} drop={drop} label={item.label} className="mp-card--audio">
      <div className="mp-audio">
        <button type="button" className="mp-audio__play" aria-label={playing ? `Pause the ${item.label.toLowerCase()}` : `Play the ${item.label.toLowerCase()}`} disabled={!playable} title={playable ? undefined : "No sound in the demo"} onClick={() => setPlaying((v) => !v)}>
          {playing ? <Pause /> : <Play />}
        </button>
        <div className="mp-audio__text">
          <div className="mp-audio__name">
            {item.role === "voice" ? <Mic /> : <Music />}
            {item.label}
            {item.asset.durationSec ? <span className="mp-audio__dur">{timecode(item.asset.durationSec, false)}</span> : null}
          </div>
          {words && <div className="mp-audio__words">{words}</div>}
        </div>
        {item.onTimeline ? (
          <OnTimeline />
        ) : (
          <Button size="s" variant="quiet" icon={<ListPlus />} iconOnly aria-label={`Add the ${item.label.toLowerCase()} to the timeline`} title="Add to timeline" onClick={() => addToTimeline([item.id])} />
        )}
        {playable && <audio ref={ref} src={url} preload="none" onEnded={() => setPlaying(false)} />}
      </div>
    </CardShell>
  );
}

/** A frame waiting for its first picture: the shot list being written. */
export function PlaceholderCard({ aspect }: { aspect: string }) {
  return (
    <div className="mp-card" aria-hidden>
      <div className={cx("frame shimmer", aspect)}>
        <div className="mp-card__state">
          <Clapperboard />
        </div>
      </div>
    </div>
  );
}
