import type { Project, Reference, Shot } from "@nightshift/contract";
import { ImagePlus, X } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { useEngine } from "@/store/engine";
import { useInstalledTier } from "@/store/tier";
import { Button, Input, Select, toast } from "@/ui/primitives";
import { id } from "@/lib/ids";
import "./references.css";

const dragType = "application/x-nightshift-reference";
export type ShotEdit = Partial<Shot> | ((current: Shot) => Partial<Shot>);
export type DraftReference = Omit<Reference, "assetId"> & { file: File };
const kinds: Reference["kind"][] = ["character", "product", "place", "style"];
const nameOf = (file: File) =>
  file.name
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .slice(0, 80) || "Reference";
const report = (error: unknown) =>
  toast({
    title: "Couldn't save the reference",
    text: String(error),
    tone: "bad",
  });

function ReferenceCard({
  reference,
  src,
  disabled,
  onChange,
  onRemove,
  draggable = false,
}: {
  reference: Pick<Reference, "id" | "label" | "kind">;
  src: string;
  disabled?: boolean;
  onChange: (patch: Partial<Reference>) => void;
  onRemove: () => void;
  draggable?: boolean;
}) {
  const [label, setLabel] = useState(reference.label);
  useEffect(() => setLabel(reference.label), [reference.label]);
  return (
    <div className="reference-card">
      <div
        className="reference-card__image"
        draggable={draggable && !disabled}
        title={draggable ? "Drag onto a shot" : undefined}
        onDragStart={(e) => {
          e.dataTransfer.setData(dragType, reference.id);
          e.dataTransfer.effectAllowed = "copy";
        }}
      >
        <img src={src} alt={reference.label} draggable={false} />
      </div>
      <Button
        className="reference-card__remove"
        size="s"
        variant="quiet"
        iconOnly
        icon={<X />}
        aria-label={`Remove ${reference.label}`}
        disabled={disabled}
        onClick={onRemove}
      />
      <Input
        aria-label={`Name for ${reference.label}`}
        value={label}
        title={reference.label}
        maxLength={80}
        disabled={disabled}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={() => {
          const next = label.trim();
          if (!next) setLabel(reference.label);
          else if (next !== reference.label) onChange({ label: next });
        }}
      />
      <Select
        aria-label={`Kind for ${reference.label}`}
        value={reference.kind}
        disabled={disabled}
        onChange={(e) =>
          onChange({ kind: e.target.value as Reference["kind"] })
        }
      >
        {kinds.map((kind) => (
          <option key={kind} value={kind}>
            {kind[0]!.toUpperCase() + kind.slice(1)}
          </option>
        ))}
      </Select>
    </div>
  );
}

function AddImages({
  disabled,
  onFiles,
}: {
  disabled?: boolean;
  onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        size="s"
        icon={<ImagePlus />}
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        Add reference
      </Button>
      <input
        hidden
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        aria-label="Reference photos"
        onChange={(e) => {
          onFiles(
            Array.from(e.target.files ?? []).filter((f) =>
              f.type.startsWith("image/"),
            ),
          );
          e.target.value = "";
        }}
      />
    </>
  );
}

export function References({ project }: { project: Project }) {
  const { client, updateProject } = useEngine();
  const tier = useInstalledTier();
  const [busy, setBusy] = useState(false);
  const saves = useRef(Promise.resolve());
  const refs = project.references ?? [];
  function edit(change: (current: Reference[]) => Reference[]) {
    saves.current = saves.current
      .then(async () => {
        const current = await client.getProject(project.id);
        await updateProject(project.id, {
          references: change(current.references ?? []),
        });
      })
      .catch(report);
  }
  async function add(files: File[]) {
    setBusy(true);
    try {
      await saves.current;
      let current = await client.getProject(project.id);
      for (const file of files) {
        if ((current.references?.length ?? 0) >= 6) {
          toast({
            title: "Six references is the limit",
            text: "Remove one before adding another.",
          });
          break;
        }
        const asset = await client.uploadAsset(project.id, file);
        current = await updateProject(project.id, {
          references: [
            ...(current.references ?? []),
            {
              id: id("ref"),
              assetId: asset.id,
              label: nameOf(file),
              kind: "character",
            },
          ],
        });
      }
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  }
  async function remove(reference: Reference) {
    setBusy(true);
    try {
      await saves.current;
      await client.deleteAsset(project.id, reference.assetId);
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="references"
      aria-label="Project references"
      aria-busy={busy}
    >
      <div className="references__head">
        <div>
          <h2>References</h2>
          <p>
            {tier?.referenceImageLimit === 0
              ? "This setup cannot draw from reference photos. Use a supported GPU setup to render them."
              : "Keep a character, product, place or style across shots. Up to three per shot."}
          </p>
        </div>
        <AddImages
          disabled={busy || refs.length >= 6}
          onFiles={(files) => void add(files)}
        />
      </div>
      {!!refs.length && (
        <div className="references__list">
          {refs.map((reference) => (
            <ReferenceCard
              key={reference.id}
              reference={reference}
              src={client.assetUrl(project.id, reference.assetId)}
              disabled={busy}
              draggable
              onChange={(patch) =>
                edit((current) =>
                  current.map((r) =>
                    r.id === reference.id ? { ...r, ...patch } : r,
                  ),
                )
              }
              onRemove={() => void remove(reference)}
            />
          ))}
        </div>
      )}
      {!!refs.length && (
        <p className="references__hint">
          Drag a photo onto a shot, or choose below each shot. Small details and
          lettering can change.
        </p>
      )}
    </section>
  );
}

export function referenceDropHandlers(
  project: Project,
  shot: Shot,
  onChange: (patch: ShotEdit) => void,
) {
  return {
    onDragOver(e: DragEvent<HTMLDivElement>) {
      if (!e.dataTransfer.types.includes(dragType) || shot.locked) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      e.currentTarget.classList.add("shot--reference-over");
    },
    onDragLeave(e: DragEvent<HTMLDivElement>) {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null))
        e.currentTarget.classList.remove("shot--reference-over");
    },
    onDrop(e: DragEvent<HTMLDivElement>) {
      e.currentTarget.classList.remove("shot--reference-over");
      const refId = e.dataTransfer.getData(dragType);
      if (!refId || shot.locked) return;
      e.preventDefault();
      e.stopPropagation();
      const refs = project.references ?? [];
      onChange((current) => {
        const selected =
          current.referenceIds ?? refs.slice(0, 3).map((r) => r.id);
        if (!refs.some((r) => r.id === refId) || selected.includes(refId))
          return {};
        if (selected.length >= 3) {
          toast({
            title: "Choose up to three references",
            text: "Turn one off before adding another.",
          });
          return {};
        }
        return { referenceIds: [...selected, refId] };
      });
    },
  };
}

