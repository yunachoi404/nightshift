/**
 * The queue as the engine runs it: the job on the GPU and its time left, the CPU's work beside it, the line for now in
 * run order with when each job should start, and tonight's finals in their model groups, placed in the night window.
 */
import type { Job, TierSummary } from "@nightshift/contract";
import { describe, expect, it } from "vitest";
import { estimateSeconds, planQueue, resultPath, secondsLeft, tonightSeconds } from "./plan";

let minute = 0;
function job(id: string, step: Job["step"], extra: Partial<Job> = {}): Job {
  return { id, projectId: "prj_1", step, mode: "now", status: "queued", progress: 0, outputAssetIds: [], createdAt: new Date(Date.UTC(2026, 9, 31, 12, ++minute)).toISOString(), ...extra };
}
const tier = { tier: "nvidia-24-offload", estimates: { still: { seconds: 30, peakGb: 8, measured: true }, video_draft: { seconds: 60, peakGb: 12, measured: true }, video_final_same_take: { seconds: 600, peakGb: 20, measured: true }, video_final_remaster: { seconds: 1200, peakGb: 22, measured: true } } } as unknown as TierSummary;
// Local times: the night window is set on the user's clock.
const at = (day: number, hour: number, min = 0) => new Date(2026, 9, day, hour, min).getTime();
const night = { enabled: true, startAt: "23:00", endAt: "07:00" };

describe("estimates", () => {
  it("come from the setup, with a fixed time for exports and the timing of songs", () => {
    expect(estimateSeconds(job("a", "still"), tier)).toBe(30);
    expect(estimateSeconds(job("b", "export"), tier)).toBe(40);
    expect(estimateSeconds(job("c", "music", { analysis: true }), tier)).toBe(10);
    expect(estimateSeconds(job("d", "voice"), null)).toBe(60);
  });

  it("time left starts from the estimate and goes by the job's own pace once it is under way", () => {
    const now = at(31, 12);
    const started = (sec: number) => new Date(now - sec * 1000).toISOString();
    const left = (progress: number, sec: number) => secondsLeft(job("a", "video_draft", { status: "running", progress, startedAt: started(sec) }), tier, now);
    // Early on, the estimate less the time run: a model loading says little of its pace.
    expect(left(0.05, 20)).toBe(40);
    expect(left(0.15, 20)).toBe(40);
    // From half way, its own pace.
    expect(left(0.5, 40)).toBe(40);
    expect(left(0.8, 80)).toBeCloseTo(20);
    // Between, some of each.
    expect(left(0.325, 30)).toBeCloseTo(0.5 * ((30 * 0.675) / 0.325) + 0.5 * 30);
    // The estimate ran out before the job got going: nothing is promised.
    expect(left(0.05, 90)).toBeNull();
  });
});

