/**
 * New project only creates: a name, a format and a preset. It queues nothing on the GPU, never writes a shot list, and
 * opens the project's Media. A project has two areas, Media and Editor, and opens on Media.
 */
import type { Event, Job, Project, TierSummary } from "@nightshift/contract";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateProjectBody, NightshiftClient } from "@/api/client";
import { EngineProvider } from "@/store/engine";
import { App } from "./App";

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

// Media is its own feature. These tests are about getting there.
vi.mock("@/features/media/MediaPage", () => ({ MediaPage: () => <h1>Media page</h1> }));

URL.revokeObjectURL ??= () => undefined;
URL.createObjectURL ??= () => "blob:test";
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;

const iso = () => new Date().toISOString();

/** A tier that could run every tool, including the effect and camera move quick shots. */
const FULL: TierSummary = {
  tier: "unified-128-cuda",
  label: "DGX Spark",
  match: { vendor: "nvidia", unifiedMemory: true, minVramGb: 96, minRamGb: 96 },
  downloadGb: 120,
  recommended: true,
  steps: ["still", "video_draft", "video_final_same_take", "voice", "music", "text", "video_what_if", "video_effect", "effect_end_frame", "video_camera_move", "camera_layout"],
  estimates: {},
  longestShotSec: 4.04,
  referenceImageLimit: 3,
};
const NO_WHAT_IF: TierSummary = { ...FULL, steps: FULL.steps!.filter((s) => s !== "video_what_if") };

/** Every call that would put work on the GPU or write a shot list. None should happen on create. */
const WORK = ["storyboard", "make", "still", "draft", "final", "audio", "exportVideo"] as const;

function engine(tier: TierSummary, projects: Project[] = []) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const store = new Map(projects.map((p) => [p.id, p]));
  const answer = <T,>(fn: () => T): Promise<T> => Promise.resolve().then(() => structuredClone(fn()));
  const known: Partial<NightshiftClient> = {
    kind: "http",
    status: () => answer(() => ({ phase: "ready" as const, tier: tier.tier, comfyui: { running: true, url: "http://127.0.0.1:8188", version: "0.41.3" }, memoryUsedGb: null, mode: "local" as const })),
    settings: () => answer(() => ({ tier: tier.tier, memoryLimitGb: null, overnight: { enabled: false, startAt: "23:00", endAt: "07:00" }, remote: null })),
    onboarding: () => answer(() => ({ done: true, sampleProjectId: null })),
    tiers: () => answer(() => [tier]),
    listProjects: () => answer(() => [...store.values()]),
    listJobs: () => answer((): Job[] => []),
    getProject: (id) => answer(() => store.get(id)!),
    createProject: (body: CreateProjectBody) =>
      answer(() => {
        calls.push({ method: "createProject", args: [body] });
        const p: Project = { id: "prj_new", name: body.name, template: body.template, aspect: body.aspect, brief: body.brief, shots: [], takes: [], assets: [], timeline: null, createdAt: iso(), updatedAt: iso() };
        store.set(p.id, p);
        return p;
      }),
    updateProject: (id, patch) =>
      answer(() => {
        calls.push({ method: "updateProject", args: [id, patch] });
        const p = { ...store.get(id)!, ...patch } as Project;
        store.set(id, p);
        return p;
      }),
    uploadAsset: (id, file, opts) =>
      answer(() => {
        calls.push({ method: "uploadAsset", args: [id, file.name, opts] });
        const asset = { id: "ast_upload", kind: file.type.startsWith("audio") ? ("audio" as const) : ("image" as const), path: `assets/${file.name}`, createdAt: iso(), ...(opts?.role ? { role: opts.role } : {}) };
        store.set(id, { ...store.get(id)!, assets: [...store.get(id)!.assets, asset] });
        return asset;
      }),
    assetUrl: (pid, aid) => `/api/projects/${pid}/assets/${aid}`,
    events: (_onEvent: (e: Event) => void, onConnection) => {
      queueMicrotask(() => onConnection?.(true));
      return () => undefined;
    },
  };
  // Anything else is recorded and never answers.
  const client = new Proxy(known as NightshiftClient, {
    get: (target, key) => {
      if (typeof key !== "string" || key in target || key === "then") return Reflect.get(target, key);
      return (...args: unknown[]) => {
        calls.push({ method: key, args });
        return new Promise(() => undefined);
      };
    },
  });
  return { client, calls, work: () => calls.filter((c) => (WORK as readonly string[]).includes(c.method)) };
}

