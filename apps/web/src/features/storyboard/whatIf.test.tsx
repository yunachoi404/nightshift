/**
 * The What if? story page and Media board, on the problems the night of Nov 2 found:
 * - the writer fell back to the starter story, and only a small grey line on the story page said so;
 * - while the film rendered, every control on the story page was disabled, with no way to stop it;
 * - "Rewrite story" ran with no confirmation;
 * - "Update narration" pressed right after typing sent the narration from before the edit;
 * - a beat whose keyframe job was removed said "Waiting for this keyframe" forever.
 */
import { fallbackWhatIf, type AudioRequest, type Event, type Job, type Project, type StoryboardRequest } from "@nightshift/contract";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { NightshiftClient, ProjectPatch } from "@/api/client";
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

const PID = "prj_books";
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const BRIEF = { question: "What if every book in an old library flew off its shelf like a bird?", look: "miniature" };

/** The library film as the writer left it: the starter beats, nothing drawn, and a note. */
function starter(o: Partial<Project> = {}): Project {
  const plan = fallbackWhatIf(BRIEF);
  return {
    id: PID, name: "What if the books flew?", template: "what_if", aspect: "9:16", brief: BRIEF,
    shots: [{ ...plan, id: "film", index: 0, locked: false }],
    takes: [], assets: [], timeline: null,
    shotList: { by: "template", note: "The writer tried 3 times, but its story did not fit." },
    createdAt: iso(), updatedAt: iso(), ...o,
  };
}

/** The same film, drawn and rendered once: four keyframes and a take. */
function drawn(): Project {
  const p = starter({ shotList: { by: "writer" } });
  const film = p.shots[0]!;
  film.keyframes = film.keyframes!.map((frame, i) => ({ ...frame, stillAssetId: `still_${i}` }));
  film.stillAssetId = "still_0";
  film.chosenDraftId = "take_1";
  p.assets = [0, 1, 2, 3].map((i) => ({ id: `still_${i}`, kind: "image" as const, path: `still_${i}.png`, createdAt: iso() }));
  p.assets.push({ id: "video_1", kind: "video", path: "video_1.mp4", durationSec: 15, createdAt: iso() });
  p.takes = [{ id: "take_1", shotId: "film", rung: "draft", seed: 1, jobId: "job_film", videoAssetId: "video_1" }];
  return p;
}

const job = (step: Job["step"], status: Job["status"], o: Partial<Job> = {}): Job => ({ id: `job_${step}_${status}`, projectId: PID, step, mode: "now", status, progress: 0.3, outputAssetIds: [], createdAt: iso(30_000), ...o });

/** A client over one project and its jobs, recording what the page asks of the engine. */
class Engine {
  patches: ProjectPatch[] = [];
  stories: (StoryboardRequest | undefined)[] = [];
  audios: AudioRequest[] = [];
  cancels: string[] = [];
  stills: unknown[] = [];
  /** What each request saw of the project when it came: an action must come after the words it uses are saved. */
  linesAtAudio: string[] = [];

  constructor(public project: Project, public jobs: Job[] = []) {}

  client(): NightshiftClient {
    const answer = <T,>(fn: () => T): Promise<T> => Promise.resolve().then(() => structuredClone(fn()));
    const known: Partial<NightshiftClient> = {
      kind: "http",
      status: () => answer(() => ({ phase: "ready" as const, tier: "unified-128-cuda" as const, comfyui: { running: true, url: "http://127.0.0.1:8188", version: "0.41.3" }, memoryUsedGb: null, mode: "local" as const })),
      settings: () => answer(() => ({ tier: "unified-128-cuda" as const, memoryLimitGb: null, overnight: { enabled: false, startAt: "23:00", endAt: "07:00" }, remote: null })),
      onboarding: () => answer(() => ({ done: true, sampleProjectId: null })),
      tiers: () => answer(() => []),
      listProjects: () => answer(() => [this.project]),
      listJobs: () => answer(() => this.jobs),
      getProject: () => answer(() => this.project),
      updateProject: (_pid, patch) => answer(() => {
        this.patches.push(structuredClone(patch));
        this.project = { ...this.project, ...patch } as Project;
        return this.project;
      }),
      storyboard: (_pid, body) => answer(() => {
        this.stories.push(body);
        return job("text", "queued", { id: `job_text_${this.stories.length}` });
      }),
      audio: (_pid, body) => answer(() => {
        this.audios.push(body as AudioRequest);
        this.linesAtAudio.push(this.project.shots[0]!.line ?? "");
        return job("voice", "queued");
      }),
      still: (_pid, _shot, body) => answer(() => {
        this.stills.push(body);
        return job("still", "queued", { shotId: "film" });
      }),
      cancelJob: (id) => answer(() => {
        this.cancels.push(id);
        this.jobs = this.jobs.map((j) => (j.id === id ? { ...j, status: "cancelled" as const } : j));
        return this.jobs.find((j) => j.id === id)!;
      }),
      assetUrl: (pid, aid) => `/api/projects/${pid}/assets/${aid}`,
      events: (_onEvent: (e: Event) => void, onConnection) => {
        queueMicrotask(() => onConnection?.(true));
        return () => undefined;
      },
    };
    // Anything else never answers.
    return new Proxy(known as NightshiftClient, {
      get: (target, key) => (typeof key !== "string" || key in target || key === "then" ? Reflect.get(target, key) : () => new Promise(() => undefined)),
    });
  }
}

