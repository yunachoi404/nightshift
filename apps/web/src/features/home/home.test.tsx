/**
 * Projects: the search in the top bar narrows the cards by name (Cmd+K goes to it), the filter shows the projects in
 * progress or ready to export, the New project card's presets open New project on a preset, and a card's menu renames
 * or deletes its project.
 */
import type { Event, Job, Project } from "@nightshift/contract";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
URL.revokeObjectURL ??= () => undefined;
URL.createObjectURL ??= () => "blob:test";

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

const iso = (minAgo = 0) => new Date(Date.now() - minAgo * 60_000).toISOString();
const shot = (i: number, extra: Partial<Project["shots"][number]> = {}): Project["shots"][number] => ({ id: `shot_${i}`, index: i, prompt: `Shot ${i}`, durationSec: 4, locked: false, ...extra });
const project = (id: string, name: string, shots: Project["shots"], minAgo: number): Project => ({ id, name, template: "blank", aspect: "16:9", brief: {}, shots, takes: [], assets: [], timeline: null, createdAt: iso(minAgo), updatedAt: iso(minAgo) });

/** Every shot of its cut has a final: ready to export. */
const LIGHTHOUSE = project("prj_light", "Lighthouse at dusk", [shot(0, { chosenFinalId: "take_f0" }), shot(1, { chosenFinalId: "take_f1" })], 5);
/** Stills only: in progress. */
const NORTHERN = project("prj_north", "Northern lights", [shot(0, { stillAssetId: "ast_s0" })], 30);
/** Nothing in it yet: in progress too. */
const RAIN = project("prj_rain", "Rain rider", [], 90);

