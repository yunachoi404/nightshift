import type {
  Project,
  Recipe,
  Reference,
  Shot,
  UpdateProjectRequest,
} from "@nightshift/contract";
import { badRequest, conflict } from "../errors.js";

/** Old product-photo projects keep working, and become editable in the References strip. */
export function projectReferences(
  project: Pick<Project, "references" | "assets" | "brief" | "template">,
): Reference[] {
  if (project.references !== undefined) return project.references;
  const assetId =
    project.brief.referenceAssetId ?? project.brief.productAssetId;
  const asset = project.assets.find(
    (a) => a.id === assetId && a.kind === "image",
  );
  if (!asset) return [];
  return [
    {
      id: `ref_${asset.id}`,
      assetId: asset.id,
      kind: project.template === "product_ad" ? "product" : "style",
      label:
        typeof project.brief.productName === "string" &&
        project.brief.productName.trim()
          ? project.brief.productName.trim().slice(0, 80)
          : "Reference photo",
    },
  ];
}

export function referencesForShot(
  project: Project,
  shot: Pick<Shot, "referenceIds">,
): Reference[] {
  const refs = projectReferences(project);
  if (shot.referenceIds === undefined) return refs.slice(0, 3);
  return shot.referenceIds
    .map((id) => {
      const ref = refs.find((r) => r.id === id);
      if (!ref) throw badRequest(`No reference ${id} in this project`);
      return ref;
    })
    .slice(0, 3);
}

export function referencePrompt(refs: Reference[]): string {
  if (!refs.length) return "";
  return (
    refs
      .map(
        (r, i) => `Image ${i + 1} is ${JSON.stringify(r.label)} (${r.kind}).`,
      )
      .join(" ") +
    " Preserve each character's face, skin tone, hair and clothing, each product's shape and materials, and each place's landmarks. A style reference sets the visual style. Names identify subjects only. Do not add lettering, labels or logos absent from the reference. Create the requested composition rather than copying the source framing."
  );
}

export function referenceInstructions(project: Project): string {
  const refs = projectReferences(project).slice(0, 3);
  return refs.length
    ? `Available visual references: ${refs.map((r) => `${JSON.stringify(r.label)} (${r.kind})`).join(", ")}. Use these exact names in the shot prompts. Keep their identities consistent; vary framing and action. Names are not on-screen text.`
    : "";
}

/** Normalize legacy fields, clear removed selections, and validate the final state atomically. */
export function applyReferences(
  project: Project,
  patch: UpdateProjectRequest,
  before: Project,
): void {
  if (patch.references !== undefined) project.references = patch.references;
  else if (
    patch.brief !== undefined &&
    (project.brief.referenceAssetId !== before.brief.referenceAssetId ||
      project.brief.productAssetId !== before.brief.productAssetId)
  ) {
    const legacy = projectReferences({ ...project, references: undefined });
    const oldLegacy = projectReferences({ ...before, references: undefined });
    const retained = (project.references ?? projectReferences(before)).filter(
      (r) => !oldLegacy.some((old) => old.id === r.id),
    );
    project.references = [
      ...retained,
      ...legacy.filter(
        (r) => !retained.some((kept) => kept.assetId === r.assetId),
      ),
    ];
  } else project.references = projectReferences(project);
  const ids = new Set(project.references.map((r) => r.id));
  if (patch.references !== undefined && patch.shots === undefined) {
    for (const shot of project.shots)
      if (shot.referenceIds)
        shot.referenceIds = shot.referenceIds.filter((id) => ids.has(id));
  }
  validateReferences(project);
  // The product end card continues to use the original uploaded product photo.
  if (project.template === "product_ad" && patch.references !== undefined) {
    const product = project.references.find((r) => r.kind === "product");
    if (product) project.brief.referenceAssetId = product.assetId;
    else delete project.brief.referenceAssetId;
  }
  if (patch.references !== undefined)
    for (const key of ["referenceAssetId", "productAssetId"]) {
      const assetId = project.brief[key];
      if (
        typeof assetId === "string" &&
        project.assets.some((a) => a.id === assetId && a.kind === "image") &&
        !project.references.some((r) => r.assetId === assetId)
      )
        delete project.brief[key];
    }
}

export function validateReferences(project: Project): void {
  const refs = projectReferences(project);
  if (refs.length > 6)
    throw badRequest("A project can have up to six references.");
  const ids = new Set<string>();
  for (const ref of refs) {
    if (ids.has(ref.id)) throw badRequest(`Duplicate reference id ${ref.id}`);
    ids.add(ref.id);
    if (!ref.label.trim() || ref.label.length > 80)
      throw badRequest("Name each reference in 80 characters or fewer.");
    if (
      !project.assets.some(
        (a) =>
          a.id === ref.assetId && a.kind === "image" && a.role === "reference",
      )
    )
      throw badRequest(
        `Reference ${ref.label} needs an uploaded image from this project.`,
      );
  }
  for (const shot of project.shots)
    if (shot.referenceIds) {
      if (
        shot.referenceIds.length > 3 ||
        new Set(shot.referenceIds).size !== shot.referenceIds.length
      )
        throw badRequest("Choose up to three different references per shot.");
      for (const id of shot.referenceIds)
        if (!ids.has(id))
          throw badRequest(`Shot ${shot.id}: no reference ${id}`);
    }
}

export function requireReferenceSupport(
  recipe: Recipe,
  refs: Reference[],
): void {
  if (!refs.length) return;
  const workflow = recipe.referenceStill ?? recipe.steps.still;
  const limit = ["image", "image2", "image3"].filter(
    (k) => workflow?.inputs[k],
  ).length;
  if (refs.length > limit)
    throw conflict(
      limit
        ? `This recipe supports ${limit} reference image${limit === 1 ? "" : "s"} per shot. Choose fewer references.`
        : "This recipe cannot use reference photos. Choose a recipe with reference stills, or turn off references for this shot.",
    );
}
