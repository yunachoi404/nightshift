import { cx } from "@/ui/primitives";

/** Morning after the night shift, in line art: the sun half risen on the horizon, in the lamp's amber. */
export function Dawn({ className }: { className?: string }) {
  return (
    <svg className={cx("dawn", className)} viewBox="0 0 40 24" aria-hidden focusable="false">
      <line x1="2" y1="18" x2="38" y2="18" />
      <path d="M 12 18 A 8 8 0 0 1 28 18" />
      <path d="M 20 4.5 V 7 M 9.4 8.9 L 11.2 10.7 M 30.6 8.9 L 28.8 10.7" />
    </svg>
  );
}