describe("the plan", () => {
  it("the GPU's job, the CPU's beside it, then the line for now: quick work, then finals to run now, each with its start", () => {
    const now = at(31, 12);
    const jobs = [
      job("final_now", "video_final_same_take", { model: "LTX-2.5" }),
      job("draft", "video_draft", { status: "running", progress: 0.5, startedAt: new Date(now - 30_000).toISOString() }),
      job("export", "export"),
      job("still", "still"),
      job("timing", "music", { analysis: true, status: "running", progress: 0.2 }),
      job("tonight", "video_final_remaster", { mode: "overnight", nightGroup: 1 }),
      job("old", "still", { status: "done", finishedAt: new Date(now - 60_000).toISOString() }),
      job("older", "still", { status: "failed", finishedAt: new Date(now - 120_000).toISOString() }),
    ];
    const plan = planQueue(jobs, { now, tier, night, away: false });
    expect(plan.gpu?.id).toBe("draft");
    expect(plan.gpuLeft).toBe(30);
    expect(plan.cpu.map((j) => j.id)).toEqual(["timing", "export"]);
    expect(plan.next.map((s) => [s.job.id, (s.at! - now) / 1000])).toEqual([
      ["still", 30],
      ["final_now", 60],
    ]);
    expect(plan.nextSeconds).toBe(630);
    expect(plan.finished.map((j) => j.id)).toEqual(["old", "older"]);
  });

  it("says no start time while the GPU is away", () => {
    const plan = planQueue([job("still", "still"), job("f", "video_final_same_take", { mode: "overnight", nightGroup: 1 })], { now: at(31, 12), tier, night, away: true });
    expect(plan.next.map((s) => s.at)).toEqual([null]);
    expect(plan.tonight.flatMap((g) => g.slots.map((s) => s.at))).toEqual([null]);
  });

  it("places tonight's finals from when the window opens, in their model groups", () => {
    const now = at(31, 20);
    const jobs = [job("l1", "video_final_same_take", { mode: "overnight", model: "LTX-2.5", nightGroup: 1 }), job("h1", "video_final_remaster", { mode: "overnight", model: "MiniMax H3", nightGroup: 2 }), job("l2", "video_final_same_take", { mode: "overnight", model: "LTX-2.5", nightGroup: 1 })];
    const plan = planQueue(jobs, { now, tier, night, away: false });
    expect(plan.nightOpen).toBe(false);
    expect(plan.tonight.map((g) => [g.name, ...g.slots.map((s) => [s.job.id, new Date(s.at!).toTimeString().slice(0, 5)])])).toEqual([
      ["LTX-2.5", ["l1", "23:00"], ["l2", "23:10"]],
      ["MiniMax H3", ["h1", "23:20"]],
    ]);
    expect(plan.tonightSeconds).toBe(2400);
  });

  it("while the window is open, tonight's finals follow the work for now; those that do not fit wait for the next night", () => {
    const now = at(31, 6, 30);
    const jobs = [job("still", "still"), job("l1", "video_final_same_take", { mode: "overnight", nightGroup: 1 }), job("l2", "video_final_same_take", { mode: "overnight", nightGroup: 1 }), job("l3", "video_final_same_take", { mode: "overnight", nightGroup: 1 })];
    const plan = planQueue(jobs, { now, tier, night, away: false });
    expect(plan.nightOpen).toBe(true);
    const slots = plan.tonight[0]!.slots;
    expect(slots.map((s) => [s.job.id, new Date(s.at!).toTimeString().slice(0, 5), !!s.later])).toEqual([
      ["l1", "06:30", false],
      ["l2", "06:40", false],
      ["l3", "06:50", false],
    ]);
    const crowded = planQueue([...jobs, job("l4", "video_final_same_take", { mode: "overnight", nightGroup: 1 })], { now, tier, night, away: false });
    const l4 = crowded.tonight[0]!.slots.at(-1)!;
    expect([new Date(l4.at!).getDate(), new Date(l4.at!).toTimeString().slice(0, 5), l4.later]).toEqual([31, "23:00", true]);
  });

  it("with the night shift off, tonight's finals have no time", () => {
    const plan = planQueue([job("l1", "video_final_same_take", { mode: "overnight", nightGroup: 1 })], { now: at(31, 20), tier, night: { ...night, enabled: false }, away: false });
    expect(plan.tonight[0]!.slots[0]!.at).toBeNull();
  });

  it("counts tonight's work as the finals waiting and what is left of the one rendering", () => {
    const now = at(31, 23, 30);
    const jobs = [job("r", "video_final_same_take", { mode: "overnight", status: "running", progress: 0.5, startedAt: new Date(now - 300_000).toISOString() }), job("q", "video_final_remaster", { mode: "overnight" }), job("n", "video_final_remaster")];
    expect(tonightSeconds(jobs, tier, now)).toBe(1500);
  });
});

describe("a job's result", () => {
  const project = { shots: [{ id: "shot_1" }] } as never;
  it("is its card for a shot, the editor for a film's export, and the project for the rest", () => {
    expect(resultPath(job("a", "video_draft", { shotId: "shot_1" }), project)).toBe("/p/prj_1/media?card=shot_1");
    expect(resultPath(job("b", "export"), project)).toBe("/p/prj_1/editor");
    expect(resultPath(job("c", "music"), project)).toBe("/p/prj_1/media");
    expect(resultPath(job("d", "text"), project)).toBe("/p/prj_1");
    expect(resultPath(job("e", "still", { shotId: "shot_gone" }), project)).toBe("/p/prj_1");
  });
});
