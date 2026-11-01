import { isExtraCard, ownShot, shotTemplate, type Project, type Shot } from "@nightshift/contract";
import { describe, expect, it } from "vitest";
import { keepOwnShot, setOwnShot } from "../src/projects/own-shot.js";

const shot = (id: string, index: number, extra: Partial<Shot> = {}): Shot => ({ id, index, prompt: id, durationSec: 4, locked: false, ...extra });
const keyframes = [0, 1, 2, 3].map((i) => ({ id: `beat-${i}`, prompt: `beat ${i}`, line: "" }));
const project = (template: Project["template"], shots: Shot[], extra: Partial<Project> = {}): Project => ({
  id: "p", name: "p", template, aspect: "16:9", brief: {}, shots, takes: [], assets: [], timeline: null, createdAt: "", updatedAt: "", ...extra,
});

describe("a What if? film's or a quick shot's own shot", () => {
  it("is the shot with keyframes in a What if? film and the first shot in a quick shot; the others are extra cards", () => {
    const card = shot("card", 0, { onTimeline: false });
    const film = shot("film", 1, { keyframes });
    const whatIf = project("what_if", [card, film]);
    expect(ownShot(whatIf)).toBe(film);
    expect([isExtraCard(whatIf, card), isExtraCard(whatIf, film)]).toEqual([true, false]);
    expect([shotTemplate(whatIf, card), shotTemplate(whatIf, film)]).toEqual(["blank", "what_if"]);
    // Before its story the film has no own shot: every card is an extra.
    expect(ownShot(project("what_if", [card]))).toBeUndefined();

    const quick = project("camera_move", [shot("b", 1), shot("a", 0)]);
    expect(ownShot(quick)?.id).toBe("a");
    expect(shotTemplate(quick, quick.shots[0]!)).toBe("blank");
    // Other templates have no own shot: every shot follows the project's template.
    const film2 = project("cinematic_shot", [shot("a", 0), shot("b", 1, { onTimeline: false })]);
    expect([ownShot(film2), isExtraCard(film2, film2.shots[1]!), shotTemplate(film2, film2.shots[1]!)]).toEqual([undefined, false, "cinematic_shot"]);
  });

  it("is set first, takes the place of the one it replaces with its takes, and leaves the extra cards as they were", () => {
    const p = project("what_if", [shot("card", 0, { onTimeline: false }), shot("old", 1, { keyframes })], {
      takes: [{ id: "t1", shotId: "old", rung: "draft", seed: 1, jobId: "j" }, { id: "t2", shotId: "card", rung: "draft", seed: 1, jobId: "j" }],
      boards: [{ id: "b", name: "Film", items: ["card", "old", "song"] }],
    });
    setOwnShot(p, shot("new", 0, { keyframes }));
    expect(p.shots.map((s) => [s.id, s.index])).toEqual([["new", 0], ["card", 1]]);
    expect(p.takes.map((t) => t.id)).toEqual(["t2"]);
    expect(p.boards).toEqual([{ id: "b", name: "Film", items: ["card", "new", "song"] }]);
    // The first own shot opens the first board.
    const fresh = project("camera_move", [], { boards: [{ id: "b", name: "Camera move", items: ["song"] }] });
    setOwnShot(fresh, shot("own", 0));
    expect(fresh.boards![0]!.items).toEqual(["own", "song"]);
  });

  it("stays, first, through a PATCH, and only it goes on the timeline", () => {
    const before = project("camera_move", [shot("own", 0), shot("card", 1, { onTimeline: false })]);
    const after = structuredClone(before);
    after.shots = [after.shots[1]!, after.shots[0]!];
    keepOwnShot(after, before);
    expect(after.shots.map((s) => [s.id, s.index])).toEqual([["own", 0], ["card", 1]]);
    expect(() => keepOwnShot({ ...before, shots: [before.shots[1]!] }, before)).toThrow("This project's own shot stays.");
    expect(() => keepOwnShot({ ...before, shots: before.shots.map((s) => ({ ...s, onTimeline: true })) }, before)).toThrow("Only this project's own shot goes on its timeline.");
    // A shot an old quick shot put on its timeline (an uploaded image) may stay there, and come off it, but not go back.
    const old = project("camera_move", [shot("own", 0), shot("image", 1)]);
    keepOwnShot(structuredClone(old), old);
    const off = { ...old, shots: [old.shots[0]!, { ...old.shots[1]!, onTimeline: false }] };
    keepOwnShot(structuredClone(off), old);
    expect(() => keepOwnShot(structuredClone(old), off)).toThrow("Only this project's own shot goes on its timeline.");
    const film = project("what_if", [shot("film", 0, { keyframes })]);
    expect(() => keepOwnShot({ ...film, shots: [shot("film", 0)] }, film)).toThrow("A What-if film needs four keyframes.");
  });
});
