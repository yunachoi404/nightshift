/**
 * The quiet Options group under a tool: the new card's format, a video's length and camera, how many variations,
 * the seed, and the model the tool runs here. Open by default; closing it is remembered.
 */
import { cameraMoves, type Aspect } from "@nightshift/contract";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";
import { Input, Segmented, Select, cx } from "@/ui/primitives";
import { randomSeed, type PanelState } from "./tools";

const OPEN_KEY = "nightshift.media.options";

function useRemembered(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== "closed";
    } catch {
      return true;
    }
  });
  const set = (next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem(OPEN_KEY, next ? "open" : "closed");
    } catch {
      // Private windows may refuse storage; the group still opens and closes.
    }
  };
  return [open, set];
}

const FORMATS: Array<{ value: Aspect; label: string }> = [
  { value: "16:9", label: "16:9" },
  { value: "9:16", label: "9:16" },
  { value: "1:1", label: "1:1" },
];

export interface PanelOptionsProps {
  state: PanelState;
  set(patch: Partial<PanelState>): void;
  aspect: Aspect;
  /** Video: the lengths this setup makes, and the one chosen. */
  lengths?: number[];
  length?: number;
  /** The model this tool runs here, in plain words. */
  model?: string;
}

export function PanelOptions({ state, set, aspect, lengths, length, model }: PanelOptionsProps) {
  const [open, setOpen] = useRemembered();
  const bodyId = useId();
  const video = state.tool === "video";
  return (
    <section className="mp-sec mp-opts">
      <button type="button" className="mp-opts__toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
        <span className="mp-sec__title">Options</span>
        <ChevronDown className={cx("mp-opts__chev", !open && "mp-opts__chev--closed")} aria-hidden />
      </button>
      {open && (
        <div className="mp-opts__body" id={bodyId}>
          {/* A card that starts from an image takes that image's shape; the format is chosen only when drawing from words. */}
          {(state.tool === "image" || (video && !state.source)) && (
            <Row label="Format">
              <Segmented label="Format" size="s" value={aspect} onChange={(a) => set({ aspect: a })} options={FORMATS} />
            </Row>
          )}
          {video && lengths && length !== undefined && (
            <Row label="Length">
              {lengths.length > 1 ? (
                <Segmented label="Length" size="s" value={String(length)} onChange={(v) => set({ durationSec: Number(v) })} options={lengths.map((s) => ({ value: String(s), label: `${s} s` }))} />
              ) : (
                <span className="mp-opt__value">{length} seconds, the longest this setup makes</span>
              )}
            </Row>
          )}
          {video && (
            <Row label="Camera" htmlFor={`${bodyId}-camera`}>
              <Select id={`${bodyId}-camera`} className="mp-opt__select" value={state.move} onChange={(e) => set({ move: e.target.value })}>
                {cameraMoves.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </Row>
          )}
          <Row label="Variations">
            <Segmented label="Variations" size="s" value={String(state.variations)} onChange={(v) => set({ variations: Number(v) })} options={["1", "2", "3", "4"].map((n) => ({ value: n, label: n }))} />
          </Row>
          <Row label="Seed">
            <SeedField seed={state.seed} onChange={(seed) => set({ seed })} />
          </Row>
          {model && (
            <Row label="Model">
              <span className="mp-opt__value">{model}</span>
            </Row>
          )}
        </div>
      )}
    </section>
  );
}

function Row({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="mp-opt">
      {htmlFor ? (
        <label className="mp-opt__label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="mp-opt__label">{label}</span>
      )}
      <div className="mp-opt__control">{children}</div>
    </div>
  );
}

/** Random, or a fixed number. Fixing it starts from a random number; a field left empty keeps the last one. */
function SeedField({ seed, onChange }: { seed: number | null; onChange(seed: number | null): void }) {
  const [text, setText] = useState(seed === null ? "" : String(seed));
  useEffect(() => setText(seed === null ? "" : String(seed)), [seed]);
  return (
    <div className="mp-seed">
      <Segmented
        label="Seed"
        size="s"
        value={seed === null ? "random" : "fixed"}
        onChange={(v) => onChange(v === "random" ? null : (seed ?? randomSeed()))}
        options={[
          { value: "random", label: "Random" },
          { value: "fixed", label: "Fixed" },
        ]}
      />
      {seed !== null && (
        <Input
          className="mp-seed__input"
          aria-label="Seed number"
          inputMode="numeric"
          value={text}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, "").slice(0, 10);
            setText(digits);
            const n = Number(digits);
            if (digits && Number.isSafeInteger(n)) onChange(n);
          }}
          onBlur={() => setText(String(seed))}
        />
      )}
    </div>
  );
}