export function ShotReferences({
  project,
  shot,
  onChange,
}: {
  project: Project;
  shot: Shot;
  onChange: (patch: ShotEdit) => void;
}) {
  const refs = project.references ?? [];
  const selected = shot.referenceIds ?? refs.slice(0, 3).map((r) => r.id);
  if (!refs.length) return null;
  function add(refId: string) {
    onChange((current) => {
      const latest = current.referenceIds ?? refs.slice(0, 3).map((r) => r.id);
      if (!refs.some((r) => r.id === refId) || latest.includes(refId))
        return {};
      if (latest.length >= 3) {
        toast({
          title: "Choose up to three references",
          text: "Turn one off before adding another.",
        });
        return {};
      }
      return { referenceIds: [...latest, refId] };
    });
  }
  return (
    <div
      className="shot-references"
      aria-label={`References for shot ${shot.index + 1}`}
    >
      <div className="shot-references__head">
        <span>
          {shot.referenceIds === undefined
            ? "References · default"
            : `References · ${selected.length}/3`}
        </span>
        {shot.referenceIds !== undefined && (
          <button
            type="button"
            disabled={shot.locked}
            onClick={() => onChange({ referenceIds: undefined })}
          >
            Use defaults
          </button>
        )}
      </div>
      <div className="shot-references__choices">
        {refs.map((r) => (
          <label key={r.id} title={r.kind}>
            <input
              type="checkbox"
              checked={selected.includes(r.id)}
              disabled={
                shot.locked ||
                (!selected.includes(r.id) && selected.length >= 3)
              }
              onChange={(e) =>
                e.target.checked
                  ? add(r.id)
                  : onChange((current) => ({
                      referenceIds: (
                        current.referenceIds ??
                        refs.slice(0, 3).map((ref) => ref.id)
                      ).filter((x) => x !== r.id),
                    }))
              }
            />
            {r.label}
          </label>
        ))}
      </div>
    </div>
  );
}

export function NewReferences({
  references,
  onChange,
}: {
  references: DraftReference[];
  onChange: (refs: DraftReference[]) => void;
}) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const tier = useInstalledTier();
  useEffect(() => {
    const next = Object.fromEntries(
      references.map((r) => [r.id, URL.createObjectURL(r.file)]),
    );
    setUrls(next);
    return () => Object.values(next).forEach(URL.revokeObjectURL);
  }, [references]);
  return (
    <section
      className="references references--new"
      aria-label="Optional project references"
    >
      <div className="references__head">
        <div>
          <h2>
            References <span>Optional</span>
          </h2>
          <p>
            {tier?.referenceImageLimit === 0
              ? "You can save references here, but this setup cannot render from photos."
              : "Photos to keep the same people, products or places in every shot."}
          </p>
        </div>
        <AddImages
          disabled={references.length >= 6}
          onFiles={(files) =>
            onChange(
              [
                ...references,
                ...files.map((file) => ({
                  id: id("ref"),
                  file,
                  label: nameOf(file),
                  kind: "character" as const,
                })),
              ].slice(0, 6),
            )
          }
        />
      </div>
      {!!references.length && (
        <div className="references__list">
          {references.map((reference) => (
            <ReferenceCard
              key={reference.id}
              reference={reference}
              src={urls[reference.id] ?? ""}
              onChange={(patch) =>
                onChange(
                  references.map((r) =>
                    r.id === reference.id ? { ...r, ...patch } : r,
                  ),
                )
              }
              onRemove={() =>
                onChange(references.filter((r) => r.id !== reference.id))
              }
            />
          ))}
        </div>
      )}
    </section>
  );
}
