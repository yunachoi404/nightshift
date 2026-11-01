import { moonPath } from "@/ui/Moon";
import { cx } from "@/ui/primitives";

/**
 * An empty night, in line art: the horizon, the night's path across it and a thin crescent at the top, drawn like the
 * arc on the Queue and in Settings. For empty states that wait for work.
 */
export function NightHorizon({ className }: { className?: string }) {
  return (
    <svg className={cx("night-horizon", className)} viewBox="0 0 120 56" aria-hidden focusable="false">
      <line className="night-horizon__line" x1="4" y1="48" x2="116" y2="48" />
      <path className="night-horizon__path" d="M 14 48 A 46 32 0 0 1 106 48" />
      <path className="night-horizon__moon" d={moonPath(0.3, 8, 6.5)} transform="translate(52 8)" />
    </svg>
  );
}