function engine(projects = [LIGHTHOUSE, NORTHERN, RAIN]) {
  const store = new Map(projects.map((p) => [p.id, p]));
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const answer = <T,>(fn: () => T): Promise<T> => Promise.resolve().then(() => structuredClone(fn()));
  const known: Partial<NightshiftClient> = {
    kind: "http",
    status: () => answer(() => ({ phase: "ready" as const, tier: "nvidia-8", comfyui: { running: true, url: "http://127.0.0.1:8188", version: "0.41.3" }, memoryUsedGb: null, mode: "local" as const })),
    settings: () => answer(() => ({ tier: "nvidia-8", memoryLimitGb: null, overnight: { enabled: false, startAt: "23:00", endAt: "07:00" }, remote: null })),
    onboarding: () => answer(() => ({ done: true, sampleProjectId: null })),
    tiers: () => answer(() => []),
    listProjects: () => answer(() => [...store.values()]),
    listJobs: () => answer((): Job[] => []),
    getProject: (id) => answer(() => store.get(id)!),
    updateProject: (id: string, patch: ProjectPatch) =>
      answer(() => {
        calls.push({ method: "updateProject", args: [id, patch] });
        const p = { ...store.get(id)!, ...patch } as Project;
        store.set(id, p);
        return p;
      }),
    deleteProject: (id: string) =>
      answer(() => {
        calls.push({ method: "deleteProject", args: [id] });
        store.delete(id);
      }),
    assetUrl: (pid, aid) => `/api/projects/${pid}/assets/${aid}`,
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

function open(client: NightshiftClient, hash = "#/") {
  window.location.hash = hash;
  return render(
    <EngineProvider client={client}>
      <App />
    </EngineProvider>,
  );
}

/** The names on the project cards, in the grid's order. */
const cards = () => [...document.querySelectorAll(".pcard__name")].map((n) => n.textContent);
const newCard = () => document.querySelector(".pnew");

afterEach(() => {
  window.location.hash = "";
});

describe("Projects", () => {
  it("searches by name from the top bar, which Cmd+K focuses, and Escape clears the search", async () => {
    open(engine().client);
    await waitFor(() => expect(cards()).toEqual(["Lighthouse at dusk", "Northern lights", "Rain rider"]));
    const search = screen.getByRole("searchbox", { name: "Search projects" }) as HTMLInputElement;
    expect(search.closest(".toolbar")).not.toBeNull();

    act(() => void fireEvent.keyDown(window, { key: "k", metaKey: true }));
    await waitFor(() => expect(document.activeElement).toBe(search));

    fireEvent.change(search, { target: { value: "NORTH" } });
    await waitFor(() => expect(cards()).toEqual(["Northern lights"]));
    // A search narrows the page to what it found: the New project card steps aside, and the counts follow.
    expect(newCard()).toBeNull();
    expect(screen.getByRole("radio", { name: "All 1" })).toBeTruthy();
    expect(window.location.hash).toBe("#/?q=NORTH");

    fireEvent.change(search, { target: { value: "sea" } });
    expect(await screen.findByText("No projects match “sea”")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear the search" }));
    await waitFor(() => expect(cards()).toHaveLength(3));

    fireEvent.change(search, { target: { value: "rain" } });
    await waitFor(() => expect(cards()).toEqual(["Rain rider"]));
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect(cards()).toHaveLength(3));
    expect(search.value).toBe("");
    expect(newCard()).not.toBeNull();
  });

  it("filters to the projects in progress or ready to export, with a count on each", async () => {
    open(engine().client);
    const filter = await screen.findByRole("radiogroup", { name: "Show" });
    expect(within(filter).getAllByRole("radio").map((r) => r.textContent)).toEqual(["All3", "In progress2", "Ready1"]);
    expect(within(filter).getByRole("radio", { name: "All 3" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(within(filter).getByRole("radio", { name: "Ready 1" }));
    await waitFor(() => expect(cards()).toEqual(["Lighthouse at dusk"]));
    expect(newCard()).toBeNull();
    expect(window.location.hash).toBe("#/?show=ready");

    fireEvent.click(within(filter).getByRole("radio", { name: "In progress 2" }));
    await waitFor(() => expect(cards()).toEqual(["Northern lights", "Rain rider"]));

    fireEvent.click(within(filter).getByRole("radio", { name: "All 3" }));
    await waitFor(() => expect(cards()).toHaveLength(3));
    expect(newCard()).not.toBeNull();
    expect(window.location.hash).toBe("#/");
  });

  it("says when nothing is ready yet", async () => {
    open(engine([NORTHERN, RAIN]).client);
    fireEvent.click(await screen.findByRole("radio", { name: "Ready 0" }));
    expect(await screen.findByText(/^Nothing is ready to export yet\./)).toBeTruthy();
  });

  it("shows each project's stage, length and size on its card", async () => {
    open(engine().client);
    await screen.findByRole("heading", { name: "Projects" });
    // The name shows in the sidebar's recent list too; the card is the one in the grid.
    const card = document.querySelector(".pcard:has(.pcard__name)") as HTMLElement;
    expect(card.querySelector(".pcard__name")?.textContent).toBe("Lighthouse at dusk");
    expect(card.querySelector(".pcard__stage")?.textContent).toBe("Ready to export");
    expect(card.querySelector(".pcard__length")?.textContent).toBe("0:08");
    expect(card.querySelector(".pcard__meta")?.textContent).toBe("2 shots · 5 min ago");
    // A project with nothing in its cut has no length to show.
    const rain = [...document.querySelectorAll(".pcard")].find((c) => c.querySelector(".pcard__name")?.textContent === "Rain rider")!;
    expect(rain.querySelector(".pcard__length")).toBeNull();
  });

  it("shows a tall cover whole on its card, and a wide one edge to edge, so no head is cut off", async () => {
    const still = (id: string, width: number, height: number) => ({ id, kind: "image" as const, path: `${id}.png`, width, height, createdAt: iso(5) });
    const tall = { ...project("prj_tall", "Night market", [shot(0, { stillAssetId: "ast_tall" })], 5), aspect: "9:16" as const, assets: [still("ast_tall", 576, 960)] };
    const wide = { ...project("prj_wide", "Harbour", [shot(0, { stillAssetId: "ast_wide" })], 6), assets: [still("ast_wide", 960, 576)] };
    open(engine([tall, wide]).client);
    await waitFor(() => expect(cards()).toEqual(["Night market", "Harbour"]));
    const fit = (name: string) => {
      const card = [...document.querySelectorAll(".pcard")].find((c) => c.querySelector(".pcard__name")?.textContent === name)!;
      return (card.querySelector(".pcard__picture img.media") as HTMLImageElement).style.objectFit;
    };
    expect(fit("Night market")).toBe("contain");
    expect(fit("Harbour")).toBe("cover");
    // Too few shots for three: the tall cover sits over a blurred copy of itself, not on black bars.
    const market = [...document.querySelectorAll(".pcard")].find((c) => c.querySelector(".pcard__name")?.textContent === "Night market")!;
    expect(market.querySelector(".pcard__backdrop")?.getAttribute("src")).toBe("/api/projects/prj_tall/assets/ast_tall");
  });

  it("shows a tall project with three shots or more as three of them side by side, the cover in the middle", async () => {
    const still = (id: string) => ({ id, kind: "image" as const, path: `${id}.png`, width: 576, height: 1024, createdAt: iso(5) });
    const tall = {
      ...project("prj_tall", "Ghost shift", [0, 1, 2, 3].map((i) => shot(i, { stillAssetId: `ast_${i}` })), 5),
      aspect: "9:16" as const,
      assets: [0, 1, 2, 3].map((i) => still(`ast_${i}`)),
    };
    open(engine([tall]).client);
    await waitFor(() => expect(cards()).toEqual(["Ghost shift"]));
    const panels = [...document.querySelectorAll(".pcard__picture--three img")].map((i) => i.getAttribute("src")?.split("/").at(-1));
    expect(panels).toEqual(["ast_1", "ast_0", "ast_2"]);
    expect(document.querySelector(".pcard__backdrop")).toBeNull();
  });

  it("starts a project from a preset on the New project card", async () => {
    open(engine().client);
    await screen.findByRole("heading", { name: "Projects" });
    const starts = within(screen.getByRole("group", { name: "Start from a preset" })).getAllByRole("link");
    expect(starts.map((l) => l.textContent)).toEqual(["Micro drama", "Product ad", "Music video"]);
    // The card itself starts a blank one.
    expect(newCard()?.querySelector(".pnew__link")?.getAttribute("href")).toBe("#/new");
    fireEvent.click(starts[0]!);
    await waitFor(() => expect(window.location.hash).toBe("#/new?preset=micro_drama"));
    expect(await screen.findByRole("heading", { name: "Micro drama" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /^Micro drama/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByLabelText("The scene")).toBeTruthy();
  });

  it("renames a project from its card's menu", async () => {
    const e = engine();
    open(e.client);
    fireEvent.click(await screen.findByRole("button", { name: "More for Northern lights" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename project" });
    const field = within(dialog).getByLabelText("Project name") as HTMLInputElement;
    expect(field.value).toBe("Northern lights");
    fireEvent.change(field, { target: { value: "  Aurora over the fjord " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(cards()).toContain("Aurora over the fjord"));
    expect(e.calls).toEqual([{ method: "updateProject", args: ["prj_north", { name: "Aurora over the fjord" }] }]);
  });

  it("deletes a project from its card's menu only after the confirm", async () => {
    const e = engine();
    open(e.client);
    fireEvent.click(await screen.findByRole("button", { name: "More for Rain rider" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    let dialog = await screen.findByRole("dialog", { name: "Delete “Rain rider”?" });
    // Cancel keeps it; nothing is asked of the engine.
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(e.calls).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "More for Rain rider" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    dialog = await screen.findByRole("dialog", { name: "Delete “Rain rider”?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete project" }));
    await waitFor(() => expect(cards()).toEqual(["Lighthouse at dusk", "Northern lights"]));
    expect(e.calls).toEqual([{ method: "deleteProject", args: ["prj_rain"] }]);
  });
});
