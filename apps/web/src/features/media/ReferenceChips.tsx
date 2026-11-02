/**
 * References as chips that switch on and off, up to a limit, and the small form that names a new one: its picture, a
 * name and a kind. The prompt panel's Image tool and an open card share them, so a reference looks and works the same
 * in both.
 */
import type { Reference } from "@nightshift/contract";
import { useId, useState, type ReactNode } from "react";
import { useEngine } from "@/store/engine";
import { Button, Input, Segmented, cx } from "@/ui/primitives";
import { Media } from "@/media/Media";
import { useMedia } from "./context";
import "./references.css";

/** The engine keeps six references a project. */
export const MAX_REFERENCES = 6;

const KINDS: Array<{ value: Reference["kind"]; label: string }> = [
  { value: "character", label: "Character" },
  { value: "product", label: "Product" },
  { value: "place", label: "Place" },
  { value: "style", label: "Style" },
];

export interface ReferenceChipsProps {
  /** The ids switched on. */
  chosen: string[];
  /** How many can be on at once. */
  limit: number;
  onChosen(ids: string[]): void;
  disabled?: boolean;
  /** The id of the words that explain the chips. */
  describedBy?: string;
  /** More chips at the end, such as Add reference. */
  children?: ReactNode;
}

export function ReferenceChips({ chosen, limit, onChosen, disabled, describedBy, children }: ReferenceChipsProps) {
  const { project } = useMedia();
  const { client } = useEngine();
  return (
    <div className="mp-chips" role="group" aria-label="References" aria-describedby={describedBy}>
      {(project.references ?? []).map((r) => {
        const on = chosen.includes(r.id);
        return (
          <button
            key={r.id}
            type="button"
            className={cx("mp-chip", on && "mp-chip--on")}
            aria-pressed={on}
            title={`${r.label}, ${r.kind}`}
            disabled={disabled || (!on && chosen.length >= limit)}
            onClick={() => onChosen(on ? chosen.filter((x) => x !== r.id) : [...chosen, r.id])}
          >
            <span className="mp-chip__thumb">
              <Media src={client.assetUrl(project.id, r.assetId)} kind="image" thumb={160} />
            </span>
            <span className="mp-chip__label">{r.label}</span>
          </button>
        );
      })}
      {children}
    </div>
  );
}

export interface NewReferenceFormProps {
  /** The picture that becomes the reference. */
  src: string;
  initialLabel: string;
  initialKind: Reference["kind"];
  onCancel(): void;
  onAdd(label: string, kind: Reference["kind"]): Promise<void>;
}

/** Names a new reference: its picture, a name and a kind. Enter adds it, Escape cancels. */
export function NewReferenceForm({ src, initialLabel, initialKind, onCancel, onAdd }: NewReferenceFormProps) {
  const [label, setLabel] = useState(initialLabel);
  const [kind, setKind] = useState<Reference["kind"]>(initialKind);
  const [busy, setBusy] = useState(false);
  const labelId = useId();
  const add = async () => {
    if (!label.trim() || busy) return;
    setBusy(true);
    try {
      await onAdd(label.trim(), kind);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mp-newref" role="group" aria-label="New reference">
      <div className="mp-newref__row">
        <span className="mp-newref__thumb">{src && <Media src={src} kind="image" />}</span>
        <div className="mp-newref__name">
          <label htmlFor={labelId}>Name</label>
          <Input
            id={labelId}
            autoFocus
            value={label}
            maxLength={80}
            placeholder="Mara, the red bottle"
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void add();
              }
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
