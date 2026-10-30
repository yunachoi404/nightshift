/**
 * The canvas as the UI reads it: old projects open as one board, a card's pick follows the engine's rules, restoring
 * a version is one shot change, and the timeline edits keep the shots in order.
 */
import { MAIN_BOARD_ID, type Asset, type Project, type Shot, type Take } from "@nightshift/contract";
import { describe, expect, it } from "vitest";
import { canRestore, canvas, changesCut, cutDuration, cutShots, dropMoves, imageOfCard, makeBlocked, moveCard, moveOnTimeline, placeOnTimeline, restingTime, restore, retryFor, shotHistory, shotPatch, soundOnTimeline, takeOffTimeline, versionLabel, withoutCard } from "./items";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 30, 9, minute)).toISOString();
const image = (id: string, minute: number, extra: Partial<Asset> = {}): Asset => ({ id, kind: "image", path: `${id}.png`, createdAt: at(minute), ...extra });
const video = (id: string, minute: number): Asset => ({ id, kind: "video", path: `${id}.mp4`, durationSec: 4, createdAt: at(minute) });
const audio = (id: string, role: "music" | "voice", minute: number): Asset => ({ id, kind: "audio", role, path: `${id}.mp3`, createdAt: at(minute) });
const shot = (id: string, index: number, extra: Partial<Shot> = {}): Shot => ({ id, index, prompt: `Shot ${id}`, cameraMove: "static", durationSec: 4, locked: false, ...extra });
const take = (id: string, shotId: string, rung: "draft" | "final", videoAssetId: string, extra: Partial<Take> = {}): Take => ({ id, shotId, rung, seed: 1, videoAssetId, jobId: `job_${id}`, ...extra });

/** A film made before boards: two shots, the first with two takes and a final, an upload and a song. */
function film(): Project {
  return {
    id: "prj_old",
    name: "Old film",
    template: "cinematic_shot",
    aspect: "16:9",
    brief: {},
    shots: [shot("s2", 1, { stillAssetId: "still_2" }), shot("s1", 0, { stillAssetId: "still_1", chosenDraftId: "t1", chosenFinalId: "f1" })],
    takes: [take("t1", "s1", "draft", "v_t1"), take("t2", "s1", "draft", "v_t2"), take("f1", "s1", "final", "v_f1", { parentTakeId: "t1", finalKind: "same_take" })],
    assets: [image("still_1", 1), image("still_2", 2), video("v_t1", 3), video("v_t2", 4), video("v_f1", 5), image("upload", 6, { role: "reference" }), audio("song", "music", 7)],
    timeline: null,
    createdAt: at(0),
    updatedAt: at(7),
  };
}

const pickOf = (p: Project, s: Shot) => shotHistory(p, s).find((v) => v.pick)!;

describe("canvas", () => {
  it("opens a project made before boards as one board: its shots in order, then its uploads and sound", () => {
    const boards = canvas(film());
    expect(boards).toHaveLength(1);
    expect(boards[0]!.board).toMatchObject({ id: MAIN_BOARD_ID, name: "Shots" });
    expect(boards[0]!.items.map((i) => [i.kind, i.id])).toEqual([
      ["shot", "s1"],
      ["shot", "s2"],
      ["image", "upload"],
      ["audio", "song"],
    ]);
    const first = boards[0]!.items[0]!;
    expect(first.kind === "shot" && first.final && first.onTimeline).toBe(true);
    const song = boards[0]!.items[3]!;
    expect(song.kind === "audio" && song.onTimeline).toBe(true);
  });

  it("files cards no board lists on the first board", () => {
    const p = { ...film(), boards: [{ id: "b1", name: "Opening", items: ["s2"] }, { id: "b2", name: "Moods", items: [] }] };
    const boards = canvas(p);
    expect(boards.map((b) => b.items.map((i) => i.id))).toEqual([["s2", "s1", "upload", "song"], []]);
  });

  it("shows a What if? film's opening photo as its film card's still, not as a card of its own", () => {
    // As NewProject makes it: the photo uploaded as a reference, then named in the brief. A board saved before lists it.
    const p: Project = {
      ...film(),
      template: "what_if",
      brief: { idea: "What if the tide never came back?", photoAssetId: "photo" },
      shots: [shot("film", 0, { stillAssetId: "photo" })],
      takes: [],
      assets: [image("photo", 1, { role: "reference" }), image("upload", 2, { role: "reference" })],
      boards: [{ id: MAIN_BOARD_ID, name: "Film", items: ["film", "photo", "upload"] }],
    };
    expect(canvas(p)[0]!.items.map((i) => [i.kind, i.id])).toEqual([
      ["shot", "film"],
      ["image", "upload"],
    ]);
  });
});

