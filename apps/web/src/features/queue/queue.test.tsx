/**
 * The Queue page: the job on the GPU leads it with its stage, progress and time left; the CPU's work runs beside it; the
 * GPU's line for now and tonight's finals sit on a rail in the order they run, with a final able to move between now and
 * tonight; what finished keeps a column, where a failed job says why and can be tried again.
 */
import type { Event, Job, Project, RuntimeStatus } from "@nightshift/contract";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NightshiftClient } from "@/api/client";
import { App } from "@/app/App";
import { EngineProvider } from "@/store/engine";

vi.mock("@/api/config", () => ({
  API_KEY: "nightshift.api",
  buildApiBase: () => "",
  isMock: () => false,
  isDevMock: () => false,
  isBrowserDemo: () => false,
  getClient: () => {
    throw new Error("each test gives the app its own client");
  },
}));

HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;

const PID = "prj_rain";
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const shots = (n: number): Project["shots"] => Array.from({ length: n }, (_, i) => ({ id: `shot_${i + 1}`, index: i, prompt: `Shot ${i + 1}`, durationSec: 4, locked: false, chosenDraftId: `take_${i + 1}` }));
const project: Project = { id: PID, name: "Rain Rider", template: "cinematic_shot", aspect: "16:9", brief: {}, shots: shots(4), takes: [], assets: [], timeline: null, createdAt: iso(), updatedAt: iso() };
const OOM = "ComfyUI failed in BreezeTTS2VoiceDesign node 2: Allocation on device 0 would exceed allowed memory. (out of memory)\nCurrently allocated     : 3.30 GiB";
/** A night window that is closed while the test runs, whatever the time: it opens in two hours. */
const later = (hours: number) => `${String((new Date().getHours() + hours) % 24).padStart(2, "0")}:00`;
const closedNight = { enabled: true, startAt: later(2), endAt: later(6) };

let seq = 0;
function job(id: string, step: Job["step"], status: Job["status"], minAgo: number, extra: Partial<Job> = {}): Job {
  const done = status === "done" || status === "failed" || status === "cancelled";
  return { id, projectId: PID, step, mode: "now", status, progress: done ? 1 : 0, outputAssetIds: [], createdAt: iso(minAgo * 60_000 + 5000 - ++seq), ...(done ? { finishedAt: iso(minAgo * 60_000) } : {}), ...extra };
}
const night = (id: string, shot: number, model: "LTX-2.5" | "MiniMax H3", nightGroup: number, minAgo: number): Job =>
  job(id, model === "LTX-2.5" ? "video_final_same_take" : "video_final_remaster", "queued", minAgo, { mode: "overnight", shotId: `shot_${shot}`, model, nightGroup, message: "Runs tonight" });

function engine(jobs: Job[], opts: { overnight?: { enabled: boolean; startAt: string; endAt: string }; comfyRunning?: boolean } = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const answer = <T,>(fn: () => T): Promise<T> => Promise.resolve().then(() => structuredClone(fn()));
  const status: RuntimeStatus = { phase: "ready", tier: "nvidia-8", comfyui: { running: opts.comfyRunning ?? true, url: "http://127.0.0.1:8188", version: "0.41.3" }, memoryUsedGb: null, mode: "local" };
  const byId = (id: string) => jobs.find((j) => j.id === id)!;
  const known: Partial<NightshiftClient> = {
    kind: "http",
    status: () => answer(() => status),
    settings: () => answer(() => ({ tier: "nvidia-8", memoryLimitGb: null, overnight: opts.overnight ?? { enabled: false, startAt: "23:00", endAt: "07:00" }, remote: null })),
    onboarding: () => answer(() => ({ done: true, sampleProjectId: null })),
    tiers: () => answer(() => []),
    listProjects: () => answer(() => [project]),
    listJobs: () => answer(() => jobs),
    getProject: () => answer(() => project),
    assetUrl: (pid, aid) => `/api/projects/${pid}/assets/${aid}`,
    cancelJob: (id) => answer(() => (calls.push(["cancelJob", id]), { ...byId(id), status: "cancelled" as const })),
    setJobMode: (id, mode) => answer(() => (calls.push(["setJobMode", id, mode]), { ...byId(id), mode })),
    still: (pid, shotId) => answer(() => (calls.push(["still", pid, shotId]), job("job_again", "still", "queued", 0, { shotId }))),
    final: (pid, shotId, body) => answer(() => (calls.push(["final", pid, shotId, body]), job("job_again", "video_final_same_take", "queued", 0, { shotId }))),
    events: (_onEvent: (e: Event) => void, onConnection) => {
      queueMicrotask(() => onConnection?.(true));
      return () => undefined;
    },
  };
  const client = new Proxy(known as NightshiftClient, {
    get: (target, key) => (typeof key !== "string" || key in target || key === "then" ? Reflect.get(target, key) : () => new Promise(() => undefined)),
  });
  return { client, calls };
}

