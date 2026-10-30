/**
 * The project's canvas as the UI reads it: boards of cards (one card per shot, showing its pick, with its history of
 * stills, drafts, effects and finals; uploaded images; songs and voiceovers), what is on the timeline, and the pure
 * edits that restore a version, put cards on the timeline or take them off. Shared by the Media canvas and the Editor's
 * media sidebar, so a drag means the same in both.
 */
import { projectBoards, quickEffects, quickMoves, type Asset, type Board, type DraftTool, type Job, type Project, type Shot, type Soundtrack, type StepId, type Take } from "@nightshift/contract";
import { id as newId } from "@/lib/ids";

/** One version in a shot's history: a still it had, a draft (plain, an effect or a camera move), or a final. */
export interface Version {
  key: string;
  rung: "still" | "draft" | "final";
  asset: Asset;
  take?: Take;
  /** The prompt it was made from, when known. */
  prompt?: string;
  tool?: DraftTool;
  /** When it landed. */
  createdAt: string;
  /** It is what the card shows and the cut uses. */
  pick: boolean;
}

export type CanvasItem =
  | { kind: "shot"; id: string; shot: Shot; label: string; history: Version[]; pick: Version | undefined; onTimeline: boolean; final: boolean }
  | { kind: "image"; id: string; asset: Asset; label: string }
  | { kind: "audio"; id: string; asset: Asset; role: "music" | "voice"; label: string; onTimeline: boolean };

export interface CanvasBoard {
  board: Board;
  items: CanvasItem[];
}

/** The canvas: every board with its cards, in order. One board means the single board view. */
export function canvas(project: Project): CanvasBoard[] {
  const shots = new Map(project.shots.map((s) => [s.id, s]));
  const assets = new Map(project.assets.map((a) => [a.id, a]));
  return projectBoards(project).map((board) => ({
    board,
    items: board.items.flatMap((itemId): CanvasItem[] => {
      const shot = shots.get(itemId);
      if (shot) return [shotItem(project, shot)];
      const asset = assets.get(itemId);
      if (!asset) return [];
      if (asset.kind === "audio") {
        const role = asset.role === "voice" ? "voice" : "music";
        return [{ kind: "audio", id: asset.id, asset, role, label: role === "voice" ? "Voice" : "Music", onTimeline: soundOnTimeline(project, asset) }];
      }
      const reference = project.references?.find((r) => r.assetId === asset.id);
      return [{ kind: "image", id: asset.id, asset, label: reference?.label ?? "Upload" }];
    }),
  }));
}

/** Every card on the canvas, by id. */
export function itemsById(project: Project): Map<string, CanvasItem> {
  return new Map(canvas(project).flatMap((b) => b.items.map((i) => [i.id, i] as const)));
}

export function shotItem(project: Project, shot: Shot): Extract<CanvasItem, { kind: "shot" }> {
  const history = shotHistory(project, shot);
  return { kind: "shot", id: shot.id, shot, label: shotLabel(project, shot, history), history, pick: history.find((v) => v.pick), onTimeline: shot.onTimeline !== false, final: !!shot.chosenFinalId };
}

/**
 * A shot's history, oldest first: every still it had (`stillHistory`, else its current still), every draft and every
 * final. Exactly one is the pick, chosen as the engine's cut chooses: a restored still (`useStill`), else the shown
 * final, else the picked draft, else the newest take, else the still. A quick shot's takes made before takes recorded
 * their tool carry the template's effect or camera move, so they are named and shown as what they are. The take itself
 * keeps no tool (`take.tool`), so another take of it stays on the template's own path.
 */
