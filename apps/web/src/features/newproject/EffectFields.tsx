import { quickEffects } from "@nightshift/contract";
import type { ReactNode } from "react";
import { Field, Input, radioGroupKeyDown } from "@/ui/primitives";
import "./effects.css";

/** Real model-lab shots. Motion only plays after a pointer or keyboard interaction. */
function EffectPreview({ id }: { id: string }) {
  return <video className="effect__preview" src={`/effects/${id}.mp4`} poster={`/effects/${id}.webp`} preload="none" muted loop playsInline aria-hidden="true" />;
}

/** The effect gallery. Each tile plays its real model-lab clip on hover or focus. */
export function EffectPicker({ value, onChange, compact }: { value: string; onChange: (id: string) => void; compact?: boolean }) {
  return <div className={compact ? "effects effects--compact" : "effects"} role="radiogroup" aria-label="Effect" onKeyDown={radioGroupKeyDown}>
    {quickEffects.map((preset) => <button key={preset.id} type="button" role="radio" aria-checked={value === preset.id} tabIndex={value === preset.id ? 0 : -1} className="effect"
      onClick={() => onChange(preset.id)}
      onMouseEnter={(e) => { if (!matchMedia("(prefers-reduced-motion: reduce)").matches) void e.currentTarget.querySelector("video")?.play().catch(() => undefined); }}
      onMouseLeave={(e) => e.currentTarget.querySelector("video")?.pause()}
      onFocus={(e) => { if (!matchMedia("(prefers-reduced-motion: reduce)").matches) void e.currentTarget.querySelector("video")?.play().catch(() => undefined); }}
      onBlur={(e) => e.currentTarget.querySelector("video")?.pause()}>
      <EffectPreview id={preset.id} />
      <span className="effect__name">{preset.label}</span>
      <span className="effect__hint">{preset.hint}</span>
    </button>)}
  </div>;
}

export function EffectFields({ photo, effect, prompt, onEffect, onPrompt }: {
  photo: ReactNode; effect: string; prompt: string;
  onEffect: (id: string) => void; onPrompt: (value: string) => void;
}) {
  return <>
    <Field label="Your photo" hint="One clear subject with space around it works best. The shot starts here.">{() => photo}</Field>
    <Field label="Effect">{() => <EffectPicker value={effect} onChange={onEffect} />}</Field>
    <Field label="Describe the subject" hint="Optional. Tell us what should change, such as the bottle or the person in the coat.">
      {(id) => <Input id={id} value={prompt} onChange={(e) => onPrompt(e.target.value)} placeholder="The amber perfume bottle" />}
    </Field>
  </>;
}
