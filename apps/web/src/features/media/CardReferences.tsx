/**
 * An open card's references: the project's references as chips that say which ones this shot is drawn with (Redraw
 * still and Edit image keep their look), and Use as reference, which makes the still on show a reference of the
 * project, so other pictures can keep its look without a download and an upload.
 */
import type { Project, Reference, Shot } from "@nightshift/contract";
import { ImagePlus } from "lucide-react";
import { useId, useState } from "react";
import { posterOf } from "@/media/Media";
import { useEngine } from "@/store/engine";
import { toast } from "@/ui/primitives";
import { defaultReferenceKind } from "@/features/references/References";
import { useMedia } from "./context";
import { shotPatch } from "./items";
import { MAX_REFERENCES, NewReferenceForm, ReferenceChips } from "./ReferenceChips";

/** The references a shot is drawn with, as the engine reads them: its own choice, else the project's first three. */
export function shotReferenceIds(project: Pick<Project, "references">, shot: Pick<Shot, "referenceIds">): string[] {
  const all = project.references ?? [];
  return (shot.referenceIds ?? all.slice(0, 3).map((r) => r.id)).filter((id) => all.some((r) => r.id === id));
}

/**
 * The references an edit of the shot's still keeps, as the engine reads them: the edited image takes one place, so
 * `slots` is one fewer than a still takes. A shot that never chose keeps the first that fit; one that chose more than
 * fit is refused, and `tooMany` says so before the edit is asked for.
 */
export function editReferences(project: Pick<Project, "references">, shot: Pick<Shot, "referenceIds">, slots: number): { refs: Reference[]; tooMany: boolean } {
  const ids = shotReferenceIds(project, shot);
  const tooMany = shot.referenceIds !== undefined && ids.length > slots;
  const kept = shot.referenceIds === undefined ? ids.slice(0, slots) : ids;
  return { refs: kept.map((id) => project.references!.find((r) => r.id === id)!), tooMany };
}

/** "Rin", "Rin and Mochi", "Rin, Mochi and the shop". */
export function namesOf(refs: Pick<Reference, "label">[]): string {
  const names = refs.map((r) => r.label);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
}

export function CardReferences({ shot, still, limit }: { shot: Shot; still: string | undefined; limit: number }) {
  const { project, edit } = useMedia();
  const { client, addReference } = useEngine();
  const refs = project.references ?? [];
  const chosen = shotReferenceIds(project, shot);
  const [naming, setNaming] = useState(false);
  const titleId = useId();
  const hintId = useId();
  const full = refs.length >= MAX_REFERENCES;
  // The still on show can become a reference, unless it already is one or was copied into one.
  const usable = !!still && !refs.some((r) => r.assetId === still || r.copiedFrom === still);
  const fail = (title: string) => (e: unknown) => toast({ title, text: e instanceof Error ? e.message : String(e), tone: "bad" });

  return (
    <section className="cd-sec" aria-labelledby={titleId}>
      <div className="cd-sec__head">
        <h3 className="cd-sec__title" id={titleId}>
          References
        </h3>
        {refs.length > 0 && <span className="cd-sec__aside">{`${chosen.length} of ${limit}`}</span>}
      </div>
      <ReferenceChips
        chosen={chosen}
        limit={limit}
        disabled={shot.locked}
        describedBy={hintId}
        onChosen={(ids) => void edit((p) => shotPatch(p, shot.id, { referenceIds: ids })).catch(fail("Couldn't change the references"))}
      >
        {usable && !naming && (
          <button type="button" className="mp-chip mp-chip--add" disabled={full} title={full ? "Six references is the limit" : undefined} onClick={() => setNaming(true)}>
            <ImagePlus /> Use as reference
          </button>
        )}
      </ReferenceChips>
      {naming && still && (
        <NewReferenceForm
          src={posterOf(client.assetUrl(project.id, still), 160)}
          initialLabel=""
          initialKind={defaultReferenceKind(project.template)}
          onCancel={() => setNaming(false)}
          onAdd={async (label, kind) => {
            try {
              await addReference(project.id, { assetId: still, label, kind });
              setNaming(false);
              toast({ title: `${label} is a reference`, text: "Pictures drawn with it keep its look." });
            } catch (e) {
              fail("Couldn't add the reference")(e);
            }
          }}
        />
      )}
      <p className="cd-text" id={hintId}>
        {refs.length ? "Redraw still and Edit image keep their look." : still ? "None yet. Use this still as one, and other pictures can keep its look." : "None yet. Add one in the Image tool."}
      </p>
    </section>
  );
}
