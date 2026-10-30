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
    expect(firstSteps(seeded, [], true)).toMatchObject({ drawStills: seeded.shots, rewrite: true });
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
});