function open(hash: string, client: NightshiftClient) {
  window.location.hash = hash;
  return render(
    <EngineProvider client={client}>
      <App />
    </EngineProvider>,
  );
}

const presetNames = () => within(screen.getByRole("radiogroup", { name: "Preset" })).getAllByRole("radio").map((r) => r.querySelector(".tpl__name")?.textContent);

afterEach(() => {
  window.location.hash = "";
});

describe("new project", () => {
  it("offers Blank first, the film presets, and What if? last; no Effect or Camera move", async () => {
    const full = open("#/new", engine(FULL).client);
    await screen.findByRole("radiogroup", { name: "Preset" });
    expect(presetNames()).toEqual(["Blank", "Cinematic shot", "Product ad", "Music video", "Talking intro", "What if?"]);
    expect(screen.getByRole("radio", { name: /^Blank/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("radio", { name: /^Effect/ })).toBeNull();
    expect(screen.queryByRole("radio", { name: /^Camera move/ })).toBeNull();
    full.unmount();

    const small = open("#/new", engine(NO_WHAT_IF).client);
    await screen.findByRole("radiogroup", { name: "Preset" });
    expect(presetNames()).toEqual(["Blank", "Cinematic shot", "Product ad", "Music video", "Talking intro"]);
    small.unmount();
  });

  it("creates a blank project, queues nothing and opens its Media", async () => {
    const e = engine(FULL);
    const { unmount } = open("#/new", e.client);
    await screen.findByText(/It starts with nothing in it\./);
    expect(screen.getByText("Nothing renders yet. The project opens in Media.")).toBeTruthy();
    expect((screen.getByLabelText("Project name") as HTMLInputElement).value).toBe("Untitled project");
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(window.location.hash).toBe("#/p/prj_new/media"));
    expect(await screen.findByRole("heading", { name: "Media page" })).toBeTruthy();
    expect(e.calls.find((c) => c.method === "createProject")?.args[0]).toEqual({ name: "Untitled project", template: "blank", aspect: "16:9", brief: {} });
    expect(e.work()).toEqual([]);
    unmount();
  });

  it("creates from a preset with every brief field left empty, queues nothing and opens Media", async () => {
    const e = engine(FULL);
    const { unmount } = open("#/new", e.client);
    fireEvent.click(await screen.findByRole("radio", { name: /^Product ad/ }));
    expect(await screen.findByText("The preset only sets up the shot list, the look and the captions. Every field is optional. Nothing renders until you ask.")).toBeTruthy();
    expect(screen.getByText(/You get a 15 second ad with voiceover and captions\.$/)).toBeTruthy();
    // The seeded shot list, as the contract drafts it: five shots, each within a 4 s clip.
    expect(screen.getByText("5 shots, 15 seconds. Nothing renders yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(window.location.hash).toBe("#/p/prj_new/media"));
    const body = e.calls.find((c) => c.method === "createProject")?.args[0] as CreateProjectBody;
    expect(body.template).toBe("product_ad");
    expect(body.aspect).toBe("9:16");
    expect(e.work()).toEqual([]);
    unmount();
  });

  it("uploads \"my song\" as music, and needs it before it creates", async () => {
    const e = engine(FULL);
    const { unmount } = open("#/new", e.client);
    fireEvent.click(await screen.findByRole("radio", { name: /^Music video/ }));
    fireEvent.click(await screen.findByRole("radio", { name: "Use my song" }));
    const create = screen.getByRole("button", { name: "Create project" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    const input = document.querySelector<HTMLInputElement>('.drop input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(["x"], "song.mp3", { type: "audio/mpeg" })] } });
    await waitFor(() => expect(create.disabled).toBe(false));
    fireEvent.click(create);
    await waitFor(() => expect(window.location.hash).toBe("#/p/prj_new/media"));
    expect(e.calls.find((c) => c.method === "uploadAsset")?.args).toEqual(["prj_new", "song.mp3", { role: "music" }]);
    const patch = e.calls.find((c) => c.method === "updateProject")?.args[1] as { brief: Record<string, unknown> };
    expect(patch.brief).toMatchObject({ referenceAssetId: "ast_upload", referenceKind: "song", songSource: "upload" });
    expect(e.work()).toEqual([]);
    unmount();
  });

  it("a What if? needs its question, and creating it writes nothing yet", async () => {
    const e = engine(FULL);
    const { unmount } = open("#/new", e.client);
    fireEvent.click(await screen.findByRole("radio", { name: /^What if\?/ }));
    const create = screen.getByRole("button", { name: "Create project" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("What if?"), { target: { value: "What if the sea froze overnight?" } });
    expect(create.disabled).toBe(false);
    expect(screen.getByText("One continuous film, about 15 seconds. Nothing renders yet.")).toBeTruthy();
    fireEvent.click(create);
    await waitFor(() => expect(window.location.hash).toBe("#/p/prj_new/media"));
    expect(e.work()).toEqual([]);
    unmount();
  });
});

describe("a project's areas", () => {
  const PID = "prj_old";
  const old: Project = {
    id: PID,
    name: "Rain Rider",
    template: "cinematic_shot",
    aspect: "16:9",
    brief: { idea: "A red motorcycle in the rain" },
    shots: [
      { id: "shot_1", index: 0, prompt: "A red motorcycle in the rain", durationSec: 4, locked: false },
      // Made with a tool and kept in Media: not in the cut, not counted.
      { id: "shot_2", index: 1, prompt: "A neon sign", durationSec: 4, locked: false, onTimeline: false },
    ],
    takes: [],
    assets: [],
    timeline: null,
    createdAt: iso(),
    updatedAt: iso(),
  };

  it("are Media and Editor only, and a project opens on Media", async () => {
    const { unmount } = open(`#/p/${PID}`, engine(FULL, [old]).client);
    await waitFor(() => expect(window.location.hash).toBe(`#/p/${PID}/media`));
    const nav = await screen.findByRole("radiogroup", { name: "Project stage" });
    const areas = within(nav).getAllByRole("radio");
    expect(areas.map((r) => r.textContent)).toEqual(["Media", "Editor"]);
    expect(areas[0]!.getAttribute("aria-checked")).toBe("true");
    // The header counts the cut's shots only.
    expect(screen.getByText("1 shot, 4 s")).toBeTruthy();
    fireEvent.click(areas[1]!);
    await waitFor(() => expect(window.location.hash).toBe(`#/p/${PID}/editor`));
    unmount();
  });

  it("Cmd+1 opens Media and Cmd+2 the Editor", async () => {
    const { unmount } = open(`#/p/${PID}/media`, engine(FULL, [old]).client);
    await screen.findByRole("heading", { name: "Media page" });
    fireEvent.keyDown(window, { key: "2", metaKey: true });
    await waitFor(() => expect(window.location.hash).toBe(`#/p/${PID}/editor`));
    fireEvent.keyDown(window, { key: "1", metaKey: true });
    await waitFor(() => expect(window.location.hash).toBe(`#/p/${PID}/media`));
    // No third area.
    fireEvent.keyDown(window, { key: "3", metaKey: true });
    expect(window.location.hash).toBe(`#/p/${PID}/media`);
    unmount();
  });

  it("old storyboard links still open, under Media", async () => {
    const { unmount } = open(`#/p/${PID}/storyboard`, engine(FULL, [old]).client);
    expect(await screen.findByRole("heading", { name: "Storyboard" })).toBeTruthy();
    const nav = screen.getByRole("radiogroup", { name: "Project stage" });
    expect(within(nav).getByRole("radio", { name: "Media" }).getAttribute("aria-checked")).toBe("true");
    unmount();
  });
});

describe("the What if? story editor", () => {
  it("offers to write the story when the project has none and nothing runs", async () => {
    const question: Project = { id: "prj_whatif", name: "What if the sea froze?", template: "what_if", aspect: "9:16", brief: { question: "What if the sea froze overnight?", look: "cinematic" }, shots: [], takes: [], assets: [], timeline: null, createdAt: iso(), updatedAt: iso() };
    const e = engine(FULL, [question]);
    const { unmount } = open(`#/p/${question.id}/storyboard`, e.client);
    fireEvent.click(await screen.findByRole("button", { name: "Write the story" }));
    await waitFor(() => expect(e.work().map((c) => c.method)).toEqual(["storyboard"]));
    unmount();
  });
});
