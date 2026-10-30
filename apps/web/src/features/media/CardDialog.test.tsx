/**
 * A card's popup by keyboard and its image edit. The arrow keys move through the versions and Enter restores one;
 * Escape closes an open tool before the card. Edit image redraws the card's still as an edit, following a few words,
 * where the setup has an image edit step.
 */
import type { Asset, DraftRequest, Event, Job, Project, Settings, StillRequest, TierSummary } from "@nightshift/contract";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { NightshiftClient, ProjectPatch } from "@/api/client";
import { EngineProvider } from "@/store/engine";
import { Toaster } from "@/ui/primitives";
import { MediaPage } from "./MediaPage";

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
const PID = "prj_card";

const TIER = {
  tier: "apple-64",
  label: "Mac",
  match: { vendor: "apple", minRamGb: 64, minVramGb: 0, unifiedMemory: true },
  downloadGb: 40,
  recommended: true,
  steps: ["still", "video_draft", "video_final_same_take", "effect_end_frame", "video_effect", "camera_layout", "video_camera_move"],
  models: { still: "Krea 2 Turbo", effect_end_frame: "FLUX.2 Klein 4B" },
  estimates: { still: { peakGb: 12, seconds: 20, measured: true }, effect_end_frame: { peakGb: 20, seconds: 25, measured: true } },
} as unknown as TierSummary;

/** A ferry shot: two stills (the first redrawn), two drafts and a same-take final of the first draft, the pick. */
function ferry(): Project {
  const video = (id: string, minute: number): Asset => ({ id, kind: "video", path: `${id}.mp4`, durationSec: 4, createdAt: iso(minute) });
  return {
    id: PID,
    name: "Ferry",
    template: "cinematic_shot",
    aspect: "16:9",
    brief: {},
    shots: [
      {
        id: "shot_1",
        index: 0,
        prompt: "A ferry leaves the pier at dusk",
        cameraMove: "static",
        durationSec: 4,
        stillAssetId: "still_1",
        stillHistory: [
          { assetId: "still_0", prompt: "A ferry at noon", createdAt: iso(0) },
          { assetId: "still_1", prompt: "A ferry leaves the pier at dusk", createdAt: iso(1) },
        ],
        chosenDraftId: "take_1",
        chosenFinalId: "final_1",
        locked: false,
      },
    ],
    takes: [
      { id: "take_1", shotId: "shot_1", rung: "draft", seed: 1, videoAssetId: "v_take_1", jobId: "job_1" },
      { id: "take_2", shotId: "shot_1", rung: "draft", seed: 2, videoAssetId: "v_take_2", jobId: "job_2" },
      { id: "final_1", shotId: "shot_1", rung: "final", finalKind: "same_take", parentTakeId: "take_1", seed: 1, videoAssetId: "v_final_1", jobId: "job_3" },
    ],
    assets: [
      { id: "still_0", kind: "image", path: "still_0.png", createdAt: iso(0) },
      { id: "still_1", kind: "image", path: "still_1.png", createdAt: iso(1) },
      video("v_take_1", 2),
      video("v_take_2", 3),
      video("v_final_1", 4),
    ],
    timeline: null,
    createdAt: iso(),
    updatedAt: iso(),
  };
}

/** A set-up engine with one project. It records what the popup asks for. */
class FakeEngine {
  stills: Array<{ shotId: string; body: StillRequest | undefined }> = [];
  drafts: Array<{ shotId: string; body: DraftRequest | undefined }> = [];
  patches: ProjectPatch[] = [];
  tier: TierSummary = TIER;
  settings: Settings = { tier: "apple-64", memoryLimitGb: null, overnight: { enabled: false, startAt: "23:00", endAt: "07:00" }, remote: null } as Settings;

  constructor(public project: Project) {}

