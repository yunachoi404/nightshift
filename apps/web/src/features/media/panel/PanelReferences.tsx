/**
 * References for an image: the project's references as chips that switch on and off (up to the setup's limit), and
 * Add reference, which takes a photo (picked, or dropped anywhere on the panel), its kind and its name, uploads it to
 * the board and adds it to the project's references.
 */
import type { Reference } from "@nightshift/contract";
import { Plus } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { id as newId } from "@/lib/ids";
import { cx } from "@/ui/primitives";
import { defaultReferenceKind } from "@/features/references/References";
import { useMedia } from "../context";
import { MAX_REFERENCES, NewReferenceForm, ReferenceChips } from "../ReferenceChips";

export { MAX_REFERENCES };

/** A reference's name from its file: "rae_portrait-2.jpg" is "rae portrait 2". */
export function nameFromFile(file: File): string {
  return (
    file.name
      .replace(/\.[^.]+$/, "")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "Reference"
  );
}

export interface PanelReferencesProps {
  chosen: string[];
  limit: number;
  boardId: string;
  onChosen(ids: string[]): void;
  /** A photo dropped on the panel, waiting for its kind and name. */
  pending: File | null;
  onPending(file: File | null): void;
  /** Something droppable is over the panel. */
  over: boolean;
}

export function PanelReferences({ chosen, limit, boardId, onChosen, pending, onPending, over }: PanelReferencesProps) {
  const { project } = useMedia();
  const input = useRef<HTMLInputElement>(null);
  const refs = project.references ?? [];
  const full = refs.length >= MAX_REFERENCES;
  const hintId = useId();
  const addReference = useAddReference(boardId);

  return (
    <section className={cx("mp-sec", over && "mp-sec--over")} aria-labelledby={`${hintId}-t`}>
      <div className="mp-sec__head">
        <h3 className="mp-sec__title" id={`${hintId}-t`}>
          References
        </h3>
        <span className="mp-sec__aside">{refs.length ? `${chosen.length} of ${limit}` : "Optional"}</span>
      </div>
      <ReferenceChips chosen={chosen} limit={limit} onChosen={onChosen} describedBy={hintId}>
        {!pending && (
          <button type="button" className="mp-chip mp-chip--add" disabled={full} title={full ? "Six references is the limit" : undefined} onClick={() => input.current?.click()}>
            <Plus /> Add reference
          </button>
        )}
        <input
          ref={input}
          type="file"
          accept="image/*"
          hidden
          aria-label="Reference photo"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) onPending(file);
          }}
        />
      </ReferenceChips>
      <p className="mp-sec__hint" id={hintId}>
        {over ? "Drop to add a reference" : refs.length ? `Up to ${limit} at a time. The picture keeps their look.` : "A character, product, place or style to keep the same in every picture"}
      </p>
      {pending && (
        <NewReference
          key={`${pending.name}-${pending.size}-${pending.lastModified}`}
          file={pending}
          onCancel={() => onPending(null)}
          onAdd={async (label, kind) => {
            const ref = await addReference(pending, label, kind);
            if (!ref) return;
            onPending(null);
            if (chosen.length < limit) onChosen([...chosen, ref.id]);
          }}
        />
      )}
    </section>
  );
}

/** Uploads a reference photo to the board and adds it to the project's references. */
function useAddReference(boardId: string) {
  const { upload, edit } = useMedia();
  return async (file: File, label: string, kind: Reference["kind"]): Promise<Reference | undefined> => {
    const [assetId] = await upload([file], boardId, "reference");
    if (!assetId) return undefined;
    const ref: Reference = { id: newId("ref"), assetId, label: label.trim() || nameFromFile(file), kind };
    await edit((latest) => ({ references: [...(latest.references ?? []), ref].slice(0, MAX_REFERENCES) }));
    return ref;
  };
}

/** A dropped or picked photo, named before it is added: its preview is an object URL for as long as the form is open. */
function NewReference({ file, onCancel, onAdd }: { file: File; onCancel(): void; onAdd(label: string, kind: Reference["kind"]): Promise<void> }) {
  const { project } = useMedia();
  // Made in an effect, so React's double run in development never shows a revoked URL.
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (typeof URL.createObjectURL !== "function") return;
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return <NewReferenceForm src={url} initialLabel={nameFromFile(file)} initialKind={defaultReferenceKind(project.template)} onCancel={onCancel} onAdd={onAdd} />;
}