function open(client: NightshiftClient) {
  window.location.hash = "#/queue";
  return render(
    <EngineProvider client={client}>
      <App />
    </EngineProvider>,
  );
}

const section = (name: string) => screen.getByRole("heading", { name, level: 2 }).closest("section")!;
const names = (root: Element) => [...root.querySelectorAll(".q-row__name")].map((n) => n.textContent);

afterEach(() => {
  window.location.hash = "";
});

describe("the queue when it is empty", () => {
  it("still shows every section, each saying what goes in it", async () => {
    open(engine([], { overnight: { enabled: true, startAt: "23:00", endAt: "07:00" } }).client);
    expect(await screen.findByText("Nothing is rendering")).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Rendering now", "Up next", "Tonight", "Finished"]);
    expect(within(section("Rendering now")).getByText("The GPU is free. New work starts right away.")).toBeTruthy();
    expect(within(section("Up next")).getByText("Nothing waiting. Stills, drafts, music and voice line up here in the order they run.")).toBeTruthy();
    expect(within(section("Tonight")).getByText("No finals for tonight. On a take you like, choose Finish tonight and it renders here while you sleep.")).toBeTruthy();
    // Tonight's window shows even with nothing in it.
    expect(within(section("Tonight")).getByText("Finals you queue for tonight run between 11 pm and 7 am")).toBeTruthy();
    expect(within(section("Finished")).getByText("Nothing finished yet. Each result shows here with a link to it.")).toBeTruthy();
    // No line under the title about where work runs.
    expect(screen.queryByText(/Renders run one at a time/)).toBeNull();
  });
});

