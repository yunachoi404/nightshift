/**
 * Media as a user meets it: the prompt panel makes new cards on the board (in the shape and number asked for), a tool
 * that starts from an image waits for one picked on the board, dropped on the panel or uploaded, and a card opens on
 * its history, where an older version can be restored and the pick can be finished tonight.
 */
import { quickEffects, type Asset, type Reference, type DraftRequest, type Event, type FinalKind, type Job, type MakeRequest, type Project, type Settings, type StillRequest, type TierSummary } from "@nightshift/contract";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { NightshiftClient, ProjectPatch } from "@/api/client";
import { EngineProvider } from "@/store/engine";
import { Toaster } from "@/ui/primitives";
import { MediaPage } from "./MediaPage";
import { DRAG_TYPE } from "./items";

vi.mock("@/api/config", () => ({
  API_KEY: "nightshift.api",
  buildApiBase: () => "",
  isMock: () => false,
  isDevMock: () => false,
  isBrowserDemo: () => false,
  getClient: () => {
    throw new Error("each test gives the page its own client");
  },
}));

// jsdom has no modal dialogs.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new window.Event("close"));
  };
});

const iso = (minute = 0) => new Date(Date.UTC(2026, 9, 30, 9, minute)).toISOString();
const PID = "prj_media";

const TIER = {
  tier: "apple-64",
  label: "Mac",
  match: { vendor: "apple", minRamGb: 64, minVramGb: 0, unifiedMemory: true },
  downloadGb: 40,
  recommended: true,
  steps: ["still", "video_draft", "video_final_same_take", "effect_end_frame", "video_effect", "camera_layout", "video_camera_move"],
  models: { still: "Krea 2 Turbo", video_draft: "LTX-2.5", effect_end_frame: "FLUX.2 Klein 4B", video_effect: "LTX-2.5" },
  estimates: {
    still: { peakGb: 12, seconds: 20, measured: true },
    effect_end_frame: { peakGb: 20, seconds: 25, measured: true },
    video_effect: { peakGb: 30, seconds: 40, measured: true },
    video_final_same_take: { peakGb: 30, seconds: 180, measured: true },
  },
} as unknown as TierSummary;

function blank(): Project {
  return { id: PID, name: "Blank", template: "blank", aspect: "16:9", brief: {}, shots: [], takes: [], assets: [], timeline: null, createdAt: iso(), updatedAt: iso() };
}

/** A ferry shot: a still, two drafts and a same-take final of the first, and an uploaded photo. */
function ferry(): Project {
  const video = (id: string, minute: number): Asset => ({ id, kind: "video", path: `${id}.mp4`, durationSec: 4, createdAt: iso(minute) });
  return {
    ...blank(),
    name: "Ferry",
    template: "cinematic_shot",
    shots: [{ id: "shot_1", index: 0, prompt: "A ferry leaves the pier at dusk", cameraMove: "static", durationSec: 4, stillAssetId: "still_1", chosenDraftId: "take_1", chosenFinalId: "final_1", locked: false }],
    takes: [
      { id: "take_1", shotId: "shot_1", rung: "draft", seed: 1, videoAssetId: "v_take_1", jobId: "job_1" },
      { id: "take_2", shotId: "shot_1", rung: "draft", seed: 2, videoAssetId: "v_take_2", jobId: "job_2" },
      { id: "final_1", shotId: "shot_1", rung: "final", finalKind: "same_take", parentTakeId: "take_1", seed: 1, videoAssetId: "v_final_1", jobId: "job_3" },
    ],
    assets: [{ id: "still_1", kind: "image", path: "still_1.png", createdAt: iso(1) }, video("v_take_1", 2), video("v_take_2", 3), video("v_final_1", 4), { id: "photo", kind: "image", role: "reference", path: "photo.jpg", width: 1200, height: 900, createdAt: iso(5) }],
  };
}

