import type { Shot, TemplateId } from "./index.js";

/**
 * A What if? film and a quick shot (a camera move or an effect on one photo) are each one shot that their template
 * makes: the film, or the shot from the photo. That is the project's own shot. The project's tools still make cards
 * there, and those are extra cards: kept in Media, off the timeline, never part of the film or the shot, and made on
 * the tools' own paths, as in a blank project.
 *
 * The rule that tells them apart lives here, so the engine, the UI and the UI's mock engine read it the same way:
 * a What if? film's own shot is the shot with keyframes, and a quick shot's is its first shot. The engine keeps a
 * quick shot's own shot first.
 */

type Shots<S> = { template: TemplateId; shots: readonly S[] };
type Card = Pick<Shot, "id" | "index" | "keyframes">;

/** Templates whose project is the one shot the template makes: a What if? film, a quick shot. */
export function isOneShot(template: TemplateId): boolean {
  return template === "what_if" || template === "camera_move" || template === "vfx_effect";
}

/**
 * The project's own shot in a What if? film or a quick shot: the film's is the shot with keyframes, a quick shot's
 * is its first shot. Undefined in other templates, and until the template has made it.
 */
export function ownShot<S extends Card>(project: Shots<S>): S | undefined {
  if (!isOneShot(project.template)) return undefined;
  const byIndex = [...project.shots].sort((a, b) => a.index - b.index);
  return project.template === "what_if" ? byIndex.find((s) => s.keyframes) : byIndex[0];
}

/** Whether a shot is an extra card: one the tools made in a What if? film or a quick shot. */
export function isExtraCard<S extends Card>(project: Shots<S>, shot: Pick<Shot, "id">): boolean {
  return isOneShot(project.template) && ownShot(project)?.id !== shot.id;
}

/**
 * The template whose flow and style a shot follows: its project's, or blank for an extra card, whose prompts are
 * used as written.
 */
export function shotTemplate<S extends Card>(project: Shots<S>, shot: Pick<Shot, "id">): TemplateId {
  return isExtraCard(project, shot) ? "blank" : project.template;
}
