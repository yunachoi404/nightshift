/**
 * A render made now says when it is ready, with the mark and a way to it, while you are somewhere its card isn't. Its
 * own page says nothing (the card shows it), nor does setup, a final made overnight (the morning says so), a step on
 * the way to something else, or anything that finished before the window opened.
 */
import type { Event, Job, Project } from "@nightshift/contract";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NightshiftClient } from "@/api/client";
import { EngineProvider } from "@/store/engine";
import { App } from "./App";
import { readyNews, readyToast } from "./readyToasts";

vi.mock("@/api/config", () => ({
  API_KEY: "nightshift.api",
  buildApiBase: () => "",
  isMock: () => false,
  isDevMock: () => false,
  isBrowserDemo: () => false,
  getClient: () => {
    throw new Error("the test gives the app its own client");
  },
}));

const iso = () => new Date().toISOString();
const PROJECT: Project = { id: "prj_one", name: "Lighthouse", template: "blank", aspect: "16:9", brief: {}, shots: [], takes: [], assets: [], timeline: null, createdAt: iso(), updatedAt: iso() };

function job(id: string, step: Job["step"], status: Job["status"], extra: Partial<Job> = {}): Job {
  return { id, projectId: PROJECT.id, step, mode: "now", status, progress: status === "done" ? 1 : 0.4, outputAssetIds: [], createdAt: iso(), ...extra };
}

/** An engine with one project and the given jobs. `send` plays an event to the window. */
function engine(jobs: Job[]) {
  let push: ((e: Event) => void) | undefined;
  const known: Partial<NightshiftClient> = {
    kind: "http",
    status: async () => ({ phase: "ready", tier: "nvidia-8", comfyui: { running: true, url: "http://127.0.0.1:8188", version: "0.41.3" }, memoryUsedGb: null, mode: "local" }),
    settings: async () => ({ tier: "nvidia-8", memoryLimitGb: null, overnight: { enabled: false, startAt: "23:00", endAt: "07:00" }, remote: null }),
    onboarding: async () => ({ done: true, sampleProjectId: null }),
    tiers: async () => [],
    listProjects: async () => [PROJECT],
    listJobs: async () => jobs,
    assetUrl: (pid, aid) => `/api/projects/${pid}/assets/${aid}`,
    events: (onEvent: (e: Event) => void, onConnection) => {
      push = onEvent;
      queueMicrotask(() => onConnection?.(true));
      return () => undefined;
    },
  };
  const client = new Proxy(known as NightshiftClient, {
    get: (target, key) => (typeof key !== "string" || key in target || key === "then" ? Reflect.get(target, key) : () => new Promise(() => undefined)),
  });
  return { client, send: (e: Event) => act(() => push?.(e)) };
}

async function open(at: string, jobs: Job[]) {
  window.location.hash = at;
  const e = engine(jobs);
  render(
    <EngineProvider client={e.client}>
      <App />
    </EngineProvider>,
  );
  await screen.findByRole("link", { name: "Lighthouse" });
  return e;
}

