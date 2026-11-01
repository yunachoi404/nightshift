/**
 * The minimal editor: cards come onto the timeline by drag and drop from the media sidebar, clips come off with their
 * x or Delete, voice and music are made on their lanes, and an empty timeline says how to fill it. Every edit is one
 * PATCH of the latest project; the engine cuts the film again from it.
 */
import type { Event, Job, Project } from "@nightshift/contract";
import { act, createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NightshiftClient, ProjectPatch } from "@/api/client";
import { App } from "@/app/App";
import { DRAG_TYPE } from "@/features/media/items";
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

// The filmstrip draws on a canvas, which jsdom lacks.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
// jsdom has no pointer events either: a mouse event with a pointer id stands in, so a drag carries its position.
window.PointerEvent ??= class extends MouseEvent {
  pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
} as unknown as typeof PointerEvent;

const PID = "prj_cut";
const iso = () => new Date().toISOString();

/** Two shots on the timeline (0 to 2 s, 2 to 4 s), a third only in Media, an uploaded image and a song. */
function cutProject(): Project {
  return {
    id: PID,
    name: "Night Market",
    template: "cinematic_shot",
    aspect: "16:9",
    brief: { script: "Lanterns over the water." },
    shots: [
      { id: "shot_1", index: 0, prompt: "Lanterns over a canal", durationSec: 2, stillAssetId: "ast_s1", locked: false },
      { id: "shot_2", index: 1, prompt: "A noodle stall in steam", durationSec: 2, stillAssetId: "ast_s2", locked: false },
      { id: "shot_3", index: 2, prompt: "A boat passing under a bridge", durationSec: 2, stillAssetId: "ast_s3", locked: false, onTimeline: false },
    ],
    takes: [],
    assets: [
      { id: "ast_s1", kind: "image", path: "assets/ast_s1.png", createdAt: iso() },
      { id: "ast_s2", kind: "image", path: "assets/ast_s2.png", createdAt: iso() },
      { id: "ast_s3", kind: "image", path: "assets/ast_s3.png", createdAt: iso() },
      { id: "ast_song", kind: "audio", role: "music", path: "assets/ast_song.wav", durationSec: 30, createdAt: iso() },
    ],
    soundtrack: { music: null },
    timeline: {
      clips: [
        { shotId: "shot_1", assetId: "ast_s1", start: 0, in: 0, out: 2 },
        { shotId: "shot_2", assetId: "ast_s2", start: 2, in: 0, out: 2 },
      ],
      audio: [],
      captions: [],
      style: {},
    },
    createdAt: iso(),
    updatedAt: iso(),
  };
}

function client(project: Project) {
  const answer = <T,>(fn: () => T): Promise<T> => Promise.resolve().then(() => structuredClone(fn()));
  const updateProject = vi.fn((_pid: string, patch: ProjectPatch) => answer(() => ({ ...project, ...patch })));
  const audio = vi.fn(() => answer((): Job => ({ id: "job_voice", projectId: PID, step: "voice", mode: "now", status: "queued", progress: 0, outputAssetIds: [], createdAt: iso() })));
  const known: Partial<NightshiftClient> = {
    kind: "http",
    status: () => answer(() => ({ phase: "ready" as const, tier: "nvidia-8" as const, comfyui: { running: true, url: "http://127.0.0.1:8188", version: "0.41.3" }, memoryUsedGb: null, mode: "local" as const })),
    settings: () => answer(() => ({ tier: "nvidia-8" as const, memoryLimitGb: null, overnight: { enabled: false, startAt: "23:00", endAt: "07:00" }, remote: null })),
    onboarding: () => answer(() => ({ done: true, sampleProjectId: null })),
    tiers: () => answer(() => []),
    listProjects: () => answer(() => [project]),
    listJobs: () => answer(() => []),
    getProject: () => answer(() => project),
    updateProject,
    audio,
    assetUrl: (pid, aid) => `/api/projects/${pid}/assets/${aid}`,
    events: (_onEvent: (e: Event) => void, onConnection) => {
      queueMicrotask(() => onConnection?.(true));
      return () => undefined;
    },
  };
  // Anything else never answers.
  const proxy = new Proxy(known as NightshiftClient, {
    get: (target, key) => (typeof key !== "string" || key in target || key === "then" ? Reflect.get(target, key) : () => new Promise(() => undefined)),
  });
  return { client: proxy, updateProject, audio };
}

