/** A take that lands and replaces a pick the user had is told apart from every other change of a pick. */
import type { Project, Shot, Take } from "@nightshift/contract";
import { describe, expect, it } from "vitest";
import { replacedPicks } from "./freshPicks";

const shot = (o: Partial<Shot> = {}): Shot => ({ id: "s", index: 0, prompt: "A ferry", durationSec: 4, stillAssetId: "still", locked: false, ...o });
const take = (id: string, rung: Take["rung"] = "draft", extra: Partial<Take> = {}): Take => ({ id, shotId: "s", rung, seed: 1, jobId: `job_${id}`, videoAssetId: `v_${id}`, ...extra });
const project = (s: Shot, takes: Take[]): Pick<Project, "shots" | "takes"> => ({ shots: [s], takes });

describe("replaced picks", () => {
  it("a take that landed and took over a picked take, or its final", () => {
    expect(replacedPicks(project(shot({ chosenDraftId: "t1" }), [take("t1")]), project(shot({ chosenDraftId: "t2" }), [take("t1"), take("t2")])).get("s")).toEqual({ takeId: "t2", previous: { chosenDraftId: "t1" } });
    const finished = project(shot({ chosenDraftId: "t1", chosenFinalId: "f1" }), [take("t1"), take("f1", "final", { parentTakeId: "t1" })]);
    expect(replacedPicks(finished, project(shot({ chosenDraftId: "t2" }), [])).get("s")?.previous).toEqual({ chosenDraftId: "t1", chosenFinalId: "f1" });
  });

  it("not a first take, a take after a still the user picked, or a take picked by hand", () => {
    expect(replacedPicks(project(shot(), []), project(shot({ chosenDraftId: "t1" }), [take("t1")])).size).toBe(0);
    expect(replacedPicks(project(shot({ chosenDraftId: "t1", useStill: true }), [take("t1")]), project(shot({ chosenDraftId: "t2" }), [])).size).toBe(0);
    expect(replacedPicks(project(shot({ chosenDraftId: "t1" }), [take("t1"), take("t2")]), project(shot({ chosenDraftId: "t2" }), [])).size).toBe(0);
  });
});
