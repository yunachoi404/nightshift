/** Tonight's finals in the order the engine runs them: in groups that share a model, each group's finals in the order queued. */
import type { Job } from "@nightshift/contract";
import { describe, expect, it } from "vitest";
import { groupName, nightTurn, tonightGroups, tonightTally } from "./tonight";

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

  it("a group without a model is named by what its finals are; a final without a group runs at the end", () => {
    const jobs = [final("old1", undefined, undefined), final("s1", undefined, 4), final("old2", undefined, undefined, { step: "video_final_remaster" })];
    expect(ids(tonightGroups(jobs))).toEqual([
      ["Same take", "s1", "old1"],
      ["Remaster", "old2"],
    ]);
  });

  it("groups of the same model that run back to back read as one: the model loads once", () => {
    // The dogfood night: 2 LTX finals left of the group on the GPU, then 20 queued after it started, shown as two
    // "LTX-2.5, so the model loads once" groups.
    const first = Array.from({ length: 3 }, (_, i) => final(`a${i}`, "LTX-2.5", 1, i === 0 ? { status: "running", startedAt: new Date().toISOString() } : {}));
    const second = Array.from({ length: 20 }, (_, i) => final(`b${i}`, "LTX-2.5", 9));
    const groups = tonightGroups([...first, ...second], nightTurn([...first, ...second]));
    expect(groups.map((g) => [groupName(g), g.jobs.length])).toEqual([["LTX-2.5", 22]]);
    // Another model between them keeps them apart, as the model loads again.
    const h3 = final("h1", "MiniMax H3", 5);
    expect(tonightGroups([...first, h3, ...second], 1).map((g) => [groupName(g), g.jobs.length])).toEqual([
      ["LTX-2.5", 2],
      ["MiniMax H3", 1],
      ["LTX-2.5", 20],
    ]);
  });
});

describe("tonight's tally", () => {
  // Local times, as the night window is set on the user's clock.
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();
  const night = { startAt: "23:00", endAt: "07:00" };
  const jobs = [
    final("done_tonight", "LTX-2.5", 1, { status: "done", finishedAt: new Date(at(30, 23, 40)).toISOString() }),
    final("done_last_night", "LTX-2.5", 1, { status: "done", finishedAt: new Date(at(30, 2, 0)).toISOString() }),
    final("failed", "LTX-2.5", 1, { status: "failed", finishedAt: new Date(at(31, 0, 10)).toISOString() }),
    final("running", "LTX-2.5", 1, { status: "running", progress: 0.4 }),
    final("q1", "LTX-2.5", 1),
    final("q2", "MiniMax H3", 2),
    final("now", "LTX-2.5", undefined, { mode: "now", status: "done", finishedAt: new Date(at(31, 0, 5)).toISOString() }),
  ];

  it("counts the finals done since the window opened, after midnight too, the one rendering and those queued", () => {
    const tally = tonightTally(jobs, night, at(31, 1, 0));
    expect(tally.done).toBe(1);
    expect(tally.running?.id).toBe("running");
    expect(tally.queued).toBe(2);
  });

  it("counts nothing done before the window opens, so last night's finals never fill tonight's bar", () => {
    expect(tonightTally(jobs, night, at(30, 20, 0)).done).toBe(0);
    expect(tonightTally(jobs, undefined, at(31, 1, 0)).done).toBe(0);
  });
});