function open(engine: Engine, page: "storyboard" | "media" = "storyboard") {
  window.location.hash = `#/p/${PID}/${page}`;
  render(
    <EngineProvider client={engine.client()}>
      <App />
    </EngineProvider>,
  );
}

const beat = (n: number) => screen.getByRole("region", { name: new RegExp(`^Beat ${n}:`) });
const narration = (n: number) => within(beat(n)).getByLabelText("Narration") as HTMLTextAreaElement;

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new window.Event("close"));
  };
});
afterEach(cleanup);

describe("the What if? story page", () => {
  it("says the writer's story did not come, with Try again and Use these beats, and nothing drawn", async () => {
    const engine = new Engine(starter());
    open(engine);
    expect(await screen.findByText("These are starter beats, not a story of your question")).toBeTruthy();
    expect(screen.getByText("The writer tried 3 times, but its story did not fit. Nothing was drawn from these beats. Edit them below, or use them as they are.")).toBeTruthy();
    // No keyframe is on its way, so none is waited for.
    expect(within(beat(1)).getByText("Not drawn yet")).toBeTruthy();
    expect(screen.queryByText("Waiting for this keyframe")).toBeNull();

    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();

    // An edit not yet saved (the field not left) is saved before the beats are used.
    fireEvent.change(narration(4), { target: { value: "And the library is never quiet again." } });
    fireEvent.click(screen.getByRole("button", { name: "Use these beats" }));
    await waitFor(() => expect(engine.stories).toEqual([{ keepStory: true }]));
    expect(engine.patches.at(-1)?.shots?.[0]?.keyframes?.[3]?.line).toBe("And the library is never quiet again.");
    // The story is on its way: the note waits for what it brings.
    await waitFor(() => expect(screen.queryByText("These are starter beats, not a story of your question")).toBeNull());
  });

  it("Update narration right after typing sends what is in the fields", async () => {
    const engine = new Engine(drawn());
    open(engine);
    await screen.findByRole("region", { name: /^Beat 4:/ });
    // Beats 3 and 4 changed, and the button pressed without leaving beat 4's field.
    fireEvent.change(narration(3), { target: { value: "Then its pages take wing, one by one." } });
    fireEvent.blur(narration(3));
    fireEvent.change(narration(4), { target: { value: "And the library is never quiet again." } });
    fireEvent.click(screen.getByRole("button", { name: "Update narration" }));
    await waitFor(() => expect(engine.audios).toHaveLength(1));
    expect(engine.audios[0]!.text).toMatch(/Then its pages take wing, one by one\. And the library is never quiet again\.$/);
    expect(engine.linesAtAudio[0]).toBe(engine.audios[0]!.text);
  });

  it("can stop the film being made, which locks the beats, and says what each job is", async () => {
    const engine = new Engine(drawn(), [job("video_what_if", "running", { shotId: "film" }), job("voice", "queued")]);
    open(engine);
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Making your film · Recording the narration");
    expect(narration(1).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Another take" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(status).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(engine.cancels.sort()).toEqual(["job_video_what_if_running", "job_voice_queued"]));
  });

  it("asks before Rewrite story, says the takes stay, and stops what is being made first", async () => {
    const engine = new Engine(drawn(), [job("video_what_if", "running", { shotId: "film" }), job("video_final_same_take", "queued", { shotId: "film", mode: "overnight" })]);
    open(engine);
    const rewrite = await screen.findByRole("button", { name: "Rewrite story" });
    expect((rewrite as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(rewrite);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Rewrite the story?")).toBeTruthy();
    expect(within(dialog).getByText("The beats and narration on this page are replaced. Your takes and finals stay saved, and the new film becomes the pick when it lands.")).toBeTruthy();
    expect(within(dialog).getByText("What is being made now stops first: making your film.")).toBeTruthy();
    expect(engine.stories).toEqual([]);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Rewrite story" }));
    });
    // The film's draft stops; the final waiting for tonight goes on, made from its take.
    await waitFor(() => expect(engine.stories).toEqual([undefined]));
    expect(engine.cancels).toEqual(["job_video_what_if_running"]);
  });

  it("shows the writer's note on the Media board too", async () => {
    const engine = new Engine(starter());
    open(engine, "media");
    expect(await screen.findByText("These are starter beats, not a story of your question")).toBeTruthy();
    expect(screen.getByText(/Open the story to edit them, or use them as they are\.$/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use these beats" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("a story that stayed when a rewrite did not come says so, and can be dismissed", async () => {
    // Starter beats that were used (drawn, with a take) are the film's story now, not starter beats.
    for (const by of ["writer", "template"] as const) {
      const engine = new Engine({ ...drawn(), shotList: { by, note: "The writer could not finish: out of memory." } });
      open(engine);
      expect(await screen.findByText("The story was not rewritten")).toBeTruthy();
      expect(screen.getByText("The writer could not finish: out of memory.")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Use these beats" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
      await waitFor(() => expect(engine.patches.at(-1)).toEqual({ shotList: { by } }));
      cleanup();
    }
  });
});
