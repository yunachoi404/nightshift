/**
 * One board: its cards laid out in columns (masonry, so wide and tall pictures sit together without gaps), a drop
 * target for cards from other boards and files from the desktop, and the board's first steps (draw the stills, write
 * the story) when the project is new.
 */
import { fallbackShots, projectBoards, sentenceCase, type Job, type Project, type Shot } from "@nightshift/contract";
import { Check, Clapperboard, Pencil, Plus, RefreshCw, Wand2 } from "lucide-react";
import { useLayoutEffect, useRef, useState, type DragEvent, type RefObject } from "react";
import { useEngine } from "@/store/engine";
import { useInstalledTier } from "@/store/tier";
import { Button, Dialog, Input, Notice, cx, toast } from "@/ui/primitives";
import { failureText, frameClass, isActive, jobElapsed, jobStatusLine, timelineShots } from "@/features/project/helpers";
import { useNow } from "@/lib/useNow";
import { plural, roughDuration } from "@/lib/format";
import { useMedia } from "./context";
import { AudioTile, ImageCard, PlaceholderCard, ShotCard, imageRatio, type DropMark } from "./cards";
import { dropMoves, isCanvasDrag, makeBlocked, readDrag, type CanvasBoard, type CanvasItem } from "./items";

/** Films start with a shot list from their brief. */
const FILMS = new Set<Project["template"]>(["cinematic_shot", "music_video", "product_ad", "talking_intro"]);

const ASPECT_RATIO: Record<Project["aspect"], number> = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1 };
/** The narrowest a column gets, by the project's shape: tall frames can be narrower. */
const MIN_COLUMN: Record<Project["aspect"], number> = { "16:9": 260, "9:16": 170, "1:1": 210 };
const GAP = 14;

export interface BoardViewProps {
  board: CanvasBoard;
  /**
   * "single": the only board, filling the page, with its name, rename and "New board" in its header. "canvas": one
   * board among several, inside its frame on the canvas.
   */
  variant?: "single" | "canvas";
  /** Whether to draw the board's name. On the canvas, the board's frame draws it. First steps show either way. */
  header?: boolean;
}

export function BoardView({ board, variant = "single", header = true }: BoardViewProps) {
  const { project, jobs, boardActions, focusBoard, upload } = useMedia();
  const ref = useRef<HTMLElement>(null);
  const columns = useColumns(ref, MIN_COLUMN[project.aspect]);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [filesOver, setFilesOver] = useState(false);
  const all = projectBoards(project);
  const main = board.board.id === all[0]?.id;
  const steps = firstSteps(project, jobs, main);
  const ids = board.items.map((i) => i.id);

  const onDragOver = (e: DragEvent<HTMLElement>) => {
    const files = hasFiles(e);
    if (!isCanvasDrag(e) && !files) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = files ? "copy" : "move";
    if (files) return setFilesOver(true);
    const card = (e.target as HTMLElement).closest<HTMLElement>("[data-index]");
    if (!card || !ref.current?.contains(card)) return setDropAt(ids.length);
    const i = Number(card.dataset.index);
    const r = card.getBoundingClientRect();
    setDropAt(e.clientY < r.top + r.height / 2 ? i : i + 1);
  };
  const onDragLeave = (e: DragEvent<HTMLElement>) => {
    if (e.relatedTarget instanceof Node && ref.current?.contains(e.relatedTarget)) return;
    setDropAt(null);
    setFilesOver(false);
  };
  const onDrop = (e: DragEvent<HTMLElement>) => {
    const at = dropAt ?? ids.length;
    setDropAt(null);
    setFilesOver(false);
    if (hasFiles(e)) {
      e.preventDefault();
      focusBoard(board.board.id);
      void upload(Array.from(e.dataTransfer.files), board.board.id);
      return;
    }
    const payload = readDrag(e);
    if (!payload) return;
    e.preventDefault();
    focusBoard(board.board.id);
    for (const move of dropMoves(ids, payload.items, at)) void boardActions.moveCardTo(move.id, board.board.id, move.index);
  };

  const mark = (index: number): DropMark => (dropAt === null ? undefined : dropAt === index ? "before" : dropAt === ids.length && index === ids.length - 1 ? "after" : undefined);
  const ratio = ASPECT_RATIO[project.aspect];
  const placeholders = steps.writing && !project.shots.length && main ? fallbackShots(project.template, project.brief).length : 0;
  // While the shot list is written: one frame per shot the brief asks for.
  const entries: Entry[] = board.items.length ? board.items.map((item, index) => ({ item, index })) : Array.from({ length: placeholders }, (_, k) => ({ placeholder: k }));
  const laid = masonry(entries, columns, (e) => ("item" in e ? cardHeight(e.item, ratio) : 1 / ratio + 0.16));

  return (
    <section
      ref={ref}
      className={cx("mp-board", `mp-board--${variant}`, (filesOver || dropAt !== null) && "mp-board--over")}
      aria-label={`Board ${board.board.name}`}
      onPointerDown={() => focusBoard(board.board.id)}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <BoardHead board={board} variant={variant} title={header} steps={steps} />
      {steps.writing && main && <WritingLine job={steps.writing} project={project} />}
      {steps.failedText && main && (
        <FailedText job={steps.failedText} project={project} />
      )}
      {entries.length > 0 ? (
        <div className="mp-masonry" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
          {laid.map((column, c) => (
            <div key={c} className="mp-col">
              {column.map((e) => ("item" in e ? <Card key={e.item.id} item={e.item} index={e.index} boardId={board.board.id} drop={mark(e.index)} ratio={ratio} /> : <PlaceholderCard key={e.placeholder} aspect={frameClass(project.aspect)} />))}
            </div>
          ))}
        </div>
      ) : (
        <EmptyBoard project={project} main={main} single={variant === "single"} steps={steps} />
      )}
    </section>
  );
}

