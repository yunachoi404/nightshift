/**
 * New project creates: a name, a format and a preset, and opens the project's Media. It queues nothing on the GPU,
 * except the writer: a film whose brief has words gets its shot list written as soon as its photos and references are
 * in. A project has two areas, Media and Editor, and opens on Media.
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
/** A setup with no writer: its films keep their template's shot list. */
const NO_WRITER: TierSummary = { ...FULL, steps: FULL.steps!.filter((s) => s !== "text") };

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
    storyboard: (id) =>
      answer((): Job => {
        calls.push({ method: "storyboard", args: [id] });
        return { id: "job_text", projectId: id, step: "text", mode: "now", status: "queued", progress: 0, outputAssetIds: [], createdAt: iso() };
      }),
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
  it("offers Blank first, the film presets, and What if? last; no Cinematic shot, Effect or Camera move", async () => {
    const full = open("#/new", engine(FULL).client);
    await screen.findByRole("radiogroup", { name: "Preset" });
    expect(presetNames()).toEqual(["Blank", "Micro drama", "Product ad", "Music video", "Talking intro", "What if?"]);
    expect(screen.getByRole("radio", { name: /^Blank/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("radio", { name: /^Cinematic shot/ })).toBeNull();
    expect(screen.queryByRole("radio", { name: /^Effect/ })).toBeNull();
    expect(screen.queryByRole("radio", { name: /^Camera move/ })).toBeNull();
    full.unmount();

    const small = open("#/new", engine(NO_WHAT_IF).client);
    await screen.findByRole("radiogroup", { name: "Preset" });
    expect(presetNames()).toEqual(["Blank", "Micro drama", "Product ad", "Music video", "Talking intro"]);
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
    // With nothing written yet, the writer has nothing to work from: the line says what starts it.
    expect(await screen.findByText("Describe what it is about and the writer turns it into a shot list when you create the project. Every field is optional.")).toBeTruthy();
    expect(screen.queryByText(/The writer turns your brief into a shot list/)).toBeNull();
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

  it("writes the shot list from a brief with words once its photo is in, then opens Media", async () => {
    const e = engine(FULL);
    const { unmount } = open("#/new", e.client);
    fireEvent.click(await screen.findByRole("radio", { name: /^Product ad/ }));
    expect(await screen.findByText("5 shots, 15 seconds. Nothing renders yet.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Product name"), { target: { value: "Lumi sunrise lamp" } });
    expect(screen.getByText("5 shots, 15 seconds. The writer starts when you create the project.")).toBeTruthy();
    const input = document.querySelector<HTMLInputElement>('.drop input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(["x"], "lamp.png", { type: "image/png" })] } });
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(window.location.hash).toBe("#/p/prj_new/media"));
    // The writer comes last, so it sees the product photo.
    expect(e.calls.map((c) => c.method).filter((m) => m !== "hardware")).toEqual(["createProject", "uploadAsset", "updateProject", "storyboard"]);
    expect(e.work().map((c) => c.method)).toEqual(["storyboard"]);
    unmount();
  });

  it("leaves the template's list for Media on a setup with no writer", async () => {
    const e = engine(NO_WRITER);
    const { unmount } = open("#/new", e.client);
    fireEvent.click(await screen.findByRole("radio", { name: /^Micro drama/ }));
    fireEvent.change(await screen.findByLabelText("The scene"), { target: { value: "A night clerk catches a ghost eating the last melon bun" } });
    expect(screen.getByText("The preset only sets up the shot list, the look and the captions. Every field is optional. Nothing renders until you ask.")).toBeTruthy();
    expect(screen.getByText(/^5 shots, .*\. Nothing renders yet\.$/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(window.location.hash).toBe("#/p/prj_new/media"));
    expect(e.work()).toEqual([]);
    unmount();
  });

  it("plans a music video's shots to fill the length chosen", async () => {
    const { unmount } = open("#/new", engine(FULL).client);
    fireEvent.click(await screen.findByRole("radio", { name: /^Music video/ }));
    // Indie pop at 118 bpm in 4 s clips: ten shots of a bar and a half fill 30 seconds.
    expect(await screen.findByText("10 shots, 30 seconds. Nothing renders yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /^Lo-fi/ }));
    expect(screen.getByText("11 shots, 30 seconds. Nothing renders yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "60 seconds" }));
    expect(screen.getByText("21 shots, 60 seconds. Nothing renders yet.")).toBeTruthy();
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

describe("new project's keys and way out", () => {
  it("Cmd+Enter creates the project from anywhere on the page, a field included", async () => {
    const e = engine(FULL);
    const { unmount } = open("#/new", e.client);
    const name = (await screen.findByLabelText("Project name")) as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Harbour at night" } });
    // The button says its keys; its name stays plain.
    expect(screen.getByRole("button", { name: "Create project" }).textContent).toMatch(/↵$/);
    fireEvent.keyDown(name, { key: "Enter", metaKey: true });
    await waitFor(() => expect(window.location.hash).toBe("#/p/prj_new/media"));
    expect(e.calls.filter((c) => c.method === "createProject").map((c) => (c.args[0] as CreateProjectBody).name)).toEqual(["Harbour at night"]);
    unmount();
  });

  it("Cmd+Enter does nothing until the form can create", async () => {
    const e = engine(FULL);
    const { unmount } = open("#/new", e.client);
    fireEvent.click(await screen.findByRole("radio", { name: /^What if\?/ }));
    fireEvent.keyDown(screen.getByLabelText("What if?"), { key: "Enter", ctrlKey: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(e.calls.find((c) => c.method === "createProject")).toBeUndefined();
    expect(window.location.hash).toBe("#/new");
    unmount();
  });

  it("Escape leaves a field first, then New project, back to where it was opened", async () => {
    const { unmount } = open("#/", engine(FULL).client);
    await screen.findByRole("heading", { name: "Projects" });
    fireEvent.click(within(screen.getByRole("navigation", { name: "Studio" })).getByRole("link", { name: /^New project/ }));
    const name = (await screen.findByLabelText("Project name")) as HTMLInputElement;
    // New project sits under Projects in the top bar.
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs.textContent).toBe("ProjectsNew project");

    name.focus();
    fireEvent.keyDown(name, { key: "Escape" });
    expect(document.activeElement).not.toBe(name);
    expect(window.location.hash).toBe("#/new");

    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    expect(await screen.findByRole("heading", { name: "Projects" })).toBeTruthy();
    unmount();
  });

  it("the top bar's Close and the foot's Cancel leave New project", async () => {
    const first = open("#/new", engine(FULL).client);
    fireEvent.click(await screen.findByRole("button", { name: "Close" }));
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    first.unmount();

    const second = open("#/new", engine(FULL).client);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    second.unmount();
  });

  it("opens on the preset the address names, and blank for one it doesn't know", async () => {
    const drama = open("#/new?preset=product_ad", engine(FULL).client);
    expect(await screen.findByRole("heading", { name: "Product ad" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^Product ad/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Tall" }).getAttribute("aria-checked")).toBe("true");
    drama.unmount();

    const unknown = open("#/new?preset=cinematic_shot", engine(FULL).client);
    expect(await screen.findByRole("heading", { name: "Blank" })).toBeTruthy();
    unknown.unmount();

    // What if? needs a setup that can make one.
    const small = open("#/new?preset=what_if", engine(NO_WHAT_IF).client);
    await screen.findByRole("radiogroup", { name: "Preset" });
    await waitFor(() => expect(screen.getByRole("radio", { name: /^Blank/ }).getAttribute("aria-checked")).toBe("true"));
    small.unmount();
  });

  it("previews a blank project's first frame in the chosen shape, with its name and size", async () => {
    const { unmount } = open("#/new", engine(FULL).client);
    const size = () => document.querySelector(".np-frame__size")?.textContent;
    await waitFor(() => expect(size()).toBe("Wide · 1920 × 1080"));
    fireEvent.click(screen.getByRole("radio", { name: "Tall" }));
    expect(size()).toBe("Tall · 1080 × 1920");
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Pier" } });
    expect(document.querySelector(".np-frame__name")?.textContent).toBe("Pier");
    // A preset has its own fields instead.
    fireEvent.click(screen.getByRole("radio", { name: /^Micro drama/ }));
    await screen.findByLabelText("The scene");
    expect(document.querySelector(".np-frame")).toBeNull();
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
