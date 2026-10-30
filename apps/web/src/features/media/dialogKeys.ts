/**
 * The keys of a card's popup. Its versions sit in a row, oldest first: the arrow keys move through them, Home and End
 * jump to either end, and Enter restores the one selected. Elsewhere in the popup only Left and Right move through the
 * versions, and only where the focused control does not use the arrows itself (a text field, a select, a gallery).
 */

/** What a key does to the row of versions: select the one at `select`, restore the selected one, or nothing. */
export type VersionKey = { select: number } | "restore" | null;

/**
 * What `key` does when the version at `index` (of `count`) is selected. The row stops at either end; it does not wrap
 * around, so holding an arrow key lands on the oldest or the newest. Nothing selected (-1) starts from either end.
 */
export function versionKey(key: string, index: number, count: number): VersionKey {
  if (count <= 0) return null;
  const last = count - 1;
  switch (key) {
    case "ArrowLeft":
    case "ArrowUp":
      return { select: index < 0 ? last : Math.max(0, index - 1) };
    case "ArrowRight":
    case "ArrowDown":
      return { select: index < 0 ? 0 : Math.min(last, index + 1) };
    case "Home":
      return { select: 0 };
    case "End":
      return { select: last };
    case "Enter":
      return index < 0 ? null : "restore";
    default:
      return null;
  }
}

/** Input types where the arrow keys do nothing, so they may move through the versions. */
const ARROWLESS_INPUTS = new Set(["button", "checkbox", "submit", "reset", "image", "file", "color"]);

/** Widgets that move with the arrow keys themselves. */
const ARROW_WIDGETS = '[role="radiogroup"], [role="radio"], [role="slider"], [role="spinbutton"], [role="listbox"], [role="menu"], [role="menubar"], [role="tablist"], [role="grid"], [role="tree"], [role="textbox"], [role="combobox"]';

/** Whether the element a key lands on uses the arrow keys itself: a text field, a select, a slider, a radio group. */
export function ownsArrowKeys(el: Element | null): boolean {
  if (!el) return false;
  if ((el as HTMLElement).isContentEditable) return true;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.tagName === "INPUT") return !ARROWLESS_INPUTS.has((el as HTMLInputElement).type);
  return !!el.closest(ARROW_WIDGETS);
}
