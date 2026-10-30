/**
 * References for an image: the project's references as chips that switch on and off (up to the setup's limit), and
 * Add reference, which takes a photo (picked, or dropped anywhere on the panel), its kind and its name, uploads it to
 * the board and adds it to the project's references.
 */
import type { Reference } from "@nightshift/contract";
import { Plus } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useEngine } from "@/store/engine";
import { id as newId } from "@/lib/ids";
import { Button, Input, Segmented, cx } from "@/ui/primitives";
import { Media } from "@/media/Media";
import { useMedia } from "../context";

/** The engine keeps six references a project. */
export const MAX_REFERENCES = 6;

const KINDS: Array<{ value: Reference["kind"]; label: string }> = [
  { value: "character", label: "Character" },
  { value: "product", label: "Product" },
  { value: "place", label: "Place" },
  { value: "style", label: "Style" },
];

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
  const { client } = useEngine();
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
      <div className="mp-chips" role="group" aria-label="References" aria-describedby={hintId}>
        {refs.map((r) => {
          const on = chosen.includes(r.id);
          return (
            <button
              key={r.id}
              type="button"
              className={cx("mp-chip", on && "mp-chip--on")}
              aria-pressed={on}
              title={`${r.label}, ${r.kind}`}
              disabled={!on && chosen.length >= limit}
              onClick={() => onChosen(on ? chosen.filter((x) => x !== r.id) : [...chosen, r.id])}
            >
              <span className="mp-chip__thumb">
                <Media src={client.assetUrl(project.id, r.assetId)} kind="image" />
              </span>
              <span className="mp-chip__label">{r.label}</span>
            </button>
          );
        })}
        {!pending && (
          <button type="button" className="mp-chip mp-chip--add" disabled={full} title={full ? "Six references is the limit." : undefined} onClick={() => input.current?.click()}>
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
      </div>
      <p className="mp-sec__hint" id={hintId}>
        {over ? "Drop to add a reference." : refs.length ? `Up to ${limit} at a time. The picture keeps their look.` : "A character, product, place or style to keep the same in every picture."}
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

function NewReference({ file, onCancel, onAdd }: { file: File; onCancel(): void; onAdd(label: string, kind: Reference["kind"]): Promise<void> }) {
  // A preview of the photo. Made in an effect, so React's double run in development never shows a revoked URL.
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (typeof URL.createObjectURL !== "function") return;
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  const [label, setLabel] = useState(() => nameFromFile(file));
  const [kind, setKind] = useState<Reference["kind"]>("character");
  const [busy, setBusy] = useState(false);
  const labelId = useId();
  const add = async () => {
    setBusy(true);
    try {
      await onAdd(label, kind);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mp-newref" role="group" aria-label="New reference">
      <div className="mp-newref__row">
        <span className="mp-newref__thumb">{url && <img src={url} alt="" />}</span>
        <div className="mp-newref__name">
          <label htmlFor={labelId}>Name</label>
          <Input
            id={labelId}
            autoFocus
            value={label}
            maxLength={80}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
              if (e.key === "Escape") {
                e.stopPropagation();
                onCancel();
              }
            }}
          />
        </div>
      </div>
      <Segmented label="Kind" size="s" value={kind} onChange={setKind} options={KINDS} />
      <div className="mp-newref__actions">
        <Button size="s" variant="quiet" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button size="s" busy={busy} disabled={!label.trim()} onClick={() => void add()}>
          Add reference
        </Button>
      </div>
    </div>
  );
}