  client(): NightshiftClient {
    const answer = <T,>(fn: () => T): Promise<T> => Promise.resolve().then(() => structuredClone(fn()));
    const job = (step: Job["step"], shotId: string): Job => ({ id: `job_${Math.random()}`, projectId: PID, shotId, step, mode: "now", status: "queued", progress: 0, outputAssetIds: [], createdAt: iso() });
    const known: Partial<NightshiftClient> = {
      kind: "http",
      status: () => answer(() => ({ phase: "ready" as const, tier: "apple-64" as const, comfyui: { running: true, url: "http://127.0.0.1:8188", version: "0.3" }, memoryUsedGb: null, mode: "local" as const })),
      settings: () => answer(() => this.settings),
      onboarding: () => answer(() => ({ done: true, sampleProjectId: null })),
      tiers: () => answer(() => [this.tier]),
      listProjects: () => answer(() => [this.project]),
      listJobs: () => answer(() => []),
      getProject: () => answer(() => this.project),
      updateProject: (_id, patch) =>
        answer(() => {
          this.patches.push(structuredClone(patch));
          this.project = { ...this.project, ...patch } as Project;
          return this.project;
        }),
      still: (_id, shotId, body) =>
        answer(() => {
          this.stills.push({ shotId, body: structuredClone(body) });
          return job("still", shotId);
        }),
      draft: (_id, shotId, body) =>
        answer(() => {
          this.drafts.push({ shotId, body: structuredClone(body) });
          return job("video_draft", shotId);
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

function show(engine: FakeEngine) {
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

/** Opens the card from the board, as a click on it does, and returns the popup. */
async function openCard(name = "Open A ferry leaves the pier at dusk") {
  const opener = (await screen.findAllByRole("button", { name }))[0]!;
  opener.focus();
  fireEvent.click(opener);
  await screen.findByRole("list", { name: "Versions" });
  return { dialog: screen.getByRole("dialog"), opener };
}

const version = (name: string) => within(screen.getByRole("list", { name: "Versions" })).getByRole("button", { name });
const PICK = "Version 5, Final, same take, the pick";
const key = (el: Element, k: string) => fireEvent.keyDown(el, { key: k });

describe("Card popup", () => {
  it("opens on the pick, the arrow keys move through the versions and Enter restores the one selected", async () => {
    const engine = new FakeEngine(ferry());
    show(engine);
    await openCard();
    await waitFor(() => expect(document.activeElement).toBe(version(PICK)));
    expect(version(PICK).getAttribute("aria-pressed")).toBe("true");

    // Only the selected version is in the Tab order; the arrows reach the others.
    expect(version("Version 4, Draft").tabIndex).toBe(-1);
    key(version(PICK), "ArrowLeft");
    expect(version("Version 4, Draft").getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(version("Version 4, Draft"));
    expect(version("Version 4, Draft").tabIndex).toBe(0);

    key(version("Version 4, Draft"), "Home");
    expect(document.activeElement).toBe(version("Version 1, Still"));
    key(version("Version 1, Still"), "ArrowLeft");
    expect(document.activeElement).toBe(version("Version 1, Still"));
    key(version("Version 1, Still"), "End");
    expect(document.activeElement).toBe(version(PICK));

    // Enter on the pick changes nothing; on an older version it makes that one the pick.
    key(version(PICK), "Enter");
    key(version(PICK), "ArrowLeft");
    key(version("Version 4, Draft"), "Enter");
    await waitFor(() => expect(engine.patches).toHaveLength(1));
    expect(engine.patches[0]!.shots?.[0]).toMatchObject({ id: "shot_1", chosenDraftId: "take_2", useStill: false });
  });

  it("Left and Right move through the versions from a button, but not from a text field", async () => {
    show(new FakeEngine(ferry()));
    const { dialog } = await openCard();
    const close = within(dialog).getByRole("button", { name: "Close" });
    close.focus();
    key(close, "ArrowLeft");
    expect(version("Version 4, Draft").getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(version("Version 4, Draft"));

    const prompt = within(dialog).getByLabelText("Prompt");
    prompt.focus();
    key(prompt, "ArrowLeft");
    expect(version("Version 4, Draft").getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(prompt);
  });

  it("Escape closes an open tool first and returns to its button; the next Escape closes the card", async () => {
    show(new FakeEngine(ferry()));
    const { dialog, opener } = await openCard();
    const effect = within(dialog).getByRole("button", { name: "Effect" });
    fireEvent.click(effect);
    expect(effect.getAttribute("aria-expanded")).toBe("true");
    const gallery = within(dialog).getByRole("radiogroup", { name: "Effect" });

    key(within(gallery).getAllByRole("radio")[0]!, "Escape");
    expect(within(dialog).queryByRole("radiogroup", { name: "Effect" })).toBeNull();
    expect(effect.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(effect);
    expect(screen.getByRole("list", { name: "Versions" })).toBeTruthy();

    key(effect, "Escape");
    await waitFor(() => expect(screen.queryByRole("list", { name: "Versions" })).toBeNull());
    expect(document.activeElement).toBe(opener);
  });

  it("Edit image redraws the still as an edit, from the still on show, as a new version of the card", async () => {
    const engine = new FakeEngine(ferry());
    const first = show(engine);
    let { dialog } = await openCard();

    // The pick is a final: the edit starts from the card's still.
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit image" }));
    const words = within(dialog).getByRole("textbox", { name: "What to change" });
    expect(document.activeElement).toBe(words);
    expect(within(dialog).getByText(/Edits the card's still\. The result is a new version of this card\. About 25 seconds with FLUX\.2 Klein 4B\./)).toBeTruthy();
    const make = within(dialog).getByRole("button", { name: "Make the edit" }) as HTMLButtonElement;
    expect(make.disabled).toBe(true);
    fireEvent.change(words, { target: { value: "Make it night" } });
    fireEvent.click(make);
    await waitFor(() => expect(engine.stills).toEqual([{ shotId: "shot_1", body: { prompt: "Make it night", editFrom: "still_1" } }]));
    await waitFor(() => expect(within(dialog).queryByRole("textbox", { name: "What to change" })).toBeNull());
    // The edit is a new still of the card: its prompt stays as it was. While it is on its way, no second edit starts.
    expect(engine.patches).toEqual([]);
    expect((within(dialog).getByRole("button", { name: "Edit image" }) as HTMLButtonElement).disabled).toBe(true);
    first.unmount();

    // An older still on show is the one edited. Enter in the field makes the edit.
    const later = new FakeEngine(ferry());
    show(later);
    ({ dialog } = await openCard());
    fireEvent.click(version("Version 1, Still"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit image" }));
    expect(within(dialog).getByText(/Edits the still on show\./)).toBeTruthy();
    const again = within(dialog).getByRole("textbox", { name: "What to change" });
    fireEvent.change(again, { target: { value: "Remove the car" } });
    fireEvent.submit(again.closest("form")!);
    await waitFor(() => expect(later.stills).toEqual([{ shotId: "shot_1", body: { prompt: "Remove the car", editFrom: "still_0" } }]));
  });

  it("offers Edit image only where the setup has an image edit step, and never on a quick shot", async () => {
    const noEdit = new FakeEngine(ferry());
    noEdit.tier = { ...TIER, steps: TIER.steps!.filter((s) => s !== "effect_end_frame") };
    const first = show(noEdit);
    const { dialog } = await openCard();
    expect(within(dialog).getByRole("button", { name: "Redraw still" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Edit image" })).toBeNull();
    first.unmount();

    const quick = ferry();
    quick.template = "camera_move";
    quick.brief = { photoAssetId: "still_1", move: "dolly_in" };
    quick.shots[0] = { ...quick.shots[0]!, cameraMove: "dolly_in" };
    show(new FakeEngine(quick));
    const card = await openCard("Open Camera move, Dolly in");
    expect(within(card.dialog).queryByRole("button", { name: "Edit image" })).toBeNull();
    expect(within(card.dialog).queryByRole("button", { name: "Redraw still" })).toBeNull();
  });
});
