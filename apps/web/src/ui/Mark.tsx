import { useId } from "react";
import { markSvg } from "@/ui/mark-svg";
import { cx } from "@/ui/primitives";

/** The app mark as the night tile, with a hairline for the black window. Decorative unless `label` is given. */
export function Mark({ size = 40, className, label }: { size?: number; className?: string; label?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <span
      className={cx("mark", className)}
      style={{ width: size, height: size }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      dangerouslySetInnerHTML={{ __html: markSvg({ id: `m${id}`, edge: true, small: size <= 32 }) }}
    />
  );
}

// Both tiles, for the wordmark that follows the theme.
const DAY_TILE = markSvg({ id: "brand-day", tone: "day", small: true });
const NIGHT_TILE = markSvg({ id: "brand-night", tone: "night", small: true });

/**
 * The mark's tile beside the wordmark (the sidebar, the welcome): the day tile, cream, on the night window, and the
 * night tile, ink, on the day one, so it always stands off the window behind it. Decorative.
 */
export function BrandTile({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <span className={cx("brand-tile", className)} style={{ width: size, height: size }} aria-hidden>
      <span className="brand-tile__day" dangerouslySetInnerHTML={{ __html: DAY_TILE }} />
      <span className="brand-tile__night" dangerouslySetInnerHTML={{ __html: NIGHT_TILE }} />
    </span>
  );
}
