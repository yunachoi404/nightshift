/**
 * A What if? film's or a quick shot's own shot beside the extra cards its tools make (`ownShot` in the contract). The
 * engine keeps the own shot first and every extra card off the timeline, so the template's flow, the cut and the
 * export only ever see the own shot.
 */
import { boardOf, isExtraCard, isOneShot, ownShot, type Project, type Shot } from "@nightshift/contract";
import { badRequest } from "../errors.js";

/**
 * The template makes its own shot (`own`), new or again: it goes first, the extra cards follow in their order, and the
 * shot it replaces (`old`, the own shot it had) goes with its takes. On the canvas it takes the replaced shot's place,
 * else it opens the first board.
 */
export function setOwnShot(p: Project, own: Shot, old: Shot | undefined = ownShot(p)): void {
  const extras = p.shots.filter((s) => s.id !== own.id && s.id !== old?.id).sort((a, b) => a.index - b.index);
  p.shots = [{ ...own, index: 0 }, ...extras.map((s, i) => ({ ...s, index: i + 1 }))];
  p.takes = p.takes.filter((t) => p.shots.some((s) => s.id === t.shotId));
  // A project made before boards lists its shots in order, so the own shot is already first.
  if (!p.boards || boardOf(p.boards, own.id)) return;
  const replaced = old ? boardOf(p.boards, old.id) : undefined;
  p.boards = p.boards.map((b, i) => {
    if (replaced) return b === replaced ? { ...b, items: b.items.map((item) => (item === old!.id ? own.id : item)) } : b;
    return i === 0 ? { ...b, items: [own.id, ...b.items] } : b;
  });
}

/**
 * A PATCH of a one-shot project's shots, kept to its rules: the own shot it had stays, first (so a quick shot's own
 * shot stays its own), and no extra card goes on the timeline. Refused in plain words otherwise. A shot a quick shot
 * put on its timeline before the tools (an uploaded image) may stay there until it is taken off.
 */
export function keepOwnShot(p: Project, before: Project): void {
  if (!isOneShot(p.template)) return;
  const own = ownShot(before);
  if (own) {
    const kept = p.shots.find((s) => s.id === own.id);
    if (!kept) throw badRequest("This project's own shot stays. Only cards made with the tools can be deleted.");
    p.shots = [kept, ...p.shots.filter((s) => s !== kept)].map((s, i) => ({ ...s, index: i }));
    if (ownShot(p)?.id !== own.id) throw badRequest("A What-if film needs four keyframes.");
  }
  // A shot goes on the timeline: it is on it now, and was not (new, or off it).
  const joins = (s: Shot) => s.onTimeline !== false && !before.shots.some((b) => b.id === s.id && b.onTimeline !== false);
  if (p.shots.some((s) => isExtraCard(p, s) && joins(s))) {
    throw badRequest("Only this project's own shot goes on its timeline. Cards made with the tools stay in Media.");
  }
}