describe("the queue's finished jobs", () => {
  it("a failed job says why, with the full error as its tooltip, and every row leads to its result", async () => {
    open(engine([
      job("job_music", "music", "done", 16),
      job("job_v1", "voice", "failed", 12, { error: "ComfyUI failed in BreezeTTS2LoadModel node 1: property 'upsample' of 'Qwen3TTSTokenizerV2Encoder' object has no setter", message: "Failed" }),
      job("job_v2", "voice", "failed", 1, { error: OOM, message: "Ran out of graphics memory. Other apps are using 3.5 GB (python)." }),
      job("job_draft", "video_draft", "done", 20, { shotId: "shot_2" }),
    ]).client);
    const crowded = await screen.findByText("Ran out of graphics memory. Other apps are using 3.5 GB (python).");
    expect(crowded.getAttribute("title")).toBe(OOM);
    expect(screen.getByText("ComfyUI failed in BreezeTTS2LoadModel node 1: property 'upsample' of 'Qwen3TTSTokenizerV2Encoder' object has no setter")).toBeTruthy();

    const done = section("Finished");
    const rows = [...done.querySelectorAll(".q-done__row")];
    expect(rows.map((r) => r.querySelector(".q-done__name")?.textContent)).toEqual(["Voice", "Voice", "Music", "Draft, shot 2"]);
    expect(within(done).getByText("Today")).toBeTruthy();
    expect(rows.map((r) => r.querySelector(".q-done__when")?.textContent)).toEqual(["1 min ago", "12 min ago", "16 min ago", "20 min ago"]);
    // The draft leads to its card, the song to the media page.
    expect(within(rows[3] as HTMLElement).getByRole("link", { name: "Draft, shot 2" }).getAttribute("href")).toBe("#/p/prj_rain/media?card=shot_2");
    expect(within(rows[2] as HTMLElement).getByRole("link", { name: "Music" }).getAttribute("href")).toBe("#/p/prj_rain/media");
  });

  it("a failed still or final can be tried again from its row, as it was asked for", async () => {
    const e = engine([
      job("job_still", "still", "failed", 3, { shotId: "shot_1", error: "boom", message: "Failed" }),
      job("job_final", "video_final_remaster", "failed", 2, { shotId: "shot_2", mode: "overnight", error: "boom", message: "Failed" }),
      job("job_voice", "voice", "failed", 1, { error: "boom", message: "Failed" }),
    ]);
    open(e.client);
    const done = await waitFor(() => section("Finished"));
    const again = within(done).getAllByRole("button", { name: "Try again" });
    // A voice is made again from the project, where its words are chosen.
    expect(again).toHaveLength(2);
    fireEvent.click(again[0]!);
    fireEvent.click(again[1]!);
    await waitFor(() => expect(e.calls).toHaveLength(2));
    expect(e.calls).toEqual([
      ["final", PID, "shot_2", { draftId: "take_2", kind: "remaster", mode: "overnight" }],
      ["still", PID, "shot_1"],
    ]);
  });
});

describe("the queue's work now", () => {
  it("leads with the job on the GPU, puts the CPU's work beside it, and lines up the rest in the order it runs", async () => {
    const e = engine([
      job("job_final_now", "video_final_same_take", "queued", 9, { shotId: "shot_3", model: "LTX-2.5" }),
      job("job_draft", "video_draft", "running", 8, { shotId: "shot_1", progress: 0.4, startedAt: iso(30_000), message: "Generating" }),
      job("job_still", "still", "queued", 7, { shotId: "shot_2" }),
      job("job_export", "export", "queued", 6, { message: "Waiting for 2 jobs of this project" }),
    ]);
    open(e.client);
    const now = await waitFor(() => section("Rendering now"));
    const live = now.querySelector(".q-live")!;
    expect(live.querySelector(".q-live__name")?.textContent).toBe("Draft, shot 1");
    expect(live.querySelector(".q-live__project")?.textContent).toBe("Rain Rider");
    expect(live.querySelector(".q-live__stage")?.textContent).toBe("Generating40%");
    expect(live.querySelector(".q-live__meta")?.textContent).toBe("About 41 s left");
    // Exports run beside it, on the CPU, and say what they wait for.
    const beside = now.querySelector(".q-beside")!;
    expect(names(beside)).toEqual(["Export"]);
    expect(beside.querySelector(".q-row__status")?.textContent).toBe("Waiting for 2 jobs of this project");
    // Quick work goes before a final to run now, whatever the order queued.
    const next = section("Up next");
    expect(names(next)).toEqual(["Still, shot 2", "Final, same take, shot 3"]);
    expect([...next.querySelectorAll(".q-row__when")].map((w) => w.textContent)).toEqual(["in 1 min", "in 2 min"]);
    // Every job waiting or running is on the page once, as the sidebar's pill counts them.
    expect(screen.getByRole("link", { name: "Queue 4" })).toBeTruthy();
    expect(document.querySelectorAll(".q-live, .q-row")).toHaveLength(4);

    fireEvent.click(within(live as HTMLElement).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(e.calls).toEqual([["cancelJob", "job_draft"]]));
  });

  it("a final to run now moves to tonight, and a queued job is removed", async () => {
    const e = engine([job("job_final_now", "video_final_same_take", "queued", 9, { shotId: "shot_3", model: "LTX-2.5" }), job("job_still", "still", "queued", 7, { shotId: "shot_2" })], { overnight: closedNight });
    open(e.client);
    const next = await waitFor(() => section("Up next"));
    // Only the final can move.
    expect(within(next).getAllByRole("button", { name: "Tonight" })).toHaveLength(1);
    fireEvent.click(within(next).getByRole("button", { name: "Tonight" }));
    fireEvent.click(within(next).getByRole("button", { name: "Remove still" }));
    await waitFor(() => expect(e.calls).toHaveLength(2));
    expect(e.calls).toEqual([
      ["setJobMode", "job_final_now", "overnight"],
      ["cancelJob", "job_still"],
    ]);
  });

  it("while the GPU is away, the page says it waits, and promises no start times", async () => {
    open(engine([job("job_still", "still", "queued", 7, { shotId: "shot_2", message: "Waiting for the GPU" })], { comfyRunning: false }).client);
    expect(await screen.findByText("Waiting for the GPU")).toBeTruthy();
    expect(screen.getByText("It is starting or busy. Queued work starts on its own when it is back.")).toBeTruthy();
    expect([...section("Up next").querySelectorAll(".q-row__when")].map((w) => w.textContent)).toEqual([""]);
  });
});

