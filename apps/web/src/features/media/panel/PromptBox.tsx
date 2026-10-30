/**
 * The prompt box: a roomy field that grows with its words (from `minRows` to eight lines, then scrolls), with the
 * keys that generate in its corner. Cmd+Enter on a Mac, Ctrl+Enter elsewhere; both work everywhere.
 */
import { useLayoutEffect, useRef, type KeyboardEvent } from "react";
import { isMac } from "@/store/tier";
import { Kbd } from "@/ui/primitives";

const MAX_ROWS = 8;
/** The field's line height and its top and bottom padding, as the CSS sets them. jsdom reads no styles. */
const LINE = 20;
const PAD_Y = 12 + 6;

export function PromptBox({ id, value, onChange, onSubmit, placeholder, minRows = 5 }: { id: string; value: string; onChange: (v: string) => void; onSubmit: () => void; placeholder: string; minRows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const mac = isMac();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const line = parseFloat(getComputedStyle(el).lineHeight) || LINE;
    const min = line * minRows + PAD_Y;
    const max = line * MAX_ROWS + PAD_Y;
    el.style.height = "auto";
    const want = el.scrollHeight;
    el.style.height = `${Math.min(max, Math.max(min, want))}px`;
    el.style.overflowY = want > max ? "auto" : "hidden";
  }, [value, minRows]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="mp-prompt" onClick={(e) => e.target === e.currentTarget && ref.current?.focus()}>
      <textarea
        ref={ref}
        id={id}
        className="mp-prompt__field"
        aria-keyshortcuts="Meta+Enter Control+Enter"
        rows={minRows}
        value={value}
        placeholder={placeholder}
        spellCheck
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="mp-prompt__keys" aria-hidden title={mac ? "Command Return generates" : "Ctrl Enter generates"}>
        <Kbd>{mac ? "⌘" : "Ctrl"}</Kbd>
        <Kbd>{mac ? "↩" : "Enter"}</Kbd>
      </span>
    </div>
  );
}
