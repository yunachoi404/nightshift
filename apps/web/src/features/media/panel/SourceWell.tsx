/**
 * "Start from": the image a tool starts from. Empty, it is a drop zone (the panel takes the drop: a photo from the
 * desktop, or a card from the board) with a way to pick a card on the board or upload a photo. Filled, it shows the
 * image, its name, and Change and Clear.
 */
import type { Asset } from "@nightshift/contract";
import { ImagePlus, MousePointerClick, Upload } from "lucide-react";
import { useRef } from "react";
import { useEngine } from "@/store/engine";
import { Button, cx } from "@/ui/primitives";
import { Media } from "@/media/Media";

export interface SourceWellProps {
  projectId: string;
  required: boolean;
  /** What the image is to the tool, under its name: "The first frame", "The image to change". */
  role: string;
  /** What starting from no image means, for an optional source. */
  without?: string;
  source: Asset | undefined;
  sourceName: string | undefined;
  /** Waiting for a card on the board to be clicked. */
  choosing: boolean;
  /** Something droppable is over the panel. */
  over: boolean;
  busy: boolean;
  onChoose(): void;
  onCancel(): void;
  onClear(): void;
  onUpload(file: File): void;
}

export function SourceWell({ projectId, required, role, without, source, sourceName, choosing, over, busy, onChoose, onCancel, onClear, onUpload }: SourceWellProps) {
  const { client } = useEngine();
  const input = useRef<HTMLInputElement>(null);
  const pickFile = () => input.current?.click();
  const fileInput = (
    <input
      ref={input}
      type="file"
      accept="image/*"
      hidden
      aria-label="Image to start from"
      onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (file) onUpload(file);
      }}
    />
  );

  if (source && !choosing && !over)
    return (
      <div className="mp-well mp-well--full" data-testid="source-well">
        <span className="mp-well__thumb">
          <Media src={client.assetUrl(projectId, source.id)} kind="image" alt="" />
        </span>
        <div className="mp-well__text">
          <b title={sourceName}>{sourceName}</b>
          <small>{role}</small>
          <div className="mp-well__actions">
            <Button size="s" variant="quiet" onClick={onChoose}>
              Change
            </Button>
            <Button size="s" variant="quiet" onClick={onClear}>
              Clear
            </Button>
          </div>
        </div>
        {fileInput}
      </div>
    );

  return (
    <div className={cx("mp-well", over && "mp-well--over", choosing && !over && "mp-well--choosing")} data-testid="source-well" aria-busy={busy || undefined}>
      <span className="mp-well__icon" aria-hidden>
        {busy ? <span className="spin" /> : choosing && !over ? <MousePointerClick /> : <ImagePlus />}
      </span>
      <div className="mp-well__prompt" role="status">
        {busy ? (
          <b>Adding the image</b>
        ) : over ? (
          <b>Drop to start from this image</b>
        ) : choosing ? (
          <>
            <b>Click a card on the board</b>
            <small>Or drop an image here.</small>
          </>
        ) : (
          <>
            <b>Drop an image or a card here</b>
            <small>{without}</small>
          </>
        )}
      </div>
      {!over && !busy && (
        <div className="mp-well__buttons">
          {choosing ? (
            (source || !required) && (
              <Button size="s" variant="quiet" onClick={onCancel}>
                Cancel
              </Button>
            )
          ) : (
            <Button size="s" variant="quiet" icon={<MousePointerClick />} onClick={onChoose}>
              Pick on the board
            </Button>
          )}
          <Button size="s" variant="quiet" icon={<Upload />} onClick={pickFile}>
            Upload
          </Button>
        </div>
      )}
      {fileInput}
    </div>
  );
}