describe("shotHistory", () => {
  it("lists stills, drafts and finals oldest first, and the shown final is the pick", () => {
    const p = film();
    const s1 = p.shots.find((s) => s.id === "s1")!;
    const history = shotHistory(p, s1);
    expect(history.map((v) => v.key)).toEqual(["still-still_1", "t1", "t2", "f1"]);
    expect(history.filter((v) => v.pick).map((v) => v.key)).toEqual(["f1"]);
  });

  it("a restored still is the pick over every take", () => {
    const p = film();
    const s1 = { ...p.shots.find((s) => s.id === "s1")!, useStill: true };
    expect(pickOf(p, s1).key).toBe("still-still_1");
  });

  it("picks the chosen draft when no final is shown, else the newest take, else the still", () => {
    const p = film();
    const base = p.shots.find((s) => s.id === "s1")!;
    expect(pickOf(p, { ...base, chosenFinalId: undefined, chosenDraftId: "t2" }).key).toBe("t2");
    const noPicks = { ...p, takes: p.takes.filter((t) => t.rung === "draft") };
    expect(pickOf(noPicks, { ...base, chosenFinalId: undefined, chosenDraftId: undefined }).key).toBe("t2");
    expect(pickOf(p, p.shots.find((s) => s.id === "s2")!).key).toBe("still-still_2");
  });

  it("keeps every still a shot had, with its prompt", () => {
    const p = film();
    const s2 = { ...p.shots.find((s) => s.id === "s2")!, stillHistory: [{ assetId: "upload", createdAt: at(1) }, { assetId: "still_2", prompt: "A pier at dawn", createdAt: at(2) }] };
    const history = shotHistory(p, s2);
    expect(history.map((v) => [v.key, v.prompt])).toEqual([
      ["still-upload", undefined],
      ["still-still_2", "A pier at dawn"],
    ]);
    expect(history.find((v) => v.pick)?.key).toBe("still-still_2");
  });

  it("names each version by what made it", () => {
    const p = { ...film(), takes: [...film().takes, take("t3", "s1", "draft", "v_t2", { tool: { kind: "effect", effect: "freeze" } })] };
    const s1 = p.shots.find((s) => s.id === "s1")!;
    const labels = Object.fromEntries(shotHistory(p, s1).map((v) => [v.key, versionLabel(p, s1, v)]));
    expect(labels).toMatchObject({ "still-still_1": "Still", t1: "Draft", t3: "Effect, Freeze", f1: "Final, same take" });
    const quick: Project = { ...p, template: "camera_move", brief: { move: "dolly_in" } };
    expect(versionLabel(quick, { ...s1, cameraMove: "dolly_in" }, { rung: "draft" })).toBe("Camera move, Dolly in");
  });

  it("gives a quick shot's takes made before takes kept their tool the template's effect or move, to rest on its change", () => {
    const old: Project = { ...film(), template: "vfx_effect", brief: { effect: "freeze", photoAssetId: "still_1" } };
    const s1 = old.shots.find((s) => s.id === "s1")!;
    const history = shotHistory(old, s1);
    const takes = history.filter((v) => v.take);
    expect(takes.map((v) => [v.key, v.tool])).toEqual([
      ["t1", { kind: "effect", effect: "freeze" }],
      ["t2", { kind: "effect", effect: "freeze" }],
      ["f1", { kind: "effect", effect: "freeze" }],
    ]);
    // The take itself records no tool, so another take of it stays on the template's own path.
    expect(takes.every((v) => v.take!.tool === undefined)).toBe(true);
    expect(restingTime(takes[0]!, 4)).toBeCloseTo(3.2);
    expect(versionLabel(old, s1, takes[1]!)).toBe("Effect, Freeze");
    expect(history.find((v) => v.rung === "still")!.tool).toBeUndefined();

    const moved: Project = { ...film(), template: "camera_move", brief: { move: "dolly_in" } };
    const s = { ...moved.shots.find((x) => x.id === "s1")!, cameraMove: "dolly_zoom" };
    expect(shotHistory(moved, s).find((v) => v.key === "t2")!.tool).toEqual({ kind: "camera_move", move: "dolly_zoom" });
    // Other templates name their plain takes as drafts.
    expect(shotHistory(film(), s1).find((v) => v.key === "t2")!.tool).toBeUndefined();
  });
});