describe("the queue's finals for tonight", () => {
  it("are grouped by the model they share, in the order they run, each at the time it should start", async () => {
    const e = engine([night("job_l1", 1, "LTX-2.5", 1, 9), night("job_h1", 2, "MiniMax H3", 2, 8), night("job_l2", 3, "LTX-2.5", 1, 7)], { overnight: closedNight });
    open(e.client);
    const tonight = await waitFor(() => section("Tonight"));
    expect([...tonight.querySelectorAll(".q-group")].map((g) => g.getAttribute("aria-label"))).toEqual(["LTX-2.5, 2 finals", "MiniMax H3, 1 final"]);
    expect(within(tonight).getByText("2 finals back to back, so the model loads once")).toBeTruthy();
    expect(names(tonight)).toEqual(["Final, same take, shot 1", "Final, same take, shot 3", "Final, remaster, shot 2"]);
    // The first starts when the window opens; without the setup's estimates a final counts five minutes.
    const start = Number(closedNight.startAt.slice(0, 2));
    const twelve = (h: number, m: number) => `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h >= 12 ? "pm" : "am"}`;
    expect([...tonight.querySelectorAll(".q-row__when")].map((w) => w.textContent)).toEqual([twelve(start, 0), twelve(start, 5), twelve(start, 10)]);
    // The GPU is free until then, and tonight's finals can start now.
    expect(within(section("Rendering now")).getByText(`Tonight's 3 finals start at ${twelve(start, 0)}`)).toBeTruthy();

    fireEvent.click(within(tonight).getAllByRole("button", { name: "Run now" })[2]!);
    await waitFor(() => expect(e.calls).toEqual([["setJobMode", "job_h1", "now"]]));
    // It joins the line for now; the two left for tonight can start now too.
    await waitFor(() => expect(names(section("Up next"))).toEqual(["Final, remaster, shot 2"]));
    fireEvent.click(within(section("Rendering now")).getByRole("button", { name: "Start them now" }));
    await waitFor(() => expect(e.calls).toHaveLength(3));
    expect(e.calls.slice(1)).toEqual([
      ["setJobMode", "job_l1", "now"],
      ["setJobMode", "job_l2", "now"],
    ]);
  });

  it("say that they wait while the night shift is off", async () => {
    open(engine([night("job_l1", 1, "LTX-2.5", 1, 9)], { overnight: { enabled: false, startAt: "23:00", endAt: "07:00" } }).client);
    const tonight = await waitFor(() => section("Tonight"));
    expect(within(tonight).getByText("Paused")).toBeTruthy();
    expect(within(tonight).getByText("Waits until the night shift is on")).toBeTruthy();
    expect(within(tonight).getByRole("link", { name: "Turn it on" }).getAttribute("href")).toBe("#/settings");
  });
});
