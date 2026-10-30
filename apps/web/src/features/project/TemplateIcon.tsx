import type { TemplateId } from "@nightshift/contract";
import { Camera, Clapperboard, Mic, Music2, Package, Sparkles, SquareDashed } from "lucide-react";
import { cx } from "@/ui/primitives";

const icons: Record<TemplateId, typeof Clapperboard> = {
  blank: SquareDashed,
  what_if: Sparkles,
  cinematic_shot: Clapperboard,
  music_video: Music2,
  product_ad: Package,
  talking_intro: Mic,
  camera_move: Camera,
  vfx_effect: Sparkles,
};

/** Stands in for a project's picture until it has one: the template's glyph on the empty-media grey. */
export function TemplateIcon({ template, className }: { template: TemplateId; className?: string }) {
  const Icon = icons[template] ?? Clapperboard;
  return (
    <span className={cx("tpl-icon", className)} aria-hidden>
      <Icon />
    </span>
  );
}
