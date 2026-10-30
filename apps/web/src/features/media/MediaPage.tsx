/**
 * Media: everything a project has made, as cards on boards, with the prompt panel on the left that makes new ones. One
 * board (most projects) fills the page: the single board view. More boards sit on a canvas (pan, zoom, boards moved by
 * their title). A strip at the foot says what is on the timeline, and takes drops.
 */
import type { Project } from "@nightshift/contract";
import { Film } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import { Link, useParams } from "react-router";
import { useEngine, useProject, useProjectJobs } from "@/store/engine";
import { useInstalledTier } from "@/store/tier";
import { Tag, cx, toast } from "@/ui/primitives";
import { plural, timecode } from "@/lib/format";
import { useBoardActions } from "./canvas/boardActions";
import { MediaContext, useMedia, useProjectEdit, type ImageTool, type MediaCtx } from "./context";
import { CanvasView } from "./canvas/CanvasView";
import { BoardView } from "./BoardView";
import { CardDialog } from "./CardDialog";
import { PromptPanel, initialPanel, needsSource, sourceImage, toolBlocked, type PanelState } from "./PromptPanel";
import { canvas, cutDuration, cutShots, isCanvasDrag, makeBlocked, placeOnTimeline, readDrag, soundOnTimeline, type CanvasBoard } from "./items";
import "./mediapage.css";

/** The project's media board and its tools. */
export function MediaPage() {
  const { id } = useParams();
  const project = useProject(id);
  if (!project) return null;
  return <ProjectMedia key={project.id} project={project} />;
}

function ProjectMedia({ project }: { project: Project }) {
  const jobs = useProjectJobs(project.id);
  const { client, refreshProject } = useEngine();
  const tier = useInstalledTier();
  const edit = useProjectEdit(project.id);
  const boardActions = useBoardActions(project);
  const boards = useMemo(() => canvas(project), [project]);
  const [current, setCurrent] = useState(boards[0]!.board.id);
  const currentBoardId = boards.some((b) => b.board.id === current) ? current : boards[0]!.board.id;
  const [panel, setPanel] = useState<PanelState>(() => ({ ...initialPanel, tool: (["image", "video", "effect", "camera_move"] as const).find((t) => !toolBlocked(tier, t)) ?? "image" }));
  const [openId, setOpenId] = useState<string | null>(null);

  const tools = !makeBlocked(project) && !toolBlocked(tier, panel.tool);
  const picking = tools && (panel.choosing || (needsSource(panel.tool) && !sourceImage(project, panel.source)));
  // The card the panel's tool starts from, marked on the board while the tool uses an image.
  const sourceCardId = tools && panel.tool !== "image" && sourceImage(project, panel.source) ? (panel.sourceCard ?? panel.source) : undefined;

  // Escape stops choosing an image.
  useEffect(() => {
    if (!panel.choosing) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPanel((s) => ({ ...s, choosing: false }));
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel.choosing]);

  const upload = useCallback<MediaCtx["upload"]>(
    async (files, boardId, role) => {
      const ids: string[] = [];
      for (const file of files) {
        const audio = file.type.startsWith("audio");
        const image = file.type.startsWith("image");
        if ((!audio && !image) || (role === "reference" && !image) || (role && role !== "reference" && !audio)) {
          toast({ title: `Couldn't add ${file.name}`, text: role === "reference" ? "Choose an image." : role ? "Choose an audio file." : "Add images, songs or voiceovers.", tone: "bad" });
          continue;
        }
        try {
          const asset = await client.uploadAsset(project.id, file, { role: role ?? (audio ? "music" : "reference"), boardId });
          ids.push(asset.id);
        } catch (e) {
          toast({ title: `Couldn't upload ${file.name}`, text: e instanceof Error ? e.message : String(e), tone: "bad" });
        }
      }
      if (ids.length) await refreshProject(project.id).catch(() => undefined);
      return ids;
    },
    [client, refreshProject, project.id],
  );

  // The canvas keeps each board's body until its board changes; the body reads the page through the context.
  const renderBoard = useCallback((b: CanvasBoard) => <BoardView board={b} variant="canvas" header={false} />, []);

  const ctx = useMemo<MediaCtx>(
    () => ({
      project,
      jobs,
      picking,
      sourceCardId,
      pickSource: (assetId, cardId) => setPanel((s) => ({ ...s, source: assetId, sourceCard: cardId ?? assetId, choosing: false })),
      openCard: setOpenId,
      withImage: (assetId: string, tool: ImageTool, cardId?: string) => setPanel((s) => ({ ...s, tool, source: assetId, sourceCard: cardId ?? assetId, choosing: false })),
      currentBoardId,
      focusBoard: setCurrent,
      edit,
      boardActions,
      upload,
    }),
    [project, jobs, picking, sourceCardId, currentBoardId, edit, boardActions, upload],
  );

  return (
    <MediaContext.Provider value={ctx}>
      <div className={cx("mp", picking && "mp--picking")}>
        <PromptPanel state={panel} onChange={setPanel} boards={boards} />
        <div className="mp-main">
          <div className={cx("mp-canvas", boards.length > 1 && "mp-canvas--boards")}>
            {boards.length === 1 ? <BoardView board={boards[0]!} variant="single" /> : <CanvasView project={project} boards={boards} renderBoard={renderBoard} currentBoardId={currentBoardId} onFocusBoard={setCurrent} />}
          </div>
          <TimelineStrip />
        </div>
      </div>
      <CardDialog shotId={openId} onClose={() => setOpenId(null)} />
    </MediaContext.Provider>
  );
}

/** What is on the timeline, a way to the editor, and a drop target that adds cards to the end of the cut. */
function TimelineStrip() {
  const { project, edit } = useMedia();
  const [over, setOver] = useState(false);
  const shots = cutShots(project);
  const seconds = cutDuration(project);
  const sound = (role: "music" | "voice") => project.assets.some((a) => a.kind === "audio" && a.role === role && soundOnTimeline(project, a));
  const onDrop = (e: DragEvent) => {
    setOver(false);
    const payload = readDrag(e);
    if (!payload) return;
    e.preventDefault();
    void edit((p) => placeOnTimeline(p, payload.items));
  };
  return (
    <div
      className={cx("mp-strip", over && "mp-strip--over")}
      onDragOver={(e) => {
        if (!isCanvasDrag(e)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <Film className="mp-strip__icon" />
      <span className="mp-strip__text">
        On the timeline: {plural(shots.length, "shot")}, {timecode(seconds, false)}
      </span>
      {sound("music") && <Tag>Music</Tag>}
      {sound("voice") && <Tag>Voice</Tag>}
      <span className="mp-strip__hint">{over ? "Drop to add to the end" : "Drag cards here to add them"}</span>
      <Link to={`/p/${project.id}/editor`} className="btn btn--s">
        Open editor
      </Link>
    </div>
  );
}