export function shotHistory(project: Project, shot: Shot): Version[] {
  const assets = new Map(project.assets.map((a) => [a.id, a]));
  const out: Version[] = [];
  const stills = shot.stillHistory?.length ? shot.stillHistory : shot.stillAssetId ? [{ assetId: shot.stillAssetId, prompt: undefined, createdAt: "" }] : [];
  for (const s of stills) {
    const asset = assets.get(s.assetId);
    if (asset) out.push({ key: `still-${asset.id}`, rung: "still", asset, ...(s.prompt ? { prompt: s.prompt } : {}), createdAt: s.createdAt || asset.createdAt, pick: false });
  }
  const legacy = templateTool(project, shot);
  for (const take of project.takes) {
    if (take.shotId !== shot.id || !take.videoAssetId) continue;
    const asset = assets.get(take.videoAssetId);
    if (!asset) continue;
    const tool = take.tool ?? legacy;
    out.push({ key: take.id, rung: take.rung, asset, take, ...(take.prompt ? { prompt: take.prompt } : {}), ...(tool ? { tool } : {}), createdAt: asset.createdAt, pick: false });
  }
  out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const still = out.find((v) => v.rung === "still" && v.asset.id === shot.stillAssetId);
  const takes = out.filter((v) => v.take);
  const pick =
    (shot.useStill ? still : undefined) ??
    takes.find((v) => v.rung === "final" && v.take!.id === shot.chosenFinalId) ??
    takes.find((v) => v.rung === "draft" && v.take!.id === shot.chosenDraftId) ??
    takes.findLast((v) => v.rung === "final") ??
    takes.findLast(() => true) ??
    still;
  if (pick) pick.pick = true;
  return out;
}

/**
 * Where a resting thumbnail of a version sits, in seconds. An effect or a camera move starts on the still it was made
 * from, so its first frame looks like that still: it rests on a late frame, where the change shows. Others rest on
 * their first frame (undefined).
 */
export function restingTime(version: Pick<Version, "tool" | "rung" | "asset">, fallbackSec: number): number | undefined {
  if (!version.tool || version.rung === "still") return undefined;
  return (version.asset.durationSec ?? fallbackSec) * 0.8;
}

/** The shot change that makes a version the pick. Send it as the shot's new fields in a PATCH of shots. */
export function restore(shot: Shot, version: Version): Shot {
  const next: Shot = { ...shot };
  if (version.rung === "still") {
    next.stillAssetId = version.asset.id;
    next.useStill = true;
  } else if (version.rung === "draft") {
    next.chosenDraftId = version.take!.id;
    next.useStill = false;
  } else if (version.take?.parentTakeId) {
    next.chosenDraftId = version.take.parentTakeId;
    next.chosenFinalId = version.take.id;
    next.useStill = false;
  }
  return next;
}

/** What a card is called: the pick's tool, else the start of the shot's prompt, else its place. */
export function shotLabel(project: Project, shot: Shot, history = shotHistory(project, shot)): string {
  const tool = history.find((v) => v.pick)?.tool ?? templateTool(project, shot);
  if (tool) return toolLabel(tool);
  const words = shot.prompt.trim().replace(/\s+/g, " ");
  if (words) return words.length > 60 ? `${words.slice(0, 60).replace(/\s+\S*$/, "")}...` : words;
  return `Shot ${shot.index + 1}`;
}

/** What a quick shot's takes are made with when they record no tool: the template's effect or camera move. */
function templateTool(project: Pick<Project, "template" | "brief">, shot: Shot): DraftTool | undefined {
  if (project.template === "vfx_effect" && typeof project.brief.effect === "string") return { kind: "effect", effect: project.brief.effect };
  if (project.template === "camera_move") return { kind: "camera_move", move: String(shot.cameraMove ?? project.brief.move ?? "") };
  return undefined;
}

/** "Effect, Freeze", "Camera move, Dolly in". */
export function toolLabel(tool: DraftTool): string {
  if (tool.kind === "effect") return `Effect, ${quickEffects.find((e) => e.id === tool.effect)?.label ?? "custom"}`;
  return `Camera move, ${quickMoves.find((m) => m.id === tool.move)?.label ?? "custom"}`;
}

/**
 * Whether a song or voiceover is the one the cut uses: on a cut edited by hand, a track of it on the timeline; else the
 * soundtrack's pick, else the newest of its role.
 */
export function soundOnTimeline(project: Pick<Project, "assets" | "soundtrack" | "timeline">, asset: Asset): boolean {
  const role = asset.role === "voice" ? "voice" : "music";
  if (project.timeline?.edited) return project.timeline.audio.some((a) => a.assetId === asset.id && a.role === role);
  const pick = project.soundtrack?.[role];
  if (pick === null) return false;
  if (pick && project.assets.some((a) => a.id === pick)) return pick === asset.id;
  const newest = project.assets.filter((a) => a.kind === "audio" && a.role === role).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return newest?.id === asset.id;
}

