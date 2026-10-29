import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startEngine, type EngineHandle } from "../src/engine.js";
import { placeholderScene } from "../src/media/png.js";
import type { Asset, Project, Reference } from "@nightshift/contract";

let engine: EngineHandle;
let project: Project;
let photo: Asset;
const root = () => `/api/projects/${project.id}`;
async function api(path: string, body?: unknown, method = "POST") {
  return fetch(engine.url + path, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}
const ref = (id = "mara") => ({
  id,
  assetId: photo.id,
  kind: "character",
  label: "Mara",
});
beforeAll(async () => {
  engine = await startEngine({
    port: 0,
    dataDir: mkdtempSync(join(tmpdir(), "ns-references-")),
    mock: true,
    mockSpeed: 0,
    log: () => undefined,
  });
  project = (await (
    await api("/api/projects", {
      name: "References",
      template: "cinematic_shot",
      aspect: "16:9",
    })
  ).json()) as Project;
  const bytes = placeholderScene(64, 64, "Mara").toPng();
  photo = (await (
    await fetch(
      engine.url + root() + "/assets?filename=mara.png&role=reference",
      {
        method: "POST",
        body: new Uint8Array(bytes),
        headers: { "content-type": "image/png" },
      },
    )
  ).json()) as Asset;
});
afterAll(async () => engine?.stop());

it("retains named references and validates project ownership, labels and selections", async () => {
  let response = await api(
    root(),
    {
      references: [ref()],
      shots: [
        {
          id: "one",
          index: 0,
          prompt: "Mara at the harbor",
          durationSec: 4,
          locked: false,
          referenceIds: ["mara"],
        },
      ],
    },
    "PATCH",
  );
  expect(response.status).toBe(200);
  expect(((await response.json()) as Project).references).toEqual([ref()]);
  for (const patch of [
    { references: [ref(), ref()] },
    { references: [{ ...ref(), assetId: "someone-elses-photo" }] },
    { references: [{ ...ref(), label: "   " }] },
    {
      shots: [
        {
          id: "one",
          index: 0,
          prompt: "A harbor",
          durationSec: 4,
          locked: false,
          referenceIds: ["missing"],
        },
      ],
    },
    {
      shots: [
        {
          id: "one",
          index: 0,
          prompt: "A harbor",
          durationSec: 4,
          locked: false,
          referenceIds: ["mara", "mara"],
        },
      ],
    },
  ])
    expect((await api(root(), patch, "PATCH")).status).toBe(400);
  response = await api(root(), { references: [] }, "PATCH");
  expect(((await response.json()) as Project).shots[0]?.referenceIds).toEqual(
    [],
  );
});

it("turns legacy product photos into named references and deletes their links with the asset", async () => {
  const p = (await (
    await api(
      root(),
      {
        brief: { productName: "Solenne", referenceAssetId: photo.id },
        references: undefined,
      },
      "PATCH",
    )
  ).json()) as Project;
  expect(p.references?.[0]).toMatchObject({
    assetId: photo.id,
    label: "Solenne",
  });
  const response = await api(
    root() + `/assets/${photo.id}`,
    undefined,
    "DELETE",
  );
  expect(response.status).toBe(204);
  const saved = (await (await api(root(), undefined, "GET")).json()) as Project;
  expect(saved.assets).toEqual([]);
  expect(saved.references).toEqual([]);
  expect(saved.brief.referenceAssetId).toBeUndefined();
});

it("sends selected references in order, supports an empty selection, and gives names to the writer", async () => {
  const { MockStepRunner } = await import("../src/runner/mock.js");
  const requests: import("../src/runner/types.js").StepRequest[] = [];
  const runner = new MockStepRunner(0);
  const e = await startEngine({
    port: 0,
    dataDir: mkdtempSync(join(tmpdir(), "ns-reference-bindings-")),
    mock: true,
    mockSpeed: 0,
    runner: {
      async run(req, ctx) {
        requests.push(req);
        return runner.run(req, ctx);
      },
    },
    log: () => undefined,
  });
  const send = async (path: string, body?: unknown, method = "POST") => {
    const r = await fetch(e.url + path, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    expect(r.ok, await r.clone().text()).toBe(true);
    return r.json();
  };
  const waitFor = async (done: () => Promise<boolean>) => {
    for (let i = 0; i < 250; i++) {
      if (await done()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("Reference jobs did not settle");
  };
  try {
    await send("/api/install", {
      tier: "unified-128-cuda",
      memoryLimitGb: null,
    });
    await waitFor(
      async () =>
        (await send("/api/status", undefined, "GET")).phase === "ready",
    );
    const p: Project = await send("/api/projects", {
      name: "References in order",
      template: "product_ad",
      aspect: "16:9",
      brief: { productName: "Bottle", does: "holds perfume" },
    });
    const base = `/api/projects/${p.id}`;
    const refs: Reference[] = [];
    for (const [index, label] of ["Mara", "The harbor", "Bottle"].entries()) {
      const r = await fetch(e.url + base + "/assets?filename=ref.png", {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: new Uint8Array(placeholderScene(64, 64, label).toPng()),
      });
      const asset = (await r.json()) as Asset;
      refs.push({
        id: `ref${index}`,
        assetId: asset.id,
        label,
        kind: index === 2 ? "product" : "character",
      });
    }
    await send(
      base,
      {
        references: refs,
        shots: [
          {
            id: "selected",
            index: 0,
            prompt: "A close-up",
            durationSec: 4,
            locked: false,
            referenceIds: ["ref2", "ref0"],
          },
          {
            id: "empty",
            index: 1,
            prompt: "An empty harbor",
            durationSec: 4,
            locked: false,
            referenceIds: [],
          },
          {
            id: "all",
            index: 2,
            prompt: "A group scene",
            durationSec: 4,
            locked: false,
          },
        ],
      },
      "PATCH",
    );
    for (const shot of ["selected", "empty", "all"])
      await send(`${base}/shots/${shot}/still`, { seed: 7 });
    await waitFor(
      async () =>
        (await send("/api/jobs", undefined, "GET")).filter(
          (j: { status: string }) => j.status === "done",
        ).length === 3,
    );
    const stills = requests.filter((r) => r.step === "still");
    expect(stills[0]!.values.image).toContain(refs[2]!.assetId);
    expect(stills[0]!.values.image2).toContain(refs[0]!.assetId);
    expect(stills[0]!.values.image3).toBeUndefined();
    expect(stills[0]!.values.prompt).toContain('Image 1 is "Bottle"');
    expect(stills[1]!.values.image).toBeUndefined();
    expect(stills[1]!.ref.workflow).not.toBe("references_klein4b.api.json");
    expect(stills[2]!.values.image3).toContain(refs[2]!.assetId);
    await send(base + "/storyboard");
    await waitFor(async () => requests.some((r) => r.step === "text"));
    expect(requests.find((r) => r.step === "text")!.values.system).toContain(
      '"The harbor"',
    );
    await waitFor(async () =>
      (await send("/api/jobs", undefined, "GET")).every(
        (j: { status: string }) => ["done", "failed"].includes(j.status),
      ),
    );
    const saved = (await send(base, undefined, "GET")) as Project;
    expect(
      saved.shots.every((s) => refs.every((r) => s.prompt.includes(r.label))),
    ).toBe(true);
    await send("/api/install", { tier: "apple-64", memoryLimitGb: null });
    await waitFor(
      async () =>
        (await send("/api/status", undefined, "GET")).phase === "ready",
    );
    const previousStills = requests.filter((r) => r.step === "still").length;
    const unsupported = await send(base + "/storyboard");
    await waitFor(async () =>
      (await send("/api/jobs", undefined, "GET")).some(
        (j: { id: string; status: string }) =>
          j.id === unsupported.id && j.status === "done",
      ),
    );
    const result = (await send("/api/jobs", undefined, "GET")).find(
      (j: { id: string }) => j.id === unsupported.id,
    );
    expect(result.message).toContain("cannot use reference photos");
    expect(requests.filter((r) => r.step === "still")).toHaveLength(
      previousStills,
    );
  } finally {
    await e.stop();
  }
});
