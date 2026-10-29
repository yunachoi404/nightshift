import { useId } from "react";
import { markSvg } from "@/ui/mark-svg";
import { cx } from "@/ui/primitives";

/** The app mark as a rounded tile. Decorative unless `label` is given. */
export function Mark({ size = 40, className, label }: { size?: number; className?: string; label?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <span
      className={cx("mark", className)}
      style={{ width: size, height: size }}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      dangerouslySetInnerHTML={{ __html: markSvg({ id: `m${id}` }) }}
    />
  );
}
