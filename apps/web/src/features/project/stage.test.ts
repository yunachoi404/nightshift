/** A project's stage line says what its work is doing, and never "Making" while that work only waits for the GPU. */
import type { Job, Project } from "@nightshift/contract";
import { describe, expect, it } from "vitest";
import { projectStage } from "./helpers";

const project: Project = { id: "p", name: "Ramen", template: "blank", aspect: "16:9", brief: {}, shots: [], takes: [], assets: [], timeline: null, createdAt: "2026-10-31T00:00:00Z", updatedAt: "2026-10-31T00:00:00Z" };
const job = (over: Partial<Job>): Job => ({ id: "j", projectId: "p", step: "still", mode: "now", status: "running", progress: 0.2, outputAssetIds: [], createdAt: "2026-10-31T00:00:00Z", ...over }) as Job;

describe("projectStage", () => {
  it("says what the running work makes while the GPU is there", () => {
    expect(projectStage(project, [job({})]).label).toBe("Making still");
  });

  it("says the work waits for the GPU while the GPU is away", () => {
    expect(projectStage(project, [job({})], true).label).toBe("Waiting for the GPU");
  });

  it("still names work that does not need the GPU, such as an export", () => {
    expect(projectStage(project, [job({ step: "export" })], true).label).toBe("Making export");
  });
});
