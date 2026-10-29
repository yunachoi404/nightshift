import type { Project, StepId } from "@nightshift/contract";

/** All jobs that create a take in the Drafts screen. */
export const DRAFT_STEPS: StepId[] = ["video_draft", "video_effect", "video_camera_move", "video_what_if"];
export function draftStepFor(project: Pick<Project, "template">): StepId {
  return project.template === "what_if" ? "video_what_if" : project.template === "vfx_effect" ? "video_effect" : project.template === "camera_move" ? "video_camera_move" : "video_draft";
}
export function isDraftStep(step: string): boolean { return DRAFT_STEPS.some((candidate) => candidate === step); }
