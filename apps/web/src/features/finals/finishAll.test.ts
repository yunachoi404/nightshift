/** Finishing every pick at once takes the cut's picked takes that have no final yet, and nothing else. */
import type { Asset, Job, Project, Shot, Take, TierSummary } from "@nightshift/contract";
import { describe, expect, it } from "vitest";
import { canFinish, finalKindFor, finalSecondsFor, unfinishedPicks } from "./finishAll";

const iso = (minute: number) => new Date(Date.UTC(2026, 10, 1, 3, minute)).toISOString();
const shot = (id: string, index: number, o: Partial<Shot> = {}): Shot => ({ id, index, prompt: `Shot ${id}`, durationSec: 4, stillAssetId: `still_${id}`, chosenDraftId: `draft_${id}`, locked: false, ...o });
const draft = (shotId: string, minute: number): Take => ({ id: `draft_${shotId}`, shotId, rung: "draft", seed: 1, jobId: "j", videoAssetId: `v_${shotId}` });
const video = (id: string, minute: number): Asset => ({ id, kind: "video", path: `${id}.mp4`, durationSec: 4, createdAt: iso(minute) });
const still = (id: string): Asset => ({ id, kind: "image", path: `${id}.png`, createdAt: iso(0) });

/** Six shots: a, b and f wait for a final; c has one; d's final is queued; e is a still; g sits on its board only. */
function project(): Project {
  const ids = ["a", "b", "c", "d", "e", "f", "g"];
  return {
    id: "p",
    name: "Ghost Shift",
    template: "micro_drama",
    aspect: "9:16",
    brief: {},
    shots: [
      shot("a", 0),
      shot("b", 1),
      shot("c", 2, { chosenFinalId: "final_c" }),
      shot("d", 3),
      shot("e", 4, { chosenDraftId: undefined }),
      shot("f", 5),
      shot("g", 6, { onTimeline: false }),
    ],
    takes: [...["a", "b", "c", "d", "f", "g"].map((s, i) => draft(s, i + 1)), { id: "final_c", shotId: "c", rung: "final", finalKind: "same_take", parentTakeId: "draft_c", seed: 1, jobId: "j", videoAssetId: "v_final_c" }],
    assets: [...ids.map((s) => still(`still_${s}`)), ...["a", "b", "c", "d", "f", "g"].map((s, i) => video(`v_${s}`, i + 1)), video("v_final_c", 9)],
    timeline: null,
    createdAt: iso(0),
    updatedAt: iso(0),
  };
}
const queuedFinal: Job = { id: "job_d", projectId: "p", shotId: "d", step: "video_final_same_take", mode: "overnight", status: "queued", progress: 0, outputAssetIds: [], createdAt: iso(10) };

describe("finishing every pick", () => {
  it("takes the cut's picked takes without a final, none queued, in timeline order", () => {
    expect(unfinishedPicks(project(), [queuedFinal]).map((s) => s.id)).toEqual(["a", "b", "f"]);
  });

  it("leaves out a still restored over its take, and a take that is not the pick", () => {
    const p = project();
    p.shots[0] = { ...p.shots[0]!, useStill: true };
    expect(canFinish(p, p.shots[0]!, [])).toBe(false);
    p.shots[1] = { ...p.shots[1]!, chosenDraftId: undefined };
    expect(canFinish(p, p.shots[1]!, [])).toBe(false);
    expect(unfinishedPicks(p, [queuedFinal]).map((s) => s.id)).toEqual(["f"]);
  });

  it("makes the same take where the setup can, else a remaster, else none", () => {
    expect(finalKindFor({ steps: ["video_final_same_take", "video_final_remaster"] })).toBe("same_take");
    expect(finalKindFor({ steps: ["video_final_remaster"] })).toBe("remaster");
    expect(finalKindFor({ steps: ["still", "video_draft"] })).toBeNull();
    // A setup not known yet offers the same take, as the card does.
    expect(finalKindFor(null)).toBe("same_take");
  });

  it("times a What if? film as the Queue does: its long-take final takes about as long as a shot's", () => {
    const tier = { estimates: { video_final_same_take: { peakGb: 56, seconds: 288, measured: true } } } as unknown as TierSummary;
    const p = project();
    expect(finalSecondsFor(p, p.shots[0]!, tier, "same_take")).toBe(288);
    // A What if? film's own shot is the one with keyframes.
    const beats = [1, 2, 3].map((n) => ({ id: `beat_${n}`, prompt: `Beat ${n}`, line: "" }));
    const film = { ...p, template: "what_if" as const, shots: [{ ...p.shots[0]!, keyframes: beats }] };
    expect(finalSecondsFor(film, film.shots[0]!, tier, "same_take")).toBe(288);
  });
});
