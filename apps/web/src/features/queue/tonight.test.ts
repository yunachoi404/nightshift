/** Tonight's finals in the order the engine runs them: in groups that share a model, each group's finals in the order queued. */
import type { Job } from "@nightshift/contract";
import { describe, expect, it } from "vitest";
import { groupName, nightTurn, tonightGroups } from "./tonight";

let minute = 0;
function final(id: string, model: string | undefined, nightGroup: number | undefined, extra: Partial<Job> = {}): Job {
  const step = model === "MiniMax H3" ? "video_final_remaster" : "video_final_same_take";
  return {
    id, projectId: "prj_1", step, mode: "overnight", status: "queued", progress: 0, outputAssetIds: [],
    createdAt: new Date(Date.UTC(2026, 9, 30, 21, ++minute)).toISOString(),
    ...(model ? { model } : {}), ...(nightGroup !== undefined ? { nightGroup } : {}), ...extra,
  };
}
const ids = (groups: ReturnType<typeof tonightGroups>) => groups.map((g) => [groupName(g), ...g.jobs.map((j) => j.id)]);

describe("tonight's groups", () => {
  it("lowest group first, each group's finals in the order queued, and nothing but queued finals for the night", () => {
    const jobs = [
      final("l1", "LTX-2.5", 1),
      final("h1", "MiniMax H3", 2),
      final("l2", "LTX-2.5", 1),
      final("h2", "MiniMax H3", 2),
      final("done", "LTX-2.5", 1, { status: "done" }),
      final("now", "LTX-2.5", undefined, { mode: "now" }),
    ];
    expect(ids(tonightGroups(jobs))).toEqual([
      ["LTX-2.5", "l1", "l2"],
      ["MiniMax H3", "h1", "h2"],
    ]);
  });

  it("the group on the GPU goes first, as the engine finishes it before starting another", () => {
    const jobs = [final("l1", "LTX-2.5", 1), final("h1", "MiniMax H3", 2), final("h2", "MiniMax H3", 2, { status: "running", startedAt: new Date().toISOString() })];
    expect(nightTurn(jobs)).toBe(2);
    expect(ids(tonightGroups(jobs, nightTurn(jobs)))).toEqual([
      ["MiniMax H3", "h1"],
      ["LTX-2.5", "l1"],
    ]);
  });

  it("the same model twice is two groups when one started before the other was queued", () => {
    const jobs = [final("l2", "LTX-2.5", 3), final("h1", "MiniMax H3", 2), final("h2", "MiniMax H3", 2)];
    expect(ids(tonightGroups(jobs))).toEqual([
      ["MiniMax H3", "h1", "h2"],
      ["LTX-2.5", "l2"],
    ]);
  });

  it("a group without a model is named by what its finals are; a final without a group stands alone at the end", () => {
    const jobs = [final("old1", undefined, undefined), final("s1", undefined, 4), final("old2", undefined, undefined, { step: "video_final_remaster" })];
    expect(ids(tonightGroups(jobs))).toEqual([
      ["Same take", "s1"],
      ["Same take", "old1"],
      ["Remaster", "old2"],
    ]);
  });
});
