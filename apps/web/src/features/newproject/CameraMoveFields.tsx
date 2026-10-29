import type { ReactNode } from "react";
import { quickMoves } from "@nightshift/contract";
import { Field, Textarea, radioGroupKeyDown } from "@/ui/primitives";
import "./camera-move.css";
import { publicUrl } from "@/lib/publicUrl";

/** The previews are real app takes. Keep them still until the user points or tabs here. */
function playPreview(button: HTMLButtonElement) {
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) void button.querySelector("video")?.play().catch(() => undefined);
}

export function CameraMovePicker({ value, onChange }: { value: string; onChange: (move: string) => void }) {
  const hasSelection = quickMoves.some((move) => move.id === value);
  return <div className="camera-moves" role="radiogroup" aria-label="Camera move" onKeyDown={radioGroupKeyDown}>
    {quickMoves.map((move, index) => <button key={move.id} type="button" className="camera-move" role="radio" aria-checked={value === move.id} tabIndex={value === move.id || !hasSelection && index === 0 ? 0 : -1} onClick={() => onChange(move.id)}
      onMouseEnter={(e) => playPreview(e.currentTarget)} onFocus={(e) => playPreview(e.currentTarget)}
      onMouseLeave={(e) => e.currentTarget.querySelector("video")?.pause()} onBlur={(e) => e.currentTarget.querySelector("video")?.pause()}>
      <video className="camera-move__preview" src={publicUrl(`camera/${move.id}.mp4`)} poster={publicUrl(`camera/${move.id}.webp`)} preload="none" muted loop playsInline aria-hidden="true" /><span><strong>{move.label}</strong><small>{move.hint}</small></span>
    </button>)}
  </div>;
}

export function cameraPhotoHint(move: string): string {
  return move === "dolly_zoom"
    ? "Choose a clear foreground subject with a detailed, distant background behind it."
    : move.startsWith("crane_")
      ? "Use an open scene. Nearby ceilings and furniture may block the view."
      : "Leave space around the subject for a close-up. Solid objects work best. Glass and mirrors may change.";
}

export function CameraMoveFields({ photo, move, prompt, onMove, onPrompt }: { photo: ReactNode; move: string; prompt: string; onMove: (s: string) => void; onPrompt: (s: string) => void }) {
  return <>
    <Field label="Your photo" hint={cameraPhotoHint(move)}>{() => photo}</Field>
    <Field label="Camera move">{() => <CameraMovePicker value={move} onChange={onMove} />}</Field>
    <Field label="What's in the scene" hint="Optional. Describe the subject and setting.">{(id) => <Textarea id={id} value={prompt} onChange={(e) => onPrompt(e.target.value)} rows={2} placeholder="A cabin by a quiet lake at dusk" />}</Field>
  </>;
}
