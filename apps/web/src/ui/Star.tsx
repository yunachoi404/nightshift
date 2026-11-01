import { STAR } from "@/ui/mark-svg";

/**
 * The mark's four-point star as an icon, sized and colored like the line icons beside it. It marks the main action
 * and a final: the best a take gets. Decorative.
 */
export function Star({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="-1.2 -1.2 2.4 2.4" width="24" height="24" fill="currentColor" stroke="none" aria-hidden focusable="false" data-icon="star">
      <path d={STAR} />
    </svg>
  );
}
