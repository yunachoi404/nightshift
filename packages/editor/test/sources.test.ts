import type { Asset, Project } from "@nightshift/contract";
import { describe, expect, it } from "vitest";
import { planTimeline } from "../src/timeline/plan.js";
import { audioAsset, shotSources } from "../src/timeline/sources.js";
import { audioAssetOf, fakeProject } from "./helpers.js";

/** Three shots with a final each; the second also has a still and a draft. */
function project(): Project {
  const { project } = fakeProject("cinematic_shot", [
    { kind: "video", length: 4, durationSec: 4 },
    { kind: "video", length: 4, durationSec: 4 },
    { kind: "video", length: 4, durationSec: 4 },
  ]);
  const at = "2026-10-20T00:00:00.000Z";
  project.assets.push({ id: "still1", kind: "image", path: "still1.png", createdAt: at }, { id: "draft1", kind: "video", path: "draft1.mp4", createdAt: at });
  project.takes.push({ id: "d1", shotId: "s1", rung: "draft", seed: 2, videoAssetId: "draft1", jobId: "j" });
  project.shots[1]!.stillAssetId = "still1";
  return project;
}

describe("shotSources", () => {
  it("leaves out shots kept on a board, out of the cut", () => {
    const p = project();
    p.shots[0]!.onTimeline = false;
    p.shots[2]!.onTimeline = true;
    expect(shotSources(p).map((s) => s.shot.id)).toEqual(["s1", "s2"]);
  });

  it("shows the still when the still is the shot's pick, and the take again once it is not", () => {
    const p = project();
    p.shots[1]!.useStill = true;
    expect(shotSources(p).map((s) => [s.shot.id, s.asset.id, s.rung])).toEqual([
      ["s0", "a0", "final"],
      ["s1", "still1", "still"],
      ["s2", "a2", "final"],
    ]);
    delete p.shots[1]!.useStill;
    delete p.shots[1]!.chosenFinalId;
    p.shots[1]!.chosenDraftId = "d1";
    expect(shotSources(p)[1]).toMatchObject({ asset: { id: "draft1" }, rung: "draft" });
  });

  it("a still pick without a still falls back to the takes", () => {
    const p = project();
    p.shots[0]!.useStill = true;
    expect(shotSources(p)[0]).toMatchObject({ asset: { id: "a0" }, rung: "final" });
  });

  it("the cut has only the timeline's shots", () => {
    const { project: p, media } = fakeProject("blank", [
      { kind: "video", length: 4, durationSec: 4 },
      { kind: "image", durationSec: 3 },
    ]);
    p.shots[0]!.onTimeline = false;
    const { timeline } = planTimeline({ project: p, media });
    expect(timeline.clips.map((c) => c.shotId)).toEqual(["s1"]);
    // A blank project opens on its picture: no title card.
    expect(timeline.overlays).toEqual([]);
  });
});

describe("audioAsset", () => {
  const older = { ...audioAssetOf("song1", "music", 30), createdAt: "2026-10-19T00:00:00.000Z" };
  const newer = { ...audioAssetOf("song2", "music", 30), createdAt: "2026-10-21T00:00:00.000Z" };
  const voice = audioAssetOf("voice1", "voice", 5, "Hello there.");
  const withAudio = (soundtrack?: Project["soundtrack"], assets: Asset[] = [older, newer, voice]): Project => {
    const { project: p } = fakeProject("blank", [], assets);
    if (soundtrack) p.soundtrack = soundtrack;
    return p;
  };

  it("plays the newest of a role when the soundtrack picks none", () => {
    expect(audioAsset(withAudio(), "music", "blank")?.id).toBe("song2");
    expect(audioAsset(withAudio({}), "voice", "blank")?.id).toBe("voice1");
  });

  it("plays the picked one, and none when the pick is null", () => {
    expect(audioAsset(withAudio({ music: "song1" }), "music", "blank")?.id).toBe("song1");
    expect(audioAsset(withAudio({ music: null }), "music", "blank")).toBeUndefined();
    // The other role is unaffected.
    expect(audioAsset(withAudio({ music: null }), "voice", "blank")?.id).toBe("voice1");
    expect(audioAsset(withAudio({ voice: null }), "voice", "blank")).toBeUndefined();
  });

  it("a pick that is gone falls back to the newest", () => {
    expect(audioAsset(withAudio({ music: "deleted" }), "music", "blank")?.id).toBe("song2");
  });

  it("the cut leaves out a role the soundtrack turned off", () => {
    const { project: p, media } = fakeProject("blank", [{ kind: "image", durationSec: 3 }], [older]);
    p.soundtrack = { music: null };
    const song = audioAsset(p, "music", "blank");
    const { timeline } = planTimeline({ project: p, media, song: song ? { assetId: song.id, beats: null, lyrics: [] } : null });
    expect(timeline.audio).toEqual([]);
  });
});
