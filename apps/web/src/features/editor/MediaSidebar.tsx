/**
 * The editor's media sidebar: the project's boards as small groups of cards, each showing its pick. Drag a card, or a
 * board by its header, onto the timeline. Cards already in the cut carry a check; the rest have a + that adds them at
 * the end. Clicking a card in the cut moves the playhead to it.
 */
import type { Job, Project } from "@nightshift/contract";
import { Check, ChevronRight, Mic, Music, Plus } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { canvas, setDrag, type CanvasBoard, type CanvasItem } from "@/features/media/items";
import { assetById, frameClass, isActive } from "@/features/project/helpers";
import { shortDuration } from "@/lib/format";
import { Media } from "@/media/Media";
import { useEngine } from "@/store/engine";
import { Tag, cx } from "@/ui/primitives";
import { Filmstrip } from "./Filmstrip";

export function MediaSidebar({ project, jobs, onSeekShot, onAdd }: { project: Project; jobs: Job[]; onSeekShot: (shotId: string) => void; onAdd: (itemIds: string[]) => void }) {
  const boards = canvas(project);
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (boardId: string) =>
    setClosed((s) => {
      const next = new Set(s);
      if (!next.delete(boardId)) next.add(boardId);
      return next;
    });
  const empty = boards.every((b) => !b.items.length);
  return (
    <aside className="edm" aria-label="Media">
      <div className="edm__head">
        <span className="edm__title">Media</span>
        <Link to={`/p/${project.id}/media`} className="edm__open">
          Open Media
        </Link>
      </div>
      <div className="edm__scroll">
        {empty ? (
          <p className="edm__none">
            Nothing here yet. Make images and clips in <Link to={`/p/${project.id}/media`}>Media</Link>, then drag them onto the timeline.
          </p>
        ) : (
          boards.map((b) => <BoardGroup key={b.board.id} project={project} group={b} jobs={jobs} open={!closed.has(b.board.id)} onToggle={() => toggle(b.board.id)} onSeekShot={onSeekShot} onAdd={onAdd} />)
        )}
        {!empty && <p className="edm__tip">Drag a card, or a whole board by its name, onto the timeline.</p>}
      </div>
    </aside>
  );
}

function BoardGroup({ project, group, jobs, open, onToggle, onSeekShot, onAdd }: { project: Project; group: CanvasBoard; jobs: Job[]; open: boolean; onToggle: () => void; onSeekShot: (shotId: string) => void; onAdd: (itemIds: string[]) => void }) {
  const { board, items } = group;
  const pictures = items.filter((i) => i.kind !== "audio");
  const sounds = items.filter((i): i is Extract<CanvasItem, { kind: "audio" }> => i.kind === "audio");
  return (
    <section className="edm__board" aria-label={board.name}>
      <div
        className="edm__board-head"
        draggable={items.length > 0}
        onDragStart={(e) => setDrag(e, { items: items.map((i) => i.id), fromBoard: board.id })}
        onClick={onToggle}
        title={items.length ? "Drag the board onto the timeline to add all its cards" : undefined}
      >
        <button type="button" className="edm__toggle" aria-expanded={open} aria-label={`${board.name}, ${open ? "collapse" : "expand"}`} onClick={(e) => { e.stopPropagation(); onToggle(); }}>
          <ChevronRight className={cx("edm__chev", open && "edm__chev--open")} />
        </button>
        <span className="edm__board-name">{board.name}</span>
        <span className="edm__count">{items.length}</span>
      </div>
      {open && (
        <>
          {pictures.length > 0 && (
            <div className={cx("edm__grid", project.aspect === "9:16" && "edm__grid--tall")}>
              {pictures.map((item) => (
                <Card key={item.id} project={project} item={item} boardId={board.id} busy={item.kind === "shot" && jobs.some((j) => j.shotId === item.id && isActive(j))} onSeekShot={onSeekShot} onAdd={onAdd} />
              ))}
            </div>
          )}
          {sounds.map((item) => (
            <Sound key={item.id} item={item} boardId={board.id} onAdd={onAdd} />
          ))}
          {!items.length && <p className="edm__none edm__none--board">No cards on this board.</p>}
        </>
      )}
    </section>
  );
}

