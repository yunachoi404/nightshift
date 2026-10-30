import type { Project } from "@nightshift/contract";

/**
 * The song or the voiceover the cut uses: the soundtrack's pick, none when it is null, else the newest of the role.
 * Undefined when the project has none of the role (older mock projects made their audio without a role).
 */
export function soundPick(p: Pick<Project, "assets" | "soundtrack">, role: "music" | "voice"): string | null | undefined {
  const pick = p.soundtrack?.[role];
  if (pick === null) return null;
  if (pick && p.assets.some((a) => a.id === pick)) return pick;
  return p.assets.filter((a) => a.kind === "audio" && a.role === role).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id;
}
