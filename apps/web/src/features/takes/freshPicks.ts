/**
 * A new take becomes its card's pick when it lands, as the engine rules: it is what was asked for, and the card then
 * plays what the cut uses. It must not do so silently, though, when it replaces a take the user had picked (or its
 * final). This keeps those replacements, for this session, so the card can say "New take" and offer the one before. A
 * card's first take, or a take after a still, replaces nothing worth a word. Opening the card and closing it again
 * clears its note; so does any other change of its pick.
 */
import type { Project, Shot } from "@nightshift/contract";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useEngineState } from "@/store/engine";

export interface FreshPick {
  /** The take that landed and became the pick. */
  takeId: string;
  /** The pick it replaced: a draft, and its final when the cut showed that. */
  previous: Pick<Shot, "chosenDraftId" | "chosenFinalId">;
}

/** Pure: the picks an update of a project replaced with a take that just landed, by shot id. */
export function replacedPicks(before: Pick<Project, "shots" | "takes">, after: Pick<Project, "shots">): Map<string, FreshPick> {
  const known = new Set(before.takes.map((t) => t.id));
  const out = new Map<string, FreshPick>();
  for (const shot of after.shots) {
    const old = before.shots.find((s) => s.id === shot.id);
    if (!old || !shot.chosenDraftId || shot.chosenDraftId === old.chosenDraftId) continue;
    // A take the project had already is a pick the user made (Restore), not one that landed.
    if (known.has(shot.chosenDraftId)) continue;
    if (!old.chosenDraftId || old.useStill) continue;
    out.set(shot.id, { takeId: shot.chosenDraftId, previous: { chosenDraftId: old.chosenDraftId, ...(old.chosenFinalId ? { chosenFinalId: old.chosenFinalId } : {}) } });
  }
  return out;
}

let fresh = new Map<string, FreshPick>();
const listeners = new Set<() => void>();
const changed = (next: Map<string, FreshPick>) => {
  fresh = next;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Watches every project for takes that replace a pick. Mounted once, with the app, so it sees them from any page. */
export function useFreshPickWatcher(): void {
  const { projects } = useEngineState();
  const seen = useRef<Record<string, Project> | null>(null);
  useEffect(() => {
    const before = seen.current;
    seen.current = projects;
    if (!before) return;
    let next: Map<string, FreshPick> | undefined;
    for (const p of Object.values(projects)) {
      const old = before[p.id];
      if (!old || old === p) continue;
      for (const [shotId, pick] of replacedPicks(old, p)) (next ??= new Map(fresh)).set(shotId, pick);
    }
    if (next) changed(next);
  }, [projects]);
}

/** The take that replaced this shot's pick, while it is still the pick and the card has not been looked at. */
export function useFreshPick(shot: Pick<Shot, "id" | "chosenDraftId">): FreshPick | undefined {
  const all = useSyncExternalStore(subscribe, () => fresh);
  const pick = all.get(shot.id);
  return pick && pick.takeId === shot.chosenDraftId ? pick : undefined;
}

/** The card was looked at, or its pick changed by hand: its note goes. */
export function clearFreshPick(shotId: string): void {
  if (!fresh.has(shotId)) return;
  const next = new Map(fresh);
  next.delete(shotId);
  changed(next);
}