describe("restore", () => {
  const p = film();
  const s1 = p.shots.find((s) => s.id === "s1")!;
  const history = shotHistory(p, s1);
  const version = (key: string) => history.find((v) => v.key === key)!;

  it("a still becomes the still and the pick", () => {
    expect(restore(s1, version("still-still_1"))).toMatchObject({ stillAssetId: "still_1", useStill: true });
  });

  it("a draft becomes the chosen draft and the still steps back", () => {
    expect(restore({ ...s1, useStill: true }, version("t2"))).toMatchObject({ chosenDraftId: "t2", useStill: false });
  });

  it("a final picks its draft and itself", () => {
    expect(restore({ ...s1, chosenDraftId: "t2", chosenFinalId: undefined }, version("f1"))).toMatchObject({ chosenDraftId: "t1", chosenFinalId: "f1", useStill: false });
  });

  it("offers Restore only where it changes the pick", () => {
    expect(canRestore(s1, version("f1"))).toBe(false);
    // Take 1 is shown as its final already.
    expect(canRestore(s1, version("t1"))).toBe(false);
    expect(canRestore(s1, version("t2"))).toBe(true);
    expect(canRestore(s1, version("still-still_1"))).toBe(true);
  });
});

describe("timeline edits", () => {
  it("adds an image as a new still shot at the end, filed after the image on its board", () => {
    const p = { ...film(), shots: [...film().shots, shot("s3", 2, { onTimeline: false })] };
    const edit = placeOnTimeline(p, ["upload"]);
    const added = edit.shots.find((s) => s.stillAssetId === "upload")!;
    expect(added).toMatchObject({ onTimeline: true, index: 2, prompt: "" });
    expect(cutShots(edit).map((s) => s.id)).toEqual(["s1", "s2", added.id]);
    expect(edit.shots.find((s) => s.id === "s3")).toMatchObject({ onTimeline: false, index: 3 });
    expect(edit.boards[0]!.items).toEqual(["s1", "s2", "s3", "upload", added.id, "song"]);
    expect(edit.soundtrack).toBeUndefined();
  });

  it("puts a board-only shot on the timeline at a place, and a song becomes the soundtrack's pick", () => {
    const p = { ...film(), shots: [...film().shots, shot("s3", 2, { onTimeline: false })], assets: [...film().assets, audio("song2", "music", 8)] };
    const edit = placeOnTimeline(p, ["s3", "song"], 1);
    expect(cutShots(edit).map((s) => s.id)).toEqual(["s1", "s3", "s2"]);
    expect(edit.soundtrack).toEqual({ music: "song" });
    expect(soundOnTimeline({ ...p, ...edit }, p.assets.find((a) => a.id === "song")!)).toBe(true);
    // Without a pick the newest song plays.
    expect(soundOnTimeline(p, p.assets.find((a) => a.id === "song")!)).toBe(false);
  });

  it("on a cut edited by hand, a song or voiceover is on the timeline only when the cut plays it", () => {
    // The Nocturne ad: edited by hand before soundtracks, its voice taken off the cut, an older song in it.
    const p: Project = {
      ...film(),
      assets: [...film().assets, audio("voice", "voice", 8), audio("song2", "music", 9)],
      timeline: { clips: [], audio: [{ assetId: "song", role: "music", start: 0, gain: 0.8 }], captions: [], style: {}, edited: true },
    };
    const on = (id: string) => soundOnTimeline(p, p.assets.find((a) => a.id === id)!);
    expect([on("voice"), on("song"), on("song2")]).toEqual([false, true, false]);
    const item = canvas(p)[0]!.items.find((i) => i.id === "voice")!;
    expect(item.kind === "audio" && item.onTimeline).toBe(false);
  });

  it("knows a change to what the cut is made of from one that leaves the cut alone", () => {
    const p = film();
    expect(changesCut(p, shotPatch(p, "s1", { prompt: "New words" }))).toBe(false);
    expect(changesCut(p, { shots: undefined })).toBe(false);
    expect(changesCut(p, takeOffTimeline(p, "s1"))).toBe(true);
    expect(changesCut(p, shotPatch(p, "s1", { durationSec: 6 }))).toBe(true);
    expect(changesCut(p, shotPatch(p, "s1", { useStill: true }))).toBe(true);
    expect(changesCut(p, placeOnTimeline(p, ["s2"], 0))).toBe(true);
  });

  it("takes a shot off the timeline and keeps it on its board", () => {
    const p = film();
    const edit = takeOffTimeline(p, "s1");
    expect(cutShots(edit).map((s) => s.id)).toEqual(["s2"]);
    expect(edit.shots.find((s) => s.id === "s1")).toMatchObject({ onTimeline: false, index: 1 });
    expect(edit.boards[0]!.items).toContain("s1");
    expect(cutDuration(edit)).toBe(4);
  });

  it("moves a shot along the timeline, counting the place before it moves", () => {
    const p = { ...film(), shots: [shot("a", 0), shot("b", 1), shot("c", 2)] };
    expect(cutShots(moveOnTimeline(p, "a", 2)).map((s) => s.id)).toEqual(["b", "a", "c"]);
    expect(cutShots(moveOnTimeline(p, "a", 3)).map((s) => s.id)).toEqual(["b", "c", "a"]);
    expect(cutShots(moveOnTimeline(p, "c", 0)).map((s) => s.id)).toEqual(["c", "a", "b"]);
  });

  it("deletes a card from the shots and every board", () => {
    const p = film();
    const edit = withoutCard(p, "s1");
    expect(edit.shots.map((s) => [s.id, s.index])).toEqual([["s2", 0]]);
    expect(edit.boards[0]!.items).toEqual(["s2", "upload", "song"]);
  });
});