type Entry = { item: CanvasItem; index: number } | { placeholder: number };

function Card({ item, index, boardId, drop, ratio }: { item: CanvasItem; index: number; boardId: string; drop: DropMark; ratio: number }) {
  if (item.kind === "shot") return <ShotCard item={item} index={index} boardId={boardId} drop={drop} />;
  if (item.kind === "image") return <ImageCard item={item} index={index} boardId={boardId} drop={drop} fallbackRatio={ratio} />;
  return <AudioTile item={item} index={index} boardId={boardId} drop={drop} />;
}

// ---------------------------------------------------------------- header

function BoardHead({ board, variant, title, steps }: { board: CanvasBoard; variant: "single" | "canvas"; title: boolean; steps: FirstSteps }) {
  const { project, boardActions, focusBoard } = useMedia();
  const { still, draft, storyboard } = useEngine();
  const tier = useInstalledTier();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(board.board.name);
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const count = board.items.length;

  const save = () => {
    setRenaming(false);
    if (name.trim() && name.trim() !== board.board.name) void boardActions.renameBoard(board.board.id, name);
    else setName(board.board.name);
  };
  const run = async (what: () => Promise<unknown>, failTitle: string) => {
    setBusy(true);
    try {
      await what();
    } catch (e) {
      toast({ title: failTitle, text: e instanceof Error ? e.message : String(e), tone: "bad" });
    } finally {
      setBusy(false);
    }
  };
  const drawStills = (shots: Shot[]) =>
    run(async () => {
      for (const s of shots) await still(project.id, s.id);
      const each = tier?.estimates?.still?.seconds;
      toast({ title: `Drawing ${plural(shots.length, "still")}`, text: each ? `${sentenceCase(roughDuration(each * shots.length))} in all.` : "They land here one by one.", tone: "accent" });
    }, "Couldn't start the stills");

  const makeVideos = (shots: Shot[]) =>
    run(async () => {
      for (const s of shots) await draft(project.id, s.id);
      const each = tier?.estimates?.video_draft?.seconds;
      toast({ title: `Making ${plural(shots.length, "video")}`, text: each ? `${sentenceCase(roughDuration(each * shots.length))} in all. Each lands on its card.` : "Each lands on its card.", tone: "accent" });
    }, "Couldn't start the videos");

  const anySteps = !!(steps.drawStills || steps.makeVideos || steps.rewrite || steps.writeList || steps.writeStory);
  // On the canvas the board's frame carries its name: only the first steps show here, when there are any.
  if (!title && !anySteps) return null;
  return (
    <header className={cx("mp-board__head", !title && "mp-board__head--steps")}>
      {title && <div className="mp-board__title">
        {renaming ? (
          <Input
            inline
            autoFocus
            className="mp-board__rename"
            aria-label="Board name"
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") {
                setName(board.board.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <h2 className="mp-board__name" onDoubleClick={() => setRenaming(true)}>
            {board.board.name}
          </h2>
        )}
        <span className="mp-board__count">{count ? plural(count, "card") : "Empty"}</span>
        {!renaming && <Button size="s" variant="quiet" iconOnly icon={<Pencil />} aria-label="Rename board" title="Rename" onClick={() => setRenaming(true)} />}
        {renaming && <Button size="s" variant="quiet" iconOnly icon={<Check />} aria-label="Save the name" onMouseDown={(e) => e.preventDefault()} onClick={save} />}
      </div>}
      <div className="mp-board__actions">
        {steps.drawStills && (
          <Button size="s" variant="primary" icon={<Wand2 />} busy={busy} onClick={() => void drawStills(steps.drawStills!)}>
            Draw the stills
          </Button>
        )}
        {steps.makeVideos && (
          <Button size="s" variant="primary" icon={<Clapperboard />} busy={busy} onClick={() => void makeVideos(steps.makeVideos!)}>
            {steps.makeVideos.length === 1 ? "Make the video" : "Make the videos"}
          </Button>
        )}
        {steps.rewrite && (
          <Button size="s" variant="quiet" icon={<RefreshCw />} disabled={busy} onClick={() => setRewriteOpen(true)}>
            Rewrite shot list
          </Button>
        )}
        {steps.writeList && (
          <Button size="s" variant="primary" busy={busy} onClick={() => void run(() => storyboard(project.id), "Couldn't write the shot list")}>
            Write the shot list
          </Button>
        )}
        {steps.writeStory && (
          <Button size="s" variant="primary" busy={busy} onClick={() => void run(() => storyboard(project.id), "Couldn't write the story")}>
            Write the story
          </Button>
        )}
        {variant === "single" && (
          <Button
            size="s"
            variant="quiet"
            icon={<Plus />}
            onClick={async () => {
              const id = await boardActions.addBoard();
              if (id) focusBoard(id);
            }}
          >
            New board
          </Button>
        )}
      </div>
      <Dialog open={rewriteOpen} onClose={() => !busy && setRewriteOpen(false)} width={480}>
        <h2 className="dialog__title">Rewrite the shot list?</h2>
        <p className="dialog__text">Locked shots keep their place, stills and takes. The new shot list fills the other slots, then adds any remaining shots. Takes for replaced shots are removed.</p>
        <div className="dialog__actions">
          <Button onClick={() => setRewriteOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            busy={busy}
            onClick={() =>
              void run(async () => {
                await storyboard(project.id);
                setRewriteOpen(false);
              }, "Couldn't rewrite the shot list")
            }
          >
            Rewrite shot list
          </Button>
        </div>
      </Dialog>
    </header>
  );
}

function WritingLine({ job, project }: { job: Job; project: Project }) {
  const now = useNow(1000, job.status === "running");
  const what = project.template === "what_if" ? "Writing your story" : "Writing the shot list";
  return (
    <div className="mp-board__status" role="status">
      <span className="pulse" />
      {/* A running text job's stage is "Writing" too, so only its time follows. */}
      {job.status === "queued" ? jobStatusLine(job) : [what, jobElapsed(job, now)].filter(Boolean).join(", ")}
    </div>
  );
}

function FailedText({ job, project }: { job: Job; project: Project }) {
  const { storyboard } = useEngine();
  return (
    <div className="mp-board__notice">
      <Notice
        tone="bad"
        title={project.template === "what_if" ? "Couldn't write the story" : "Couldn't write the shot list"}
        actions={
          <Button size="s" onClick={() => void storyboard(project.id).catch((e) => toast({ title: "Couldn't start", text: String(e), tone: "bad" }))}>
            Try again
          </Button>
        }
      >
        {failureText(job)}
      </Notice>
    </div>
  );
}

function EmptyBoard({ project, main, single, steps }: { project: Project; main: boolean; single: boolean; steps: FirstSteps }) {
  if (main && project.template === "what_if" && !project.shots.length)
    return (
      <div className="mp-empty">
        <div className="mp-empty__title">{steps.writing ? "Writing your story" : "Your story starts here"}</div>
        <p className="mp-empty__text">An ordinary moment, an impossible change, then its consequence.</p>
      </div>
    );
  if (main && FILMS.has(project.template) && !project.shots.length)
    return (
      <div className="mp-empty">
        <div className="mp-empty__title">No shots yet</div>
        <p className="mp-empty__text">Nightshift writes a shot list from your brief, then draws a still for each shot. Or make your own with the panel on the left.</p>
      </div>
    );
  if (single)
    return (
      <div className="mp-empty">
        <div className="mp-empty__title">Nothing here yet</div>
        {/* A quick shot whose shot was deleted makes no new ones: only uploads land here. */}
        <p className="mp-empty__text">{makeBlocked(project) ? "Upload a photo, a song or a voiceover with the panel on the left." : "Write a prompt on the left to make your first image, or upload a photo."}</p>
      </div>
    );
  return <div className="mp-empty mp-empty--drop">Drop cards here</div>;
}

// ---------------------------------------------------------------- first steps

interface FirstSteps {
  writing?: Job;
  failedText?: Job;
  /** Timeline shots that have words but no still yet. */
  drawStills?: Shot[];
  /** Timeline shots with a still and no video yet, once every still is drawn. */
  makeVideos?: Shot[];
  rewrite?: boolean;
  writeList?: boolean;
  writeStory?: boolean;
}

/** What a new project's main board offers before anything else: the stills of its shot list, or its story. */
export function firstSteps(project: Project, jobs: Job[], main: boolean): FirstSteps {
  if (!main) return {};
  const writing = jobs.find((j) => j.step === "text" && isActive(j));
  const running = jobs.some(isActive);
  const film = FILMS.has(project.template);
  const missing = timelineShots(project).filter((s) => !s.stillAssetId && s.prompt.trim());
  const stillOnly = timelineShots(project).filter((s) => s.stillAssetId && !project.takes.some((t) => t.shotId === s.id));
  const failedText = !writing && !project.shots.length ? jobs.filter((j) => j.step === "text" && j.status !== "cancelled").at(-1) : undefined;
  return {
    ...(writing ? { writing } : {}),
    ...(failedText?.status === "failed" ? { failedText } : {}),
    ...(film && !running && missing.length ? { drawStills: missing, rewrite: true } : {}),
    ...(film && !running && !missing.length && stillOnly.length ? { makeVideos: stillOnly } : {}),
    writeList: film && !project.shots.length && !writing,
    writeStory: project.template === "what_if" && !project.shots.length && !writing,
  };
}

// ---------------------------------------------------------------- masonry

function hasFiles(e: DragEvent<HTMLElement>): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
}

/** How many columns of at least `min` pixels fit in the element. Three until it is measured. */
function useColumns(ref: RefObject<HTMLElement | null>, min: number): number {
  const [columns, setColumns] = useState(3);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const style = getComputedStyle(el);
      const width = el.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      if (width > 0) setColumns(Math.max(1, Math.min(8, Math.floor((width + GAP) / (min + GAP)))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, min]);
  return columns;
}

/** A card's height in column widths: its picture (a shot in its own shape) and its caption line. */
function cardHeight(item: CanvasItem, ratio: number): number {
  if (item.kind === "audio") return 0.3;
  const r = item.kind === "image" ? imageRatio(item, ratio) : item.shot.aspect ? ASPECT_RATIO[item.shot.aspect] : ratio;
  return 1 / r + 0.16;
}

/**
 * Cards in reading order, each into the shortest column so far. Rows read left to right, and wide and tall pictures
 * pack without gaps.
 */
export function masonry<T>(items: T[], columns: number, height: (item: T) => number): T[][] {
  const cols = Array.from({ length: Math.max(1, columns) }, () => ({ h: 0, items: [] as T[] }));
  for (const item of items) {
    const col = cols.reduce((a, b) => (b.h < a.h - 1e-6 ? b : a));
    col.items.push(item);
    col.h += height(item);
  }
  return cols.map((c) => c.items);
}
