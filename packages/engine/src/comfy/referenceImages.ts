import type { WorkflowRef } from "@nightshift/contract";
import type { Graph } from "./bind.js";

/** Omit unused image branches, rather than duplicating a photo and overweighting its identity. */
export function omitUnusedReferenceImages(
  graph: Graph,
  ref: WorkflowRef,
  values: Record<string, unknown>,
): void {
  const absent = new Set(
    ["image2", "image3"]
      .filter((name) => ref.inputs[name] && !values[name])
      .map((name) => ref.inputs[name]!.node),
  );
  if (!absent.size) return;
  const links = (value: unknown): value is [string, number] =>
    Array.isArray(value) &&
    typeof value[0] === "string" &&
    typeof value[1] === "number";
  const depends = (id: string, seen = new Set<string>()): boolean => {
    if (absent.has(id)) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return Object.values(graph[id]?.inputs ?? {}).some(
      (v) => links(v) && depends(v[0], seen),
    );
  };
  for (const [id, node] of Object.entries(graph)) {
    const latent = node.inputs.latent;
    if (
      node.class_type !== "ReferenceLatent" ||
      !links(latent) ||
      !depends(latent[0])
    )
      continue;
    const passthrough = node.inputs.conditioning;
    for (const other of Object.values(graph))
      for (const [key, value] of Object.entries(other.inputs)) {
        if (links(value) && value[0] === id) other.inputs[key] = passthrough;
      }
    delete graph[id];
  }
  const used = new Set<string>();
  const visit = (id: string) => {
    if (used.has(id)) return;
    used.add(id);
    for (const v of Object.values(graph[id]?.inputs ?? {}))
      if (links(v)) visit(v[0]);
  };
  for (const output of ref.outputNodes) visit(output);
  for (const id of Object.keys(graph)) if (!used.has(id)) delete graph[id];
}
