import type { ReactNode } from "react";
import { whatIfExamples, whatIfLooks } from "@nightshift/contract";
import { Field, Textarea, radioGroupKeyDown } from "@/ui/primitives";
import "./what-if.css";

export function WhatIfFields({ question, look, onQuestion, onLook, photo }: {
  question: string; look: string; onQuestion(value: string): void; onLook(value: string): void; photo: ReactNode;
}) {
  return <>
    <Field label="What if?" hint="Imagine one impossible change. Objects and places work best.">
      {id => <Textarea id={id} autoFocus value={question} maxLength={300} rows={3}
        onChange={event => onQuestion(event.target.value)} placeholder="What if gravity stopped for ten seconds?" />}
    </Field>
    <div className="whatif-examples" aria-label="Example questions">
      {whatIfExamples.map(example => <button type="button" className="whatif-example" key={example} onClick={() => onQuestion(example)}>{example}</button>)}
    </div>
    <Field label="Look">{() => <div className="opts" role="radiogroup" aria-label="Look" onKeyDown={radioGroupKeyDown}>
      {whatIfLooks.map(option => <button type="button" key={option.id} className="opt" role="radio"
        aria-checked={look === option.id} tabIndex={look === option.id ? 0 : -1} onClick={() => onLook(option.id)}>
        <span className="opt__name">{option.label}</span>
        <span className="opt__hint">{option.id === "cinematic" ? "Natural light and real textures" : "A small, handmade world"}</span>
      </button>)}
    </div>}</Field>
    <Field label="Opening photo" hint="Optional. Your photo becomes the first frame.">{() => photo}</Field>
  </>;
}