describe("moving cards", () => {
  it("moves a card to another board at a place", () => {
    const p = { ...film(), boards: [{ id: "b1", name: "One", items: ["s1", "s2", "upload"] }, { id: "b2", name: "Two", items: ["song"] }] };
    expect(moveCard(p, "s2", "b2", 0).map((b) => b.items)).toEqual([["s1", "upload"], ["s2", "song"]]);
    expect(moveCard(p, "s1", "b2").map((b) => b.items)).toEqual([["s2", "upload"], ["song", "s1"]]);
    expect(moveCard(p, "s1", "nowhere")).toEqual(canvas(p).map((b) => b.board));
  });

  it("counts a drop's place after the dragged cards leave theirs", () => {
    expect(dropMoves(["a", "b", "c", "d"], ["a"], 3)).toEqual([{ id: "a", index: 2 }]);
    expect(dropMoves(["a", "b", "c", "d"], ["d"], 0)).toEqual([{ id: "d", index: 0 }]);
    expect(dropMoves(["a", "b"], ["x", "y"], 1)).toEqual([
      { id: "x", index: 1 },
      { id: "y", index: 2 },
    ]);
  });
});

describe("trying again", () => {
  const p = film();
  const s1 = p.shots.find((s) => s.id === "s1")!;
  it("runs a failed still, plain draft or final again as it was", () => {
    expect(retryFor(p, s1, "still")).toEqual({ kind: "still" });
    expect(retryFor(p, s1, "video_draft")).toEqual({ kind: "draft" });
    expect(retryFor(p, s1, "video_final_remaster")).toEqual({ kind: "final", finalKind: "remaster" });
    expect(retryFor(p, { ...s1, chosenDraftId: undefined }, "video_final_same_take")).toBeUndefined();
  });

  it("opens the card for an effect or a camera move, whose choice the failed job does not keep", () => {
    // The pick is a Freeze, the failed job an Ignite: running the pick's effect again would make the wrong version.
    const withEffect = { ...p, takes: [...p.takes, take("t3", "s1", "draft", "v_t2", { tool: { kind: "effect", effect: "freeze" } })] };
    const picked = { ...s1, chosenDraftId: "t3", chosenFinalId: undefined, cameraMove: "crane_up" };
    for (const step of ["effect_end_frame", "video_effect", "camera_layout", "video_camera_move"] as const) expect(retryFor(withEffect, picked, step)).toBeUndefined();
    // A quick shot's failed take may have been a tool's, not its template's own effect or move.
    expect(retryFor({ ...p, template: "vfx_effect" }, s1, "effect_end_frame")).toBeUndefined();
    expect(retryFor({ ...p, template: "vfx_effect" }, s1, "video_effect")).toBeUndefined();
    expect(retryFor({ ...p, template: "camera_move" }, s1, "video_camera_move")).toBeUndefined();
    expect(retryFor({ ...p, template: "camera_move" }, s1, "still")).toBeUndefined();
  });

  it("sends a What if? card to its story, where the beat to redraw is chosen", () => {
    const whatIf = { ...p, template: "what_if" as const };
    expect(retryFor(whatIf, s1, "still")).toEqual({ kind: "story" });
    expect(retryFor(whatIf, s1, "video_what_if")).toEqual({ kind: "story" });
  });
});

