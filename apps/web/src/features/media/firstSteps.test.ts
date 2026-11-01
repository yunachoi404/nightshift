import type { Job, Project, Shot } from "@nightshift/contract";
import { describe, expect, it } from "vitest";
import { firstSteps } from "./BoardView";

const shot = (id: string, o: Partial<Shot> = {}): Shot => ({ id, index: 0, prompt: `Shot ${id}`, durationSec: 4, locked: false, ...o });
const project = (shots: Shot[], o: Partial<Project> = {}): Project => ({
  id: "p",
  name: "Ad",
  template: "product_ad",
  aspect: "9:16",
  brief: {},
  shots: shots.map((s, index) => ({ ...s, index })),
  takes: [],
  assets: [],
  timeline: null,
  createdAt: "2026-10-30T00:00:00.000Z",
  updatedAt: "2026-10-30T00:00:00.000Z",
  ...o,
});
const job = (o: Partial<Job>): Job => ({ id: "j", projectId: "p", step: "still", mode: "now", status: "running", progress: 0, outputAssetIds: [], createdAt: "2026-10-30T00:00:00.000Z", ...o });

describe("a preset's first steps", () => {
  it("draws the stills first, then makes the videos, then nothing", () => {
    const seeded = project([shot("a"), shot("b")]);
    expect(firstSteps(seeded, [], true)).toMatchObject({ drawStills: seeded.shots });
    expect(firstSteps(seeded, [], true).makeVideos).toBeUndefined();

    const stills = project([shot("a", { stillAssetId: "s1" }), shot("b", { stillAssetId: "s2" })]);
    expect(firstSteps(stills, [], true).makeVideos?.map((s) => s.id)).toEqual(["a", "b"]);
    expect(firstSteps(stills, [], true).drawStills).toBeUndefined();

    const drafted = project([shot("a", { stillAssetId: "s1" }), shot("b", { stillAssetId: "s2" })], {
      takes: [{ id: "t", shotId: "a", rung: "draft", seed: 1, jobId: "j", videoAssetId: "v" }],
    });
    expect(firstSteps(drafted, [], true).makeVideos?.map((s) => s.id)).toEqual(["b"]);
  });

  it("offers nothing while work runs, off the main board, for blank projects or for shots off the timeline", () => {
    const stills = project([shot("a", { stillAssetId: "s1" })]);
    expect(firstSteps(stills, [job({ shotId: "a" })], true).makeVideos).toBeUndefined();
    expect(firstSteps(stills, [], false).makeVideos).toBeUndefined();
    expect(firstSteps(project([shot("a", { stillAssetId: "s1" })], { template: "blank" }), [], true).makeVideos).toBeUndefined();
    expect(firstSteps(project([shot("a", { stillAssetId: "s1", onTimeline: false })]), [], true).makeVideos).toBeUndefined();
  });

  it("only a shot's own work holds back its step: a voiceover or another shot's take on its way does not", () => {
    // The dogfood night: a queued voiceover hid Make the videos, so five videos took five cards.
    const stills = project([shot("a", { stillAssetId: "s1" }), shot("b", { stillAssetId: "s2" }), shot("c", { stillAssetId: "s3" })]);
    const voice = job({ step: "voice", status: "queued" });
    expect(firstSteps(stills, [voice], true).makeVideos?.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(firstSteps(stills, [voice, job({ step: "video_draft", shotId: "b", status: "queued" })], true).makeVideos?.map((s) => s.id)).toEqual(["a", "c"]);

    // Stills: the ones on their way are left out, the rest can be drawn; the videos wait for every still.
    const half = project([shot("a"), shot("b"), shot("c", { stillAssetId: "s3" })]);
    const drawing = [voice, job({ step: "still", shotId: "a", status: "running" })];
    expect(firstSteps(half, drawing, true).drawStills?.map((s) => s.id)).toEqual(["b"]);
    expect(firstSteps(half, drawing, true).makeVideos).toBeUndefined();

    // While the shot list is written, the shots are about to change: nothing.
    expect(firstSteps(stills, [job({ step: "text", status: "running" })], true).makeVideos).toBeUndefined();
  });
});

describe("a film's shot list before the writer wrote it", () => {
  const seeded = (o: Partial<Project> = {}) => project([shot("a"), shot("b")], { shotList: { by: "template" }, ...o });

  it("offers writing it first, beside drawing the template's stills", () => {
    const steps = firstSteps(seeded(), [], true);
    expect(steps).toMatchObject({ writeFirst: true, drawStills: seeded().shots });
    expect(steps.writerNote).toBeUndefined();
    // Once written, only the stills.
    expect(firstSteps(seeded({ shotList: { by: "writer" } }), [], true).writeFirst).toBeUndefined();
    // Projects from before the engine kept who wrote the list keep their first steps.
    expect(firstSteps(project([shot("a")]), [], true).writeFirst).toBeUndefined();
  });

  it("not while the writer works, without a writer, off the main board, or once something is made from the template's list", () => {
    expect(firstSteps(seeded(), [job({ step: "text", status: "queued" })], true).writeFirst).toBeUndefined();
    expect(firstSteps(seeded(), [], true, false)).toMatchObject({ drawStills: seeded().shots });
    expect(firstSteps(seeded(), [], true, false).writeFirst).toBeUndefined();
    expect(firstSteps(seeded(), [], false)).toEqual({});
    const drawn = seeded({ shots: [shot("a", { stillAssetId: "s1" }), shot("b", { index: 1 })] });
    expect(firstSteps(drawn, [], true).writeFirst).toBeUndefined();
    expect(firstSteps(drawn, [], true).drawStills?.map((s) => s.id)).toEqual(["b"]);
  });

  it("shows why the writer's answer was not used, offering the template's stills beside trying again", () => {
    const note = "The writer tried 3 times, but its shot list did not fit this template.";
    const fell = firstSteps(seeded({ shotList: { by: "template", note } }), [], true);
    expect(fell).toMatchObject({ writerNote: note });
    expect(fell.noteStills?.map((s) => s.id)).toEqual(["a", "b"]);
    expect(fell.writeFirst).toBeUndefined();
    expect(fell.drawStills).toBeUndefined();
    // A still already on its way is not drawn again.
    expect(firstSteps(seeded({ shotList: { by: "template", note } }), [job({ shotId: "a", status: "queued" })], true).noteStills?.map((s) => s.id)).toEqual(["b"]);
    // A rewrite that missed keeps the writer's list: its note shows, and drawing its stills stays the main action.
    const kept = firstSteps(project([shot("a")], { shotList: { by: "writer", note } }), [], true);
    expect(kept.writerNote).toBe(note);
    expect(kept.noteStills).toBeUndefined();
    expect(kept.drawStills?.map((s) => s.id)).toEqual(["a"]);
    // Not while the writer tries again.
    expect(firstSteps(seeded({ shotList: { by: "template", note } }), [job({ step: "text" })], true).writerNote).toBeUndefined();
    // Not for templates with no shot list to write.
    expect(firstSteps(project([], { template: "blank", shotList: { by: "template", note } }), [], true).writerNote).toBeUndefined();
  });
});