// ---------------------------------------------------------------- drag and drop

/** The drag type of canvas cards. The payload is JSON: the ids of the dragged cards (shots, images, audio). */
export const DRAG_TYPE = "application/x-nightshift-media";

export interface DragPayload {
  items: string[];
  /** The board they were dragged from, when one card or a whole board was dragged out of a board. */
  fromBoard?: string;
}

export function setDrag(e: { dataTransfer: DataTransfer | null }, payload: DragPayload): void {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(payload));
  e.dataTransfer.effectAllowed = "copyMove";
}

export function readDrag(e: { dataTransfer: DataTransfer | null }): DragPayload | undefined {
  try {
    const raw = e.dataTransfer?.getData(DRAG_TYPE);
    const parsed = raw ? (JSON.parse(raw) as DragPayload) : undefined;
    return parsed && Array.isArray(parsed.items) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a drag carries canvas cards. `getData` is empty until the drop, so this reads the types. */
export function isCanvasDrag(e: { dataTransfer: DataTransfer | null }): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes(DRAG_TYPE);
}

/** Whether a drag carries files from the desktop. Their names and types are only known at the drop. */
export function isFileDrag(e: { dataTransfer: DataTransfer | null }): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
}

/**
 * The image a card hands to a tool: a shot's current still, or an uploaded image itself. Undefined for a song, a
 * voiceover, or a shot with no still yet.
 */
export function imageOfCard(project: Pick<Project, "shots" | "assets">, cardId: string): string | undefined {
  const shot = project.shots.find((s) => s.id === cardId);
  if (shot) return shot.stillAssetId && project.assets.some((a) => a.id === shot.stillAssetId) ? shot.stillAssetId : undefined;
  return project.assets.find((a) => a.id === cardId && a.kind === "image")?.id;
}

// ---------------------------------------------------------------- timeline edits (pure)

/** What a PATCH sends to change the timeline: the shots in order, the canvas kept as it was, and maybe the soundtrack. */
export interface TimelineEdit {
  shots: Shot[];
  boards: Board[];
  soundtrack?: Soundtrack;
}

/** The timeline's shots, in order. */
export function cutShots(project: Pick<Project, "shots">): Shot[] {
  return [...project.shots].filter((s) => s.onTimeline !== false).sort((a, b) => a.index - b.index);
}

/** Shots laid out with `cut` first (the timeline, in order) and the rest after, indexed by position. */
function ordered(project: Pick<Project, "shots">, cut: Shot[]): Shot[] {
  const inCut = new Set(cut.map((s) => s.id));
  const rest = [...project.shots].sort((a, b) => a.index - b.index).filter((s) => !inCut.has(s.id));
  return [...cut.map((s) => ({ ...s, onTimeline: true })), ...rest].map((s, index) => ({ ...s, index }));
}

/**
 * Put cards on the timeline at `at` (a position among its shots; the end when absent), in the order given. A shot goes
 * there (moved, if it was on it already). An image becomes a new shot of that still, filed after the image on its
 * board. A song or a voiceover becomes the soundtrack's pick for its role.
 */
