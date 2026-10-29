import type { Take } from "./index.js";

/**
 * The final a shot shows while `draftId` is its picked draft: `namedId` if that is one of the draft's finals, else the
 * draft's newest final, same-take or remaster. Undefined while the draft has none, or only one still rendering.
 *
 * A final takes over its shot when it finishes, and takes are listed in the order they finished, so picking a draft
 * again brings back the final it showed before. The engine owns this choice: it keeps `Shot.chosenFinalId` on it when
 * a final finishes and whenever the pick changes (the UI's mock engine does the same). The UI never works it out; it
 * shows `chosenFinalId`.
 */
export function finalFor(takes: readonly Take[], draftId: string | undefined, namedId?: string): Take | undefined {
  if (!draftId) return undefined;
  const ofDraft = (t: Take) => t.rung === "final" && t.parentTakeId === draftId && t.videoAssetId !== undefined;
  return takes.find((t) => t.id === namedId && ofDraft(t)) ?? takes.findLast(ofDraft);
}