describe("making new cards", () => {
  it("is refused for a What if? film and a quick shot, in plain words", () => {
    expect(makeBlocked({ template: "what_if" })).toBe("A What if? film is one continuous shot. Start a new project to make more cards.");
    expect(makeBlocked({ template: "camera_move" })).toBe("This project turns one photo into one shot. Start a new project to use the tools.");
    expect(makeBlocked({ template: "vfx_effect" })).toBe("This project turns one photo into one shot. Start a new project to use the tools.");
    expect(makeBlocked({ template: "blank" })).toBeUndefined();
    expect(makeBlocked({ template: "cinematic_shot" })).toBeUndefined();
  });
});

describe("resting thumbnails", () => {
  const asset = { id: "a", kind: "video" as const, path: "a.mp4", durationSec: 4, createdAt: "" };
  it("rest an effect or a camera move on a late frame, and anything else on its first", () => {
    expect(restingTime({ tool: { kind: "effect", effect: "freeze" }, rung: "draft", asset }, 4)).toBeCloseTo(3.2);
    expect(restingTime({ tool: { kind: "camera_move", move: "dolly_in" }, rung: "final", asset: { ...asset, durationSec: undefined } }, 5)).toBeCloseTo(4);
    expect(restingTime({ rung: "draft", asset }, 4)).toBeUndefined();
    expect(restingTime({ tool: { kind: "effect", effect: "freeze" }, rung: "still", asset }, 4)).toBeUndefined();
  });

  it("a card hands a tool its picture: a shot its current still, an upload itself, nothing for a song or a shot without one", () => {
    const p = film();
    p.shots.push(shot("s3", 2));
    expect(imageOfCard(p, "s1")).toBe("still_1");
    expect(imageOfCard(p, "upload")).toBe("upload");
    expect(imageOfCard(p, "song")).toBeUndefined();
    expect(imageOfCard(p, "s3")).toBeUndefined();
    expect(imageOfCard(p, "nothing")).toBeUndefined();
  });
});