export function placeOnTimeline(project: Project, itemIds: string[], at?: number): TimelineEdit {
  let boards = projectBoards(project);
  const soundtrack: Soundtrack = { ...project.soundtrack };
  let sound = false;
  const shots = new Map(project.shots.map((s) => [s.id, s]));
  const incoming: Shot[] = [];
  for (const itemId of itemIds) {
    const shot = shots.get(itemId);
    if (shot) {
      if (!incoming.some((s) => s.id === shot.id)) incoming.push(shot);
      continue;
    }
    const asset = project.assets.find((a) => a.id === itemId);
    if (!asset) continue;
    if (asset.kind === "audio") {
      soundtrack[asset.role === "voice" ? "voice" : "music"] = asset.id;
      sound = true;
    } else if (asset.kind === "image") {
      const still: Shot = { id: newId("sht"), index: 0, prompt: "", cameraMove: "static", durationSec: 4, stillAssetId: asset.id, locked: false, onTimeline: true };
      incoming.push(still);
      boards = boards.map((b) => {
        const i = b.items.indexOf(asset.id);
        return i < 0 ? b : { ...b, items: [...b.items.slice(0, i + 1), still.id, ...b.items.slice(i + 1)] };
      });
    }
  }
  const moving = new Set(incoming.map((s) => s.id));
  const cut = cutShots(project).filter((s) => !moving.has(s.id));
  const pos = at === undefined ? cut.length : Math.max(0, Math.min(cut.length, at));
  cut.splice(pos, 0, ...incoming);
  const all = { shots: [...project.shots, ...incoming.filter((s) => !shots.has(s.id))] };
  return { shots: ordered(all, cut), boards, ...(sound ? { soundtrack } : {}) };
}

/** Take a shot off the timeline. It stays on its board. */
export function takeOffTimeline(project: Project, shotId: string): TimelineEdit {
  const cut = cutShots(project).filter((s) => s.id !== shotId);
  const shots = ordered(project, cut).map((s) => (s.id === shotId ? { ...s, onTimeline: false } : s));
  return { shots, boards: projectBoards(project) };
}

/** Move a timeline shot to position `to` (before the shot now at `to`) among the timeline's shots. */
export function moveOnTimeline(project: Project, shotId: string, to: number): TimelineEdit {
  const from = cutShots(project).findIndex((s) => s.id === shotId);
  return placeOnTimeline(project, [shotId], from >= 0 && to > from ? to - 1 : to);
}

/** Take the song or the voiceover off the timeline. */
export function soundOff(project: Project, role: "music" | "voice"): Pick<TimelineEdit, "soundtrack"> {
  return { soundtrack: { ...project.soundtrack, [role]: null } };
}

/** The canvas with a card moved to `boardId` at `index` (the end when absent). Other boards keep their order. */
export function moveCard(project: Project, itemId: string, boardId: string, index?: number): Board[] {
  const boards = projectBoards(project).map((b) => ({ ...b, items: b.items.filter((id) => id !== itemId) }));
  const target = boards.find((b) => b.id === boardId);
  if (!target) return projectBoards(project);
  const at = index === undefined ? target.items.length : Math.max(0, Math.min(target.items.length, index));
  target.items.splice(at, 0, itemId);
  return boards;
}

// ---------------------------------------------------------------- card helpers

/** What a version is, in a word or two: "Still", "Draft", "Effect, Freeze", "Camera move, Dolly in", "Final, same take". */
export function versionLabel(project: Pick<Project, "template" | "brief">, shot: Shot, version: Pick<Version, "rung" | "tool" | "take">): string {
  if (version.rung === "still") return "Still";
  if (version.rung === "final") return version.take?.finalKind === "remaster" ? "Final, remaster" : "Final, same take";
  // Quick shots made before the tools: their takes are the template's effect or camera move.
  const tool = version.tool ?? templateTool(project, shot);
  if (tool) return toolLabel(tool);
  if (project.template === "what_if") return "Film";
  return "Draft";
}

/** Whether making `version` the pick changes anything. A draft whose final is shown is already the pick, as its final. */
export function canRestore(shot: Shot, version: Version): boolean {
  if (version.pick) return false;
  const next = restore(shot, version);
  return next.stillAssetId !== shot.stillAssetId || !!next.useStill !== !!shot.useStill || next.chosenDraftId !== shot.chosenDraftId || next.chosenFinalId !== shot.chosenFinalId;
}

/** How long the cut runs, in seconds: its shots added up. */
export function cutDuration(project: Pick<Project, "shots">): number {
  return cutShots(project).reduce((sum, s) => sum + s.durationSec, 0);
}

/** The project without a card: a shot leaves the shots (the cut closes up) and every board. */
export function withoutCard(project: Project, itemId: string): TimelineEdit {
  const boards = projectBoards(project).map((b) => ({ ...b, items: b.items.filter((id) => id !== itemId) }));
  const shots = [...project.shots]
    .sort((a, b) => a.index - b.index)
    .filter((s) => s.id !== itemId)
    .map((s, index) => ({ ...s, index }));
  return { shots, boards };
}