function Card({ project, item, boardId, busy, onSeekShot, onAdd }: { project: Project; item: Exclude<CanvasItem, { kind: "audio" }>; boardId: string; busy: boolean; onSeekShot: (shotId: string) => void; onAdd: (itemIds: string[]) => void }) {
  const on = item.kind === "shot" && item.onTimeline;
  const blank = item.kind === "shot" && !item.pick;
  // A What if? film is one shot: an image cannot join it as another.
  const addable = !(item.kind === "image" && project.template === "what_if");
  return (
    <div
      className={cx("edm__card", on && "edm__card--on")}
      draggable
      onDragStart={(e) => setDrag(e, { items: [item.id], fromBoard: boardId })}
      onClick={() => on && onSeekShot(item.id)}
      title={item.label}
    >
      <div className={cx("frame", frameClass(project.aspect), "edm__frame", blank && (busy ? "shimmer" : "frame--empty"))}>
        <Thumb project={project} item={item} />
        {busy && !blank && <span className="pulse edm__busy" role="img" aria-label="A new version is being made" />}
        {item.kind === "shot" && item.final && (
          <Tag tone="night" onMedia className="edm__final">
            Final
          </Tag>
        )}
        {on && (
          <span className="edm__mark" role="img" aria-label="On the timeline" title="On the timeline">
            <Check />
          </span>
        )}
        {!on && addable && (
          <button type="button" className="edm__add" aria-label={`Add ${item.label} to the timeline`} title="Add to the end of the timeline" onClick={(e) => { e.stopPropagation(); onAdd([item.id]); }}>
            <Plus />
          </button>
        )}
      </div>
      <div className="edm__label">{item.label}</div>
    </div>
  );
}

/**
 * The card's picture: its pick's first frame. A clip shows the still it started from, else one frame of the clip. An
 * effect or a camera move starts on that same still, so it shows a late frame, where the change shows.
 */
function Thumb({ project, item }: { project: Project; item: Exclude<CanvasItem, { kind: "audio" }> }) {
  const { client } = useEngine();
  const url = (assetId: string) => client.assetUrl(project.id, assetId);
  if (item.kind === "image") return <Media src={url(item.asset.id)} kind="image" />;
  const pick = item.pick;
  if (!pick) return null;
  if (pick.asset.kind === "image") return <Media src={url(pick.asset.id)} kind="image" />;
  const ratio = project.aspect === "9:16" ? 9 / 16 : project.aspect === "1:1" ? 1 : 16 / 9;
  const length = pick.asset.durationSec ?? 1;
  if (pick.tool) return <Filmstrip src={url(pick.asset.id)} kind="video" start={length * 0.8} duration={length * 0.2} count={1} ratio={ratio} />;
  const start = assetById(project, pick.take?.imageAssetId ?? item.shot.stillAssetId);
  if (start?.kind === "image") return <Media src={url(start.id)} kind="image" />;
  return <Filmstrip src={url(pick.asset.id)} kind="video" start={0} duration={length} count={1} ratio={ratio} />;
}

function Sound({ item, boardId, onAdd }: { item: Extract<CanvasItem, { kind: "audio" }>; boardId: string; onAdd: (itemIds: string[]) => void }) {
  const words = item.asset.text?.trim().replace(/\s+/g, " ");
  const length = item.asset.durationSec ? shortDuration(item.asset.durationSec) : "";
  return (
    <div className={cx("edm__sound", item.onTimeline && "edm__sound--on")} draggable onDragStart={(e) => setDrag(e, { items: [item.id], fromBoard: boardId })} title={words || item.label}>
      {item.role === "voice" ? <Mic className="edm__sound-icon" /> : <Music className="edm__sound-icon" />}
      <span className="edm__sound-text">
        <span className="edm__sound-name">{item.label}</span>
        <span className="edm__sound-sub">{[length, words].filter(Boolean).join(", ")}</span>
      </span>
      {item.onTimeline ? (
        <span className="edm__sound-mark" role="img" aria-label="On the timeline" title="On the timeline">
          <Check />
        </span>
      ) : (
        <button type="button" className="edm__add edm__add--row" aria-label={`Use this ${item.role === "voice" ? "voiceover" : "song"} on the timeline`} title="Use on the timeline" onClick={() => onAdd([item.id])}>
          <Plus />
        </button>
      )}
    </div>
  );
}
