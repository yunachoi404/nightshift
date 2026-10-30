import type { Asset, Board, Project } from "./index.js";

/**
 * The project's canvas. Every shot is a card (its pick, with its history of stills, drafts, effects and finals), and
 * so are uploaded images, songs and voiceovers. Boards hold cards in order. The engine, the UI and the UI's mock engine
 * all read the canvas through `projectBoards`, so a project made before boards, or a shot no board lists yet, shows
 * the same everywhere.
 */

/** The board a project's shots start on, when the project does not list its own. */
export const MAIN_BOARD_ID = "board_main";

type CanvasProject = Pick<Project, "template" | "brief" | "shots" | "assets" | "boards">;

/**
 * Whether an asset is its own card: an uploaded image (a reference, a photo), a song or a voiceover. Renders that
 * belong to a shot (stills, drafts, finals, effect end frames, camera layouts), latents and exports are not. A quick
 * shot's photo is its shot's still, and a What if? film's opening photo is its first beat and its still, so each shows
 * there, not twice.
 */
export function isBoardAsset(project: Pick<Project, "template" | "brief">, asset: Asset): boolean {
  if (asset.kind === "image") {
    if (asset.role !== "reference") return false;
    const photoShot = project.template === "camera_move" || project.template === "vfx_effect" || project.template === "what_if";
    return !(photoShot && project.brief.photoAssetId === asset.id);
  }
  return asset.kind === "audio" && (asset.role === "music" || asset.role === "voice");
}

/** The name of the board a project's shots start on. */
export function mainBoardName(template: Project["template"]): string {
  switch (template) {
    case "blank":
      return "Board 1";
    case "what_if":
      return "Film";
    case "camera_move":
      return "Camera move";
    case "vfx_effect":
      return "Effect";
    default:
      return "Shots";
  }
}

/**
 * A project made before boards opens as one board with all its cards: its shots, then its uploads, then its sound. So
 * an old project shows the single board view.
 */
function defaultBoards(project: CanvasProject, assets: Asset[]): Board[] {
  const shots = [...project.shots].sort((a, b) => a.index - b.index).map((s) => s.id);
  return [{ id: MAIN_BOARD_ID, name: mainBoardName(project.template), items: [...shots, ...assets.map((a) => a.id)] }];
}

/**
 * The canvas as it shows: the project's boards (or the default one), each listing only cards that exist, each card on
 * one board. Cards no board lists join the first board: a new shot from a shot list rewrite, an upload, a song. There
 * is always at least one board.
 */
export function projectBoards(project: CanvasProject): Board[] {
  const assets = project.assets.filter((a) => isBoardAsset(project, a)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const known = new Set([...project.shots.map((s) => s.id), ...assets.map((a) => a.id)]);
  const placed = new Set<string>();
  const boards: Board[] = (project.boards ?? defaultBoards(project, assets)).map((b) => ({
    ...b,
    items: b.items.filter((id) => {
      if (!known.has(id) || placed.has(id)) return false;
      placed.add(id);
      return true;
    }),
  }));
  if (!boards.length) boards.push({ id: MAIN_BOARD_ID, name: mainBoardName(project.template), items: [] });
  const first = boards[0]!;
  for (const shot of [...project.shots].sort((a, b) => a.index - b.index)) if (!placed.has(shot.id)) first.items.push(shot.id);
  for (const asset of assets) if (!placed.has(asset.id)) first.items.push(asset.id);
  return boards;
}

/**
 * The canvas with one card moved to the end of a board: `boardId` when the canvas has it, else the first board. Filing
 * a new card never adds a board, so a one-board project stays the single board view.
 */
export function placeItem(project: CanvasProject, itemId: string, o: { boardId?: string | undefined } = {}): Board[] {
  const boards = projectBoards(project).map((b) => ({ ...b, items: b.items.filter((id) => id !== itemId) }));
  const target = (o.boardId ? boards.find((b) => b.id === o.boardId) : undefined) ?? boards[0]!;
  target.items.push(itemId);
  return boards;
}

/** The board a card is on, if any. */
export function boardOf(boards: readonly Board[], itemId: string): Board | undefined {
  return boards.find((b) => b.items.includes(itemId));
}