/**
 * Where each dragged card goes when dropped before position `at` of a board listing `items`: one move per card, in
 * order, each index counted after the card left its old place (as `moveCard` counts). Cards land side by side, in the
 * order dragged.
 */
export function dropMoves(items: readonly string[], dragged: readonly string[], at: number): Array<{ id: string; index: number }> {
  const list = [...items];
  let pos = Math.max(0, Math.min(list.length, at));
  const moves: Array<{ id: string; index: number }> = [];
  for (const id of dragged) {
    const from = list.indexOf(id);
    if (from >= 0) {
      list.splice(from, 1);
      if (from < pos) pos -= 1;
    }
    moves.push({ id, index: pos });
    list.splice(pos, 0, id);
    pos += 1;
  }
  return moves;
}

// ---------------------------------------------------------------- a card's jobs

/** The jobs that make a version of a card: stills, takes of every kind, and finals. */
export const TAKE_STEPS: StepId[] = ["video_draft", "effect_end_frame", "video_effect", "camera_layout", "video_camera_move", "video_what_if"];
export const FINAL_STEPS: StepId[] = ["video_final_same_take", "video_final_remaster"];
export const CARD_STEPS: StepId[] = ["still", ...TAKE_STEPS, ...FINAL_STEPS];

/** How to run a failed job again: the same request, or the story of a What if? film. */
export type Retry = { kind: "still" } | { kind: "draft" } | { kind: "final"; finalKind: "same_take" | "remaster" } | { kind: "story" };

/**
 * How to run a failed job again. Only what is known exactly runs again: a still or a plain draft of a shot, a final of
 * its picked draft. A What if? card goes to its story, where each beat and the film are made. Undefined when the job
 * carried a choice it does not record (an effect, a camera move, a quick shot's own take): the card opens, so the user
 * chooses again.
 */
export function retryFor(project: Pick<Project, "template">, shot: Shot, step: Job["step"]): Retry | undefined {
  if (project.template === "what_if") return { kind: "story" };
  // A quick shot's still is its photo, and its takes are the template's effect or camera move, or a tool's.
  const quick = project.template === "camera_move" || project.template === "vfx_effect";
  switch (step) {
    case "still":
      return quick ? undefined : { kind: "still" };
    case "video_draft":
      return quick ? undefined : { kind: "draft" };
    case "video_final_same_take":
    case "video_final_remaster":
      return shot.chosenDraftId ? { kind: "final", finalKind: step === "video_final_remaster" ? "remaster" : "same_take" } : undefined;
    default:
      return undefined;
  }
}

/**
 * Why the project's tools cannot make new cards, or undefined when they can. The engine refuses `make` for a What if?
 * film and for a quick shot, which each make one shot.
 */
export function makeBlocked(project: Pick<Project, "template">): string | undefined {
  if (project.template === "what_if") return "A What if? film is one continuous shot. Start a new project to make more cards.";
  if (project.template === "camera_move" || project.template === "vfx_effect") return "This project turns one photo into one shot. Start a new project to use the tools.";
  return undefined;
}

/**
 * Whether a PATCH changes what the cut is made of: which shots are on the timeline, in what order, with which picture
 * and for how long. A cut edited by hand keeps its clips through such a change until it is re-cut.
 */
export function changesCut(project: Pick<Project, "shots">, patch: { shots?: Shot[] | undefined }): boolean {
  if (!patch.shots) return false;
  const key = (shots: Shot[]) => JSON.stringify(cutShots({ shots }).map((s) => [s.id, s.durationSec, s.stillAssetId ?? null, !!s.useStill, s.chosenDraftId ?? null, s.chosenFinalId ?? null]));
  return key(patch.shots) !== key(project.shots);
}

/** The shots with one shot changed, for a PATCH. */
export function shotPatch(project: Pick<Project, "shots">, shotId: string, change: Partial<Shot> | ((shot: Shot) => Shot)): { shots: Shot[] } {
  return { shots: project.shots.map((s) => (s.id === shotId ? (typeof change === "function" ? change(s) : { ...s, ...change }) : s)) };
}