/** A set-up engine with one project. It records what the page asks for. */
class FakeEngine {
  makes: MakeRequest[] = [];
  finals: Array<{ shotId: string; draftId: string; kind: FinalKind; mode: "now" | "overnight" }> = [];
  drafts: Array<{ shotId: string; body: DraftRequest | undefined }> = [];
  stills: Array<{ shotId: string; body: StillRequest | undefined }> = [];
  patches: ProjectPatch[] = [];
  uploads: Array<{ name: string; role?: string; boardId?: string }> = [];
  jobs: Job[] = [];
  tier: TierSummary = TIER;
  settings: Settings = { tier: "apple-64", memoryLimitGb: null, overnight: { enabled: false, startAt: "23:00", endAt: "07:00" }, remote: null } as Settings;

  constructor(public project: Project) {}

  client(): NightshiftClient {
    const answer = <T,>(fn: () => T): Promise<T> => Promise.resolve().then(() => structuredClone(fn()));
    const job = (step: Job["step"], shotId?: string): Job => ({ id: `job_${Math.random()}`, projectId: PID, ...(shotId ? { shotId } : {}), step, mode: "now", status: "queued", progress: 0, outputAssetIds: [], createdAt: iso() });
    const known: Partial<NightshiftClient> = {
      kind: "http",
      status: () => answer(() => ({ phase: "ready" as const, tier: "apple-64" as const, comfyui: { running: true, url: "http://127.0.0.1:8188", version: "0.3" }, memoryUsedGb: null, mode: "local" as const })),
      settings: () => answer(() => this.settings),
      updateSettings: (patch) => answer(() => (this.settings = { ...this.settings, ...patch })),
      onboarding: () => answer(() => ({ done: true, sampleProjectId: null })),
      tiers: () => answer(() => [this.tier]),
      listProjects: () => answer(() => [this.project]),
      listJobs: () => answer(() => this.jobs),
      getProject: () => answer(() => this.project),
      updateProject: (_id, patch) =>
        answer(() => {
          this.patches.push(structuredClone(patch));
          this.project = { ...this.project, ...patch } as Project;
          return this.project;
        }),
      make: (_id, body) =>
        answer(() => {
          this.makes.push(structuredClone(body));
          return job(body.tool === "image" ? "still" : "video_effect");
        }),
      draft: (_id, shotId, body) =>
        answer(() => {
          this.drafts.push({ shotId, body: structuredClone(body) });
          return job("video_draft", shotId);
        }),
      still: (_id, shotId, body) =>
        answer(() => {
          this.stills.push({ shotId, body: structuredClone(body) });
          return job("still", shotId);
        }),
      final: (_id, shotId, body) =>
        answer(() => {
          this.finals.push({ shotId, ...body });
          return { ...job("video_final_same_take", shotId), mode: body.mode };
        }),
      uploadAsset: (_id, file, opts) =>
        answer(() => {
          const asset: Asset = { id: `upload_${this.uploads.length + 1}`, kind: "image", role: opts?.role ?? "reference", path: file.name, createdAt: iso(20) };
          this.uploads.push({ name: file.name, ...opts });
          this.project = { ...this.project, assets: [...this.project.assets, asset] };
          return asset;
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

function open(engine: FakeEngine) {
  return render(
    <EngineProvider client={engine.client()}>
      <MemoryRouter initialEntries={[`/p/${PID}/media`]}>
        <Routes>
          <Route path="/p/:id/media" element={<MediaPage />} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </EngineProvider>,
  );
}

const tool = (name: string) => screen.getByRole("radio", { name });
const failedJob = (step: Job["step"], shotId: string): Job => ({ id: `job_failed_${step}`, projectId: PID, shotId, step, mode: "now", status: "failed", progress: 0, error: "Out of memory", outputAssetIds: [], createdAt: iso(9) });

/** A What if? film made from a photo: its one shot, the photo as its first beat, and a second upload. */
function whatIf(): Project {
  const beat = (n: number) => ({ id: `beat_${n}`, prompt: `Beat ${n}`, line: "", ...(n === 1 ? { stillAssetId: "photo" } : {}) });
  return {
    ...blank(),
    name: "Low tide",
    template: "what_if",
    brief: { idea: "What if the tide never came back?", photoAssetId: "photo" },
    shots: [{ id: "film", index: 0, prompt: "The tide goes out and stays out", cameraMove: "static", durationSec: 15, stillAssetId: "photo", keyframes: [1, 2, 3, 4].map(beat), locked: false }],
    assets: [
      { id: "photo", kind: "image", role: "reference", path: "photo.jpg", createdAt: iso(1) },
      { id: "upload", kind: "image", role: "reference", path: "upload.jpg", createdAt: iso(2) },
    ],
  };
}

/** A camera-move quick shot made before the tools: its photo, one take with no tool, and another upload. */
function cameraShot(): Project {
  return {
    ...blank(),
    name: "Harbour",
    template: "camera_move",
    brief: { photoAssetId: "photo", move: "dolly_in" },
    shots: [{ id: "shot_1", index: 0, prompt: "The scene in the photo.", cameraMove: "dolly_in", durationSec: 4, stillAssetId: "photo", locked: false }],
    takes: [{ id: "take_1", shotId: "shot_1", rung: "draft", seed: 1, videoAssetId: "v_take_1", jobId: "job_1" }],
    assets: [
      { id: "photo", kind: "image", role: "reference", path: "photo.jpg", createdAt: iso(1) },
      { id: "v_take_1", kind: "video", path: "v_take_1.mp4", durationSec: 4, createdAt: iso(2) },
      { id: "upload", kind: "image", role: "reference", path: "upload.jpg", createdAt: iso(3) },
    ],
  };
}
/** The Generate bar, by what it says it does. */
const bar = (name = "Generate image") => screen.getByRole("button", { name }) as HTMLButtonElement;
const option = (group: string, name: string) => within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name });
const photo = (name = "rae_portrait-2.png") => new File(["png"], name, { type: "image/png" });

describe("Media", () => {
  it("a blank project shows the prompt panel, its one board and where to start", async () => {
    open(new FakeEngine(blank()));
    expect(await screen.findByText("Nothing here yet")).toBeTruthy();
    expect(screen.getByText("Write a prompt on the left to make your first image, or upload a photo.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Board 1" })).toBeTruthy();
    await waitFor(() => expect(tool("Image").getAttribute("aria-checked")).toBe("true"));
    expect(bar().disabled).toBe(true);
    expect(screen.getByText("Write a prompt first.")).toBeTruthy();
    // The model the tool runs here, in plain words.
    expect(await screen.findByText("Krea 2 Turbo")).toBeTruthy();
    expect(screen.getByText("On the timeline: 0 shots, 0:00")).toBeTruthy();
  });

  it("an image prompt makes a new card on the board, from the bar or with Cmd+Enter", async () => {
    const engine = new FakeEngine(blank());
    open(engine);
    fireEvent.change(await screen.findByLabelText("Prompt"), { target: { value: "A lighthouse at dusk" } });
    await waitFor(() => expect(bar().disabled).toBe(false));
    expect(screen.getByText("About 20 s on this computer")).toBeTruthy();
    fireEvent.click(bar());
    await waitFor(() => expect(engine.makes).toEqual([{ tool: "image", boardId: "board_main", prompt: "A lighthouse at dusk" }]));
    await waitFor(() => expect(bar().disabled).toBe(false));
    fireEvent.keyDown(screen.getByLabelText("Prompt"), { key: "Enter", metaKey: true });
    await waitFor(() => expect(engine.makes).toHaveLength(2));
  });

  it("the shape goes with a card only when it is not the project's", async () => {
    const engine = new FakeEngine(blank());
    open(engine);
    fireEvent.change(await screen.findByLabelText("Prompt"), { target: { value: "A lighthouse at dusk" } });
    await waitFor(() => expect(bar().disabled).toBe(false));
    fireEvent.click(option("Format", "9:16"));
    fireEvent.click(bar());
    await waitFor(() => expect(engine.makes).toHaveLength(1));
    expect(engine.makes[0]).toMatchObject({ tool: "image", aspect: "9:16" });

    fireEvent.click(option("Format", "16:9"));
    await waitFor(() => expect(bar().disabled).toBe(false));
    fireEvent.click(bar());
    await waitFor(() => expect(engine.makes).toHaveLength(2));
    expect(engine.makes[1]).not.toHaveProperty("aspect");
  });

  it("variations make one card each, with distinct random seeds, or counting up from a fixed seed", async () => {
    const engine = new FakeEngine(blank());
    open(engine);
    fireEvent.change(await screen.findByLabelText("Prompt"), { target: { value: "A lighthouse at dusk" } });
    fireEvent.click(option("Variations", "3"));
    await waitFor(() => expect(bar("Generate 3 images").disabled).toBe(false));
    expect(screen.getByText("About 20 s each on this computer")).toBeTruthy();
    fireEvent.click(bar("Generate 3 images"));
    await waitFor(() => expect(engine.makes).toHaveLength(3));
    const seeds = engine.makes.map((m) => m.seed);
    expect(seeds.every((x) => typeof x === "number" && Number.isInteger(x) && x >= 0)).toBe(true);
    expect(new Set(seeds).size).toBe(3);
    expect(engine.makes.every((m) => m.prompt === "A lighthouse at dusk" && m.tool === "image")).toBe(true);

    fireEvent.click(option("Seed", "Fixed"));
    fireEvent.change(screen.getByRole("textbox", { name: "Seed number" }), { target: { value: "42" } });
    await waitFor(() => expect(bar("Generate 3 images").disabled).toBe(false));
    fireEvent.click(bar("Generate 3 images"));
    await waitFor(() => expect(engine.makes).toHaveLength(6));
    expect(engine.makes.slice(3).map((m) => m.seed)).toEqual([42, 43, 44]);
  });

  it("a video has the lengths this setup makes and a camera, and sends its length", async () => {
    const engine = new FakeEngine(blank());
    engine.tier = { ...TIER, longestShotSec: 3.04 } as TierSummary;
    open(engine);
    await waitFor(() => expect(tool("Video").hasAttribute("disabled")).toBe(false));
    fireEvent.click(tool("Video"));
    expect(within(screen.getByRole("radiogroup", { name: "Length" })).getAllByRole("radio").map((r) => r.textContent)).toEqual(["2 s", "3 s"]);
    fireEvent.click(option("Length", "2 s"));
    fireEvent.change(screen.getByLabelText("Camera"), { target: { value: "dolly_in" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Waves at dusk" } });
    fireEvent.click(bar("Make video"));
    await waitFor(() => expect(engine.makes).toEqual([{ tool: "video", boardId: "board_main", prompt: "Waves at dusk", move: "dolly_in", durationSec: 2 }]));
  });

  it("Effect waits for an image: picking one on the board enables the bar, which makes the effect there", async () => {
    const engine = new FakeEngine(ferry());
    open(engine);
    await screen.findByRole("heading", { name: "Shots" });
    await waitFor(() => expect(tool("Effect").hasAttribute("disabled")).toBe(false));
    fireEvent.click(tool("Effect"));
    expect(bar("Apply effect").disabled).toBe(true);
    expect(screen.getByText("Choose an image first.")).toBeTruthy();
    expect(screen.getByText("Click a card on the board")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Use Upload" }));
    await waitFor(() => expect(bar("Apply effect").disabled).toBe(false));
    expect(screen.getByText("About a minute on this computer")).toBeTruthy();
    fireEvent.click(bar("Apply effect"));
    await waitFor(() => expect(engine.makes).toEqual([{ tool: "effect", boardId: "board_main", imageAssetId: "photo", effect: quickEffects[0]!.id }]));
  });

  it("a shot card hands over its still, and an image card starts a tool from its image", async () => {
    const engine = new FakeEngine(ferry());
    open(engine);
    await screen.findByRole("heading", { name: "Shots" });
    fireEvent.click(screen.getByRole("button", { name: "Camera move from Upload" }));
    expect(tool("Camera move").getAttribute("aria-checked")).toBe("true");
    expect(bar("Make camera move").disabled).toBe(false);
    // The card it starts from is marked on the board.
    expect(screen.getByRole("group", { name: "Upload" }).classList.contains("mp-card--source")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByRole("button", { name: "Use the still of A ferry leaves the pier at dusk" }));
    expect(screen.getByRole("group", { name: "A ferry leaves the pier at dusk" }).classList.contains("mp-card--source")).toBe(true);
    fireEvent.click(bar("Make camera move"));
    await waitFor(() => expect(engine.makes[0]).toMatchObject({ tool: "camera_move", imageAssetId: "still_1", move: "dolly_in" }));
  });

  it("Edit changes an image as the words say: a new card whose still is the edit", async () => {
    const engine = new FakeEngine(ferry());
    open(engine);
    await screen.findByRole("heading", { name: "Shots" });
    fireEvent.click(await screen.findByRole("button", { name: "Edit from Upload" }));
    expect(tool("Edit").getAttribute("aria-checked")).toBe("true");
    expect(bar("Make the edit").disabled).toBe(true);
    expect(screen.getByText("Say what to change.")).toBeTruthy();
    expect(screen.getByText("FLUX.2 Klein 4B")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("What to change"), { target: { value: "Make it night" } });
    fireEvent.click(bar("Make the edit"));
    await waitFor(() => expect(engine.makes).toEqual([{ tool: "edit", boardId: "board_main", prompt: "Make it night", imageAssetId: "photo" }]));
  });

  it("Edit is offered only where the setup can edit images", async () => {
    const engine = new FakeEngine(ferry());
    engine.tier = { ...TIER, steps: TIER.steps!.filter((s) => s !== "effect_end_frame" && s !== "video_effect") } as TierSummary;
    open(engine);
    await screen.findByRole("heading", { name: "Shots" });
    await waitFor(() => expect(tool("Effect").hasAttribute("disabled")).toBe(true));
    expect(screen.queryByRole("radio", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit from Upload" })).toBeNull();
  });

  it("a photo dropped on the source well is uploaded to the board and becomes the image to start from", async () => {
    const engine = new FakeEngine(ferry());
    open(engine);
    await screen.findByRole("heading", { name: "Shots" });
    await waitFor(() => expect(tool("Effect").hasAttribute("disabled")).toBe(false));
    fireEvent.click(tool("Effect"));
    fireEvent.drop(screen.getByTestId("source-well"), { dataTransfer: { types: ["Files"], files: [photo("bottle.png")] } });
    await waitFor(() => expect(bar("Apply effect").disabled).toBe(false));
    expect(engine.uploads).toEqual([{ name: "bottle.png", role: "reference", boardId: "board_main" }]);
    fireEvent.click(bar("Apply effect"));
    await waitFor(() => expect(engine.makes[0]).toMatchObject({ tool: "effect", imageAssetId: "upload_1" }));

    // A card dragged from the board hands over its picture: a shot its current still.
    fireEvent.drop(screen.getByTestId("source-well"), { dataTransfer: { types: [DRAG_TYPE], files: [], getData: (t: string) => (t === DRAG_TYPE ? JSON.stringify({ items: ["shot_1"] }) : "") } });
    await waitFor(() => expect(bar("Apply effect").disabled).toBe(false));
    fireEvent.click(bar("Apply effect"));
    await waitFor(() => expect(engine.makes[1]).toMatchObject({ tool: "effect", imageAssetId: "still_1" }));
  });

  it("a reference added from the panel is uploaded, saved with its kind and name, and drawn with", async () => {
    const engine = new FakeEngine(blank());
    open(engine);
    await screen.findByText("Nothing here yet");
    fireEvent.change(screen.getByLabelText("Reference photo"), { target: { files: [photo()] } });
    const form = await screen.findByRole("group", { name: "New reference" });
    expect((within(form).getByLabelText("Name") as HTMLInputElement).value).toBe("rae portrait 2");
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Rae" } });
    fireEvent.click(within(form).getByRole("radio", { name: "Product" }));
    fireEvent.click(within(form).getByRole("button", { name: "Add reference" }));

    await waitFor(() => expect(engine.patches.some((p) => p.references?.length)).toBe(true));
    expect(engine.uploads).toEqual([{ name: "rae_portrait-2.png", role: "reference", boardId: "board_main" }]);
    const saved = engine.patches.find((p) => p.references)!.references![0] as Reference;
    expect(saved).toMatchObject({ assetId: "upload_1", label: "Rae", kind: "product" });
    const chip = await within(screen.getByRole("group", { name: "References" })).findByRole("button", { name: "Rae" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Rae on a rooftop" } });
    fireEvent.click(bar());
    await waitFor(() => expect(engine.makes[0]).toMatchObject({ tool: "image", referenceIds: [saved.id] }));
  });

  it("opening a card shows its history, oldest first, with the pick marked", async () => {
    open(new FakeEngine(ferry()));
    fireEvent.click((await screen.findAllByRole("button", { name: "Open A ferry leaves the pier at dusk" }))[0]!);
    const versions = await screen.findByRole("list", { name: "Versions" });
    expect(within(versions).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Version 1, Still",
      "Version 2, Draft",
      "Version 3, Draft",
      "Version 4, Final, same take, the pick",
    ]);
  });

  it("Restore makes an older version the pick", async () => {
    const engine = new FakeEngine(ferry());
    open(engine);
    fireEvent.click((await screen.findAllByRole("button", { name: "Open A ferry leaves the pier at dusk" }))[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Version 3, Draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(engine.patches).toHaveLength(1));
    expect(engine.patches[0]!.shots?.[0]).toMatchObject({ id: "shot_1", chosenDraftId: "take_2", useStill: false });
  });

  it("Finish tonight queues the picked take's final for tonight", async () => {
    const project = ferry();
    project.shots[0] = { ...project.shots[0]!, chosenFinalId: undefined };
    project.takes = project.takes.filter((t) => t.rung === "draft");
    const engine = new FakeEngine(project);
    open(engine);
    fireEvent.click((await screen.findAllByRole("button", { name: "Open A ferry leaves the pier at dusk" }))[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Finish tonight" }));
    expect(screen.getByText("Tonight, while you sleep")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Queue for tonight" })));
    await waitFor(() => expect(engine.finals).toEqual([{ shotId: "shot_1", draftId: "take_1", kind: "same_take", mode: "overnight" }]));
    expect(engine.settings.overnight.enabled).toBe(true);
  });

  it("a What if? film offers no tools: the engine makes no new cards there, and its photo is the film's, not a card", async () => {
    open(new FakeEngine(whatIf()));
    expect(await screen.findByText("A What if? film is one continuous shot. Start a new project to make more cards.")).toBeTruthy();
    await waitFor(() => expect(tool("Image").hasAttribute("disabled")).toBe(true));
    expect(bar().disabled).toBe(true);
    expect(screen.queryByLabelText("Prompt")).toBeNull();
    // The opening photo shows on the film card only. The other upload has no tools and cannot join the one-shot film.
    expect(screen.getAllByRole("group", { name: "Upload" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Effect from Upload" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add Upload to the timeline" })).toBeNull();
  });

  it("a quick shot offers no tools, no redraw of its photo, and makes another take on its own path", async () => {
    const engine = new FakeEngine(cameraShot());
    open(engine);
    expect(await screen.findByText("This project turns one photo into one shot. Start a new project to use the tools.")).toBeTruthy();
    await waitFor(() => expect(tool("Effect").hasAttribute("disabled")).toBe(true));
    expect(bar().disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Camera move from Upload" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add Upload to the timeline" })).toBeTruthy();

    fireEvent.click((await screen.findAllByRole("button", { name: "Open Camera move, Dolly in" }))[0]!);
    expect(await screen.findByRole("button", { name: "Version 2, Camera move, Dolly in, the pick" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Redraw still" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Another take" }));
    // Its old take records no tool: the engine makes the project's own move again.
    await waitFor(() => expect(engine.drafts).toEqual([{ shotId: "shot_1", body: {} }]));
  });

  it("Apply effect follows the shot's prompt and never rewrites it; a card made from an image asks what should change", async () => {
    const engine = new FakeEngine(ferry());
    open(engine);
    fireEvent.click((await screen.findAllByRole("button", { name: "Open A ferry leaves the pier at dusk" }))[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Effect" }));
    expect(screen.queryByRole("textbox", { name: "Subject" })).toBeNull();
    expect(screen.getByText("The effect follows the prompt above.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Apply effect" }));
    await waitFor(() => expect(engine.drafts).toEqual([{ shotId: "shot_1", body: { tool: { kind: "effect", effect: quickEffects[0]!.id } } }]));
    expect(engine.patches).toEqual([]);
  });

  it("an image card's effect takes a subject, as its words", async () => {
    const project = ferry();
    project.shots = [{ id: "shot_2", index: 0, prompt: "", durationSec: 4, stillAssetId: "photo", locked: false, onTimeline: false }];
    project.takes = [];
    const engine = new FakeEngine(project);
    open(engine);
    fireEvent.click((await screen.findAllByRole("button", { name: "Open Shot 1" }))[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Effect" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), { target: { value: "The amber bottle" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply effect" }));
    await waitFor(() => expect(engine.drafts).toHaveLength(1));
    expect(engine.patches[0]!.shots?.[0]).toMatchObject({ id: "shot_2", prompt: "The amber bottle" });
  });

  it("a locked card's effect never writes to it", async () => {
    const project = ferry();
    project.shots = [{ id: "shot_2", index: 0, prompt: "", durationSec: 4, stillAssetId: "photo", locked: true }];
    project.takes = [];
    open(new FakeEngine(project));
    fireEvent.click((await screen.findAllByRole("button", { name: "Open Shot 1" }))[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Effect" }));
    expect(screen.getByRole("button", { name: "Apply effect" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Subject" })).toBeNull();
  });

  it("on a cut edited by hand, a change to the cut says it keeps its clips until re-cut; new words do not", async () => {
    const project = ferry();
    project.timeline = { clips: [{ shotId: "shot_1", assetId: "v_final_1", start: 0, in: 0, out: 4 }], audio: [], captions: [], style: {}, edited: true };
    const engine = new FakeEngine(project);
    open(engine);
    fireEvent.click((await screen.findAllByRole("button", { name: "Open A ferry leaves the pier at dusk" }))[0]!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Prompt"), { target: { value: "A ferry leaves the pier at night" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(engine.patches).toHaveLength(1));
    await act(async () => undefined);
    expect(screen.queryByText("This cut was edited by hand")).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Take off the timeline" }));
    expect(await screen.findByText("This cut was edited by hand")).toBeTruthy();
    expect(screen.getByText("It keeps its clips until you re-cut it. Open the editor and choose Re-cut to lay out the timeline with your change.")).toBeTruthy();
  });

  it("Try again runs a failed still again, opens the card for a failed effect, and sends a What if? card to its story", async () => {
    const stillFailed = new FakeEngine(ferry());
    stillFailed.jobs = [failedJob("still", "shot_1")];
    const first = open(stillFailed);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(stillFailed.stills).toEqual([{ shotId: "shot_1", body: undefined }]));
    first.unmount();

    // The pick is a Freeze; the effect that failed may have been another.
    const frozen = ferry();
    frozen.takes.push({ id: "take_3", shotId: "shot_1", rung: "draft", seed: 3, videoAssetId: "v_take_2", jobId: "job_4", tool: { kind: "effect", effect: "freeze" } });
    frozen.shots[0] = { ...frozen.shots[0]!, chosenDraftId: "take_3", chosenFinalId: undefined };
    const effectFailed = new FakeEngine(frozen);
    effectFailed.jobs = [failedJob("video_effect", "shot_1")];
    const second = open(effectFailed);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    // Which effect failed is not known: the card opens to choose it again.
    expect(await screen.findByRole("list", { name: "Versions" })).toBeTruthy();
    expect(effectFailed.drafts).toEqual([]);
    second.unmount();

    const film = new FakeEngine(whatIf());
    film.jobs = [failedJob("still", "film")];
    open(film);
    const story = await screen.findByRole("link", { name: "Open the story" });
    expect(story.getAttribute("href")).toBe(`/p/${PID}/storyboard`);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(film.stills).toEqual([]);
  });
});