describe("a render that is ready", () => {
  it("says so on another page, with the project and a way to it", async () => {
    const { send } = await open("#/", [job("job_still", "still", "running")]);
    send({ type: "job", job: job("job_still", "still", "done") });

    const toast = await screen.findByText("Still ready");
    const row = toast.closest(".toast") as HTMLElement;
    expect(row.textContent).toContain("Lighthouse");
    expect(row.querySelector("[data-mark]")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    await waitFor(() => expect(window.location.hash).toBe("#/p/prj_one/media"));
    expect(screen.queryByText("Still ready")).toBeNull();
  });

  it("says nothing on its own project's media page, where the card shows it", async () => {
    const { send } = await open("#/p/prj_one/media", [job("job_draft", "video_draft", "running")]);
    send({ type: "job", job: job("job_draft", "video_draft", "done") });
    await act(async () => undefined);
    expect(screen.queryByText(/ready/)).toBeNull();
  });

  it("says nothing for what finished before the window opened, or for a final made overnight", async () => {
    const { send } = await open("#/", [job("job_old", "music", "done"), job("job_night", "video_final_same_take", "running", { mode: "overnight" })]);
    send({ type: "job", job: job("job_night", "video_final_same_take", "done", { mode: "overnight" }) });
    await act(async () => undefined);
    expect(document.querySelector(".toast")).toBeNull();
  });
});

describe("readyNews", () => {
  const before = new Map<string, Job["status"]>([
    ["a", "running"],
    ["b", "running"],
    ["c", "running"],
  ]);

  it("names a now render finished since the last look, away from its page", () => {
    expect(readyNews(before, [job("a", "still", "done")], "/").map((j) => j.id)).toEqual(["a"]);
    expect(readyNews(before, [job("a", "export", "done")], "/p/prj_one/media").map((j) => j.id)).toEqual(["a"]);
  });

  it("leaves out its own page, setup, analysis, steps on the way and jobs that were already done", () => {
    expect(readyNews(before, [job("a", "still", "done")], "/p/prj_one/media")).toEqual([]);
    expect(readyNews(before, [job("a", "export", "done")], "/p/prj_one/editor")).toEqual([]);
    expect(readyNews(before, [job("a", "still", "done")], "/setup")).toEqual([]);
    expect(readyNews(before, [job("a", "music", "done", { analysis: true }), job("b", "text", "done"), job("c", "effect_end_frame", "done")], "/")).toEqual([]);
    expect(readyNews(new Map([["a", "done"]]), [job("a", "still", "done")], "/")).toEqual([]);
    expect(readyNews(before, [job("a", "still", "failed")], "/")).toEqual([]);
  });
});

describe("readyToast", () => {
  const shot = (id: string, index: number) => ({ id, index, prompt: `Shot ${id}`, durationSec: 4, locked: false });
  const film: Project = { ...PROJECT, name: "Paper Boat Frog", shots: [shot("s1", 0), shot("s2", 1), shot("s3", 2)] };

  it("names one take of one shot as that, never as your video, and says how many more are coming", () => {
    // The dogfood night: the first of six drafts landed and the toast said "Your video is ready".
    const done = job("d1", "video_draft", "done", { shotId: "s1" });
    const coming = [job("d2", "video_draft", "running", { shotId: "s2" }), job("d3", "video_effect", "queued", { shotId: "s3" }), job("v", "voice", "queued")];
    expect(readyToast(film, [done], [done, ...coming])).toEqual({ title: "Take ready for shot 1", text: "Paper Boat Frog. 2 more on the way." });
    expect(readyToast(film, [done], [done])).toEqual({ title: "Take ready for shot 1", text: "Paper Boat Frog" });
  });

  it("calls only an export your video; a song and a voiceover are the project's own", () => {
    expect(readyToast(film, [job("e", "export", "done")], []).title).toBe("Your video is ready");
    expect(readyToast(film, [job("m", "music", "done")], []).title).toBe("Your song is ready");
    expect(readyToast(film, [job("v", "voice", "done")], []).title).toBe("Your voiceover is ready");
  });

  it("counts several at once, and leaves the shot out for a card on its board only or a one-shot project", () => {
    expect(readyToast(film, [job("a", "video_draft", "done", { shotId: "s1" }), job("b", "video_draft", "done", { shotId: "s2" })], []).title).toBe("2 takes ready");
    expect(readyToast(film, [job("a", "still", "done", { shotId: "s1" }), job("b", "video_draft", "done", { shotId: "s2" })], []).title).toBe("2 renders ready");
    expect(readyToast({ ...film, shots: [shot("s1", 0), { ...shot("s9", 1), onTimeline: false }] }, [job("a", "video_final_same_take", "done", { shotId: "s9" })], []).title).toBe("Final ready");
    expect(readyToast({ ...film, shots: [shot("s1", 0)] }, [job("a", "still", "done", { shotId: "s1" })], []).title).toBe("Still ready");
  });
});