function open(project: Project) {
  const c = client(project);
  window.location.hash = `#/p/${PID}/editor`;
  render(
    <EngineProvider client={c.client}>
      <App />
    </EngineProvider>,
  );
  return c;
}

const lane = (name: string) => document.querySelector<HTMLElement>(`[data-lane="${name}"]`)!;

/** A canvas drag as the browser hands it over: the type is readable while dragging, the cards only on the drop. */
function drag(items: string[]) {
  return { types: [DRAG_TYPE], getData: (type: string) => (type === DRAG_TYPE ? JSON.stringify({ items }) : ""), dropEffect: "none", effectAllowed: "copyMove" };
}

/** Drops at a point of the timeline. In jsdom it is 800 px wide from x 0, so a 4 s cut is 194 px a second from 12 px. */
function dropAt(target: HTMLElement, items: string[], seconds: number) {
  const event = createEvent.drop(target, { dataTransfer: drag(items) });
  Object.defineProperty(event, "clientX", { value: 12 + seconds * 194 });
  fireEvent(target, event);
}

const order = (patch: ProjectPatch) => [...patch.shots!].filter((s) => s.onTimeline !== false).sort((a, b) => a.index - b.index).map((s) => s.id);

describe("the minimal editor", () => {
  it("puts a card dropped on the Shots lane on the timeline where the pointer is, with a marker while dragging", async () => {
    const { updateProject } = open(cutProject());
    await screen.findByRole("button", { name: /^Shot 2,/ });
    // Dragged over the second clip's first half: the marker sits between the clips.
    const over = createEvent.dragOver(lane("shots"), { dataTransfer: drag([]) });
    Object.defineProperty(over, "clientX", { value: 12 + 2.4 * 194 });
    fireEvent(lane("shots"), over);
    expect(over.defaultPrevented).toBe(true);
    const marker = lane("shots").querySelector<HTMLElement>(".tl__insert")!;
    expect(marker.style.left).toBe(`${12 + 2 * 194}px`);

    dropAt(lane("shots"), ["shot_3"], 2.4);
    await waitFor(() => expect(updateProject).toHaveBeenCalledTimes(1));
    const patch = updateProject.mock.calls[0]![1];
    expect(order(patch)).toEqual(["shot_1", "shot_3", "shot_2"]);
    expect(patch.shots!.find((s) => s.id === "shot_3")!.onTimeline).toBe(true);
    // The canvas goes along, so the card stays on its board.
    expect(patch.boards?.[0]?.items).toContain("shot_3");
    expect(lane("shots").querySelector(".tl__insert")).toBeNull();
  });

  it("moves a clip dragged to the end, and adds a sidebar card with its +", async () => {
    const { updateProject } = open(cutProject());
    await screen.findByRole("button", { name: /^Shot 2,/ });
    dropAt(lane("shots"), ["shot_1"], 3.9);
    await waitFor(() => expect(updateProject).toHaveBeenCalledTimes(1));
    expect(order(updateProject.mock.calls[0]![1])).toEqual(["shot_2", "shot_1"]);

    const sidebar = screen.getByRole("complementary", { name: "Media" });
    fireEvent.click(within(sidebar).getByRole("button", { name: "Add A boat passing under a bridge to the timeline" }));
    await waitFor(() => expect(updateProject).toHaveBeenCalledTimes(2));
    expect(order(updateProject.mock.calls[1]![1])).toEqual(["shot_1", "shot_2", "shot_3"]);
  });

  it("takes a clip off the timeline with its x or Delete, keeping it in Media", async () => {
    const { updateProject } = open(cutProject());
    fireEvent.click(await screen.findByRole("button", { name: "Take shot 1 off the timeline" }));
    await waitFor(() => expect(updateProject).toHaveBeenCalledTimes(1));
    let patch = updateProject.mock.calls[0]![1];
    expect(order(patch)).toEqual(["shot_2"]);
    expect(patch.shots!.find((s) => s.id === "shot_1")).toMatchObject({ onTimeline: false });
    expect(patch.shots).toHaveLength(3);

    fireEvent.keyDown(screen.getByRole("button", { name: /^Shot 2,/ }), { key: "Delete" });
    await waitFor(() => expect(updateProject).toHaveBeenCalledTimes(2));
    patch = updateProject.mock.calls[1]![1];
    expect(order(patch)).toEqual(["shot_1"]);
  });

  it("drags a clip's end to set how long its shot plays, steps it with the arrow keys, and hands it back", async () => {
    const project = cutProject();
    const { updateProject } = open(project);
    const end = await screen.findByRole("slider", { name: "Length of shot 1" });
    expect(end.getAttribute("aria-valuenow")).toBe("2");
    // Half a second further: the clip widens while dragged and says how long it is, then the length is saved.
    fireEvent.pointerDown(end, { clientX: 400, button: 0, pointerId: 1 });
    fireEvent.pointerMove(end, { clientX: 400 + 97, pointerId: 1 });
    expect(end.closest<HTMLElement>(".tl__clip")!.style.width).toBe(`${2.5 * 194 - 3}px`);
    expect(end.closest(".tl__clip")!.textContent).toContain("2.5 s");
    // The clip after it moves along.
    expect(screen.getByRole("slider", { name: "Length of shot 2" }).closest<HTMLElement>(".tl__clip")!.style.left).toBe(`${12 + 2.5 * 194}px`);
    fireEvent.pointerUp(end, { clientX: 400 + 97, pointerId: 1 });
    await waitFor(() => expect(updateProject).toHaveBeenCalledTimes(1));
    let shots = updateProject.mock.calls[0]![1].shots!;
    expect(shots.find((s) => s.id === "shot_1")).toMatchObject({ cutSec: 2.5, durationSec: 2 });
    expect(shots.find((s) => s.id === "shot_2")!.cutSec).toBeUndefined();

    // Two steps shorter from the keyboard make one save.
    const second = screen.getByRole("slider", { name: "Length of shot 2" });
    fireEvent.keyDown(second, { key: "ArrowLeft" });
    fireEvent.keyDown(second, { key: "ArrowLeft" });
    expect(second.getAttribute("aria-valuenow")).toBe("1.8");
    await waitFor(() => expect(updateProject).toHaveBeenCalledTimes(2));
    shots = updateProject.mock.calls[1]![1].shots!;
    expect(shots.find((s) => s.id === "shot_2")!.cutSec).toBe(1.8);
  });

  it("lets the template choose a length again on a double-click, and has no end to drag where the template sets it", async () => {
    const project = cutProject();
    project.shots[0]!.cutSec = 1.5;
    const { updateProject } = open(project);
    const end = await screen.findByRole("slider", { name: "Length of shot 1" });
    expect(end.getAttribute("aria-valuetext")).toBe("2 seconds, set by you");
    fireEvent.doubleClick(end);
    await waitFor(() => expect(updateProject).toHaveBeenCalledTimes(1));
    expect(updateProject.mock.calls[0]![1].shots!.find((s) => s.id === "shot_1")).not.toHaveProperty("cutSec");
  });

  it("ends a product ad with its last shot under the end card, so that clip has no end to drag", async () => {
    const project = cutProject();
    project.template = "product_ad";
    open(project);
    await screen.findByRole("slider", { name: "Length of shot 1" });
    expect(screen.queryByRole("slider", { name: "Length of shot 2" })).toBeNull();
  });

  it("puts a song dropped on the Music lane on the timeline", async () => {
    const project = cutProject();
    const { updateProject } = open(project);
    await screen.findByRole("button", { name: /^Shot 2,/ });
    dropAt(lane("music"), ["ast_song"], 1);
    await waitFor(() => expect(updateProject).toHaveBeenCalledTimes(1));
    expect(updateProject.mock.calls[0]![1].soundtrack).toEqual({ music: "ast_song" });
  });

  it("offers to take the music off once it plays", async () => {
    const project = cutProject();
    project.soundtrack = {};
    project.timeline!.audio = [{ assetId: "ast_song", role: "music", start: 0, gain: 1 }];
    const { updateProject } = open(project);
    fireEvent.click(await screen.findByRole("button", { name: "Take the music off the timeline" }));
    await waitFor(() => expect(updateProject).toHaveBeenCalledTimes(1));
    expect(updateProject.mock.calls[0]![1]).toEqual({ soundtrack: { music: null } });
  });

  it("writes a voiceover on the Voice lane: the script and voice are saved, then the voice is made", async () => {
    const { updateProject, audio } = open(cutProject());
    fireEvent.click(await screen.findByRole("button", { name: "Write voiceover" }));
    const pop = screen.getByRole("dialog", { name: "Write voiceover" });
    const script = within(pop).getByRole("textbox", { name: "Voice script" });
    // Prefilled from the brief, as before.
    expect((script as HTMLTextAreaElement).value).toBe("Lanterns over the water.");
    fireEvent.change(script, { target: { value: "The market wakes at dusk." } });
    fireEvent.change(within(pop).getByRole("combobox", { name: "Voice" }), { target: { value: "theo" } });
    fireEvent.click(within(pop).getByRole("button", { name: "Make voice" }));
    await waitFor(() => expect(audio).toHaveBeenCalledTimes(1));
    expect(audio).toHaveBeenCalledWith(PID, { role: "voice", text: "The market wakes at dusk.", voice: "theo" });
    expect(updateProject.mock.calls[0]![1].brief).toMatchObject({ script: "The market wakes at dusk.", voice: "theo" });
    expect(screen.queryByRole("dialog", { name: "Write voiceover" })).toBeNull();
  });

  it("shows the drop hint on an empty timeline, and still takes drops", async () => {
    const project = cutProject();
    project.shots = project.shots.map((s) => ({ ...s, onTimeline: false }));
    project.timeline = { clips: [], audio: [], captions: [], style: {} };
    const { updateProject } = open(project);
    await screen.findByText("Nothing on the timeline yet");
    screen.getByText("Drag cards here from the Media sidebar");
    expect(screen.getByRole("link", { name: "Go to Media" }).getAttribute("href")).toBe(`#/p/${PID}/media`);
    within(lane("shots")).getByText("Drag cards here from Media");
    // Every lane is there to drop on.
    expect(["shots", "music", "voice"].map((l) => !!lane(l))).toEqual([true, true, true]);

    dropAt(lane("shots"), ["shot_2"], 0);
    await waitFor(() => expect(updateProject).toHaveBeenCalledTimes(1));
    expect(order(updateProject.mock.calls[0]![1])).toEqual(["shot_2"]);
  });

  it("shows a song made while nothing is on the timeline as ready on its lane, to take off, not to make again", async () => {
    const project = cutProject();
    project.shots = project.shots.map((s) => ({ ...s, onTimeline: false }));
    project.soundtrack = {};
    project.timeline = null;
    const { updateProject } = open(project);
    await screen.findByText("Nothing on the timeline yet");
    expect(lane("music").textContent).toBe("Song ready. It plays once shots are on the timeline.");
    // No voiceover yet: its lane still offers one.
    expect(lane("voice").textContent).toContain("Write voiceover");
    fireEvent.click(screen.getByRole("button", { name: "Take the music off the timeline" }));
    await waitFor(() => expect(updateProject).toHaveBeenCalledTimes(1));
    expect(updateProject.mock.calls[0]![1]).toEqual({ soundtrack: { music: null } });
  });

  it("keeps the captions switch off, and says why, until the project has a timeline", async () => {
    const project = cutProject();
    project.shots = project.shots.map((s) => ({ ...s, onTimeline: false }));
    project.timeline = null;
    const { updateProject } = open(project);
    const captions = await screen.findByRole("checkbox", { name: "Show captions" });
    expect(captions.matches(":disabled")).toBe(true);
    screen.getByText(/You can turn them off once there is a shot on the timeline\./);
    fireEvent.click(captions);
    await act(async () => undefined);
    expect(updateProject).not.toHaveBeenCalled();
  });

  it("turns captions off on a timeline", async () => {
    const { updateProject } = open(cutProject());
    const captions = await screen.findByRole("checkbox", { name: "Show captions" });
    expect(captions.matches(":disabled")).toBe(false);
    fireEvent.click(captions);
    await waitFor(() => expect(updateProject).toHaveBeenCalledTimes(1));
    expect(updateProject.mock.calls[0]![1].timeline?.style).toEqual({ captions: false });
  });

  it("on a cut edited by hand, offers back a voiceover the cut does not play", async () => {
    // The Nocturne ad: edited by hand before soundtracks, with its voice taken off and a song kept.
    const project = cutProject();
    project.soundtrack = undefined;
    project.assets.push({ id: "ast_voice", kind: "audio", role: "voice", path: "assets/ast_voice.wav", durationSec: 3, createdAt: iso() });
    project.timeline = { ...project.timeline!, audio: [{ assetId: "ast_song", role: "music", start: 0, gain: 0.8 }], edited: true };
    open(project);
    const sidebar = await screen.findByRole("complementary", { name: "Media" });
    await within(sidebar).findByRole("button", { name: "Use this voiceover on the timeline" });
    expect(within(sidebar).queryByRole("button", { name: "Use this song on the timeline" })).toBeNull();
  });
});
