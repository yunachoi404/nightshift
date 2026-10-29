import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Project, WorkflowRef } from "@nightshift/contract";
import { bindWorkflow, type Graph } from "../src/comfy/bind.js";
import { defaultWorkflowsDir } from "../src/paths.js";
import {
  referencesForShot,
  referencePrompt,
  projectReferences,
} from "../src/projects/references.js";

const p = {
  brief: {},
  references: [
    { id: "mara", assetId: "a", kind: "character", label: "Mara" },
    { id: "harbor", assetId: "b", kind: "place", label: "The harbor" },
    { id: "bottle", assetId: "c", kind: "product", label: "Solenne" },
    { id: "look", assetId: "d", kind: "style", label: "Watercolor" },
  ],
  assets: [],
} as unknown as Project;
describe("reference selection", () => {
  it("defaults to the first three, respects order, and preserves an explicit empty selection", () => {
    expect(referencesForShot(p, {}).map((r) => r.id)).toEqual([
      "mara",
      "harbor",
      "bottle",
    ]);
    expect(
      referencesForShot(p, { referenceIds: ["bottle", "mara"] }).map(
        (r) => r.id,
      ),
    ).toEqual(["bottle", "mara"]);
    expect(referencesForShot(p, { referenceIds: [] })).toEqual([]);
  });
  it("names each uploaded image in the same order as its binding", () => {
    expect(
      referencePrompt(
        referencesForShot(p, { referenceIds: ["bottle", "mara"] }),
      ),
    ).toContain('Image 1 is "Solenne" (product)');
    expect(
      referencePrompt(
        referencesForShot(p, { referenceIds: ["bottle", "mara"] }),
      ),
    ).toContain('Image 2 is "Mara" (character)');
    expect(referencePrompt([])).toBe("");
  });
  it("keeps legacy uploaded products usable without reviving an explicitly cleared list", () => {
    const legacy = {
      ...p,
      references: undefined,
      template: "product_ad",
      brief: { productName: "Solenne", referenceAssetId: "a" },
      assets: [
        {
          id: "a",
          kind: "image",
          role: "reference",
          path: "assets/a.png",
          createdAt: "2026-10-21",
        },
      ],
    } as Project;
    expect(projectReferences(legacy)[0]).toMatchObject({
      assetId: "a",
      label: "Solenne",
      kind: "product",
    });
    expect(projectReferences({ ...legacy, references: [] })).toEqual([]);
  });
});

describe("Klein multi-reference binding", () => {
  const graph = () =>
    JSON.parse(
      readFileSync(
        join(defaultWorkflowsDir(), "references_klein4b.api.json"),
        "utf8",
      ),
    ) as Graph;
  const ref = () =>
    JSON.parse(
      readFileSync(
        join(defaultWorkflowsDir(), "references_klein4b.api.ref.json"),
        "utf8",
      ),
    ) as WorkflowRef;
  for (const count of [1, 2, 3])
    it(`uploads exactly ${count} distinct reference images and leaves no dangling links`, () => {
      const source = graph();
      const before = JSON.stringify(source);
      const values: Record<string, unknown> = {
        image: "/one.png",
        width: 576,
        height: 960,
      };
      if (count > 1) values.image2 = "/two.png";
      if (count > 2) values.image3 = "/three.png";
      const bound = bindWorkflow(source, ref(), values);
      expect(bound.files.map((f) => f.path)).toEqual(
        ["/one.png", "/two.png", "/three.png"].slice(0, count),
      );
      expect(
        Object.values(bound.graph).filter((n) => n.class_type === "LoadImage"),
      ).toHaveLength(count);
      expect(
        Object.values(bound.graph).filter(
          (n) => n.class_type === "ReferenceLatent",
        ),
      ).toHaveLength(count * 2);
      for (const node of Object.values(bound.graph))
        for (const v of Object.values(node.inputs)) {
          if (Array.isArray(v) && typeof v[0] === "string")
            expect(bound.graph[v[0]]).toBeDefined();
        }
      expect(bound.graph["50"]?.inputs.value).toBe(576);
      expect(bound.graph["51"]?.inputs.value).toBe(960);
      expect(JSON.stringify(source)).toBe(before);
    });
});
