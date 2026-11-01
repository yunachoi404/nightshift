import { cx } from "@/ui/primitives";

/**
 * The lit part of a moon of radius `r` centred on (c, c) at `phase`, 0 new to 1 full, waxing from the right. The
 * terminator is a half ellipse: it bulges right while the moon is a crescent and left once it is gibbous.
 */
export function moonPath(phase: number, c = 8, r = 6.5): string {
  const p = Math.min(1, Math.max(0, phase));
  const rx = Math.abs(1 - 2 * p) * r;
  const sweep = p > 0.5 ? 1 : 0;
  return `M ${c} ${c - r} A ${r} ${r} 0 0 1 ${c} ${c + r} A ${rx.toFixed(3)} ${r} 0 0 ${sweep} ${c} ${c - r} Z`;
}

/**
 * Nightshift's measure of work under way: a small moon that waxes from new to full as a render goes. Moonlight for
 * work now, the street lamp's amber for a final made overnight. Decorative unless `label` is given.
 */
export function Moon({ phase, size = 14, night, label, className, sliver = true }: { phase: number; size?: number; night?: boolean; label?: string; className?: string; sliver?: boolean }) {
  return (
    <svg className={cx("moon", night && "moon--night", className)} viewBox="0 0 16 16" width={size} height={size} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} focusable="false">
      <circle className="moon__disc" cx="8" cy="8" r="6.5" />
      {/* A moon on screen means work under way, so it shows a first sliver of light unless `sliver` is off: a new moon,
          for work not started. */}
      {(sliver || phase > 0) && <path className="moon__lit" d={moonPath(sliver ? Math.max(0.1, phase) : phase)} />}
    </svg>
  );
}
