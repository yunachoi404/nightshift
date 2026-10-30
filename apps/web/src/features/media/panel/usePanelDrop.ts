/**
 * Drops on the prompt panel: a photo from the desktop anywhere on it, or (for tools that start from an image) a card
 * from the board. `over` stays on while the drag is anywhere inside the panel.
 */
import { useState, type DragEvent } from "react";
import { toast } from "@/ui/primitives";
import { isCanvasDrag, isFileDrag, readDrag } from "../items";

export function usePanelDrop({ cards, onImage, onCard }: { cards: boolean; onImage(file: File): void; onCard(cardId: string): void }) {
  const [over, setOver] = useState(false);
  const accepts = (e: DragEvent<HTMLElement>) => isFileDrag(e) || (cards && isCanvasDrag(e));
  return {
    over,
    handlers: {
      onDragOver(e: DragEvent<HTMLElement>) {
        if (!accepts(e)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
        if (!over) setOver(true);
      },
      onDragLeave(e: DragEvent<HTMLElement>) {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        setOver(false);
      },
      onDrop(e: DragEvent<HTMLElement>) {
        setOver(false);
        if (isFileDrag(e)) {
          e.preventDefault();
          const image = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
          if (image) onImage(image);
          else toast({ title: "Drop an image", text: "Songs and voiceovers go on the board, or use Upload.", tone: "bad" });
          return;
        }
        const payload = cards ? readDrag(e) : undefined;
        if (!payload?.items[0]) return;
        e.preventDefault();
        onCard(payload.items[0]);
      },
    },
  };
}
