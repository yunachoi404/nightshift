import { useMemo } from "react";
import { cx } from "@/ui/primitives";

/**
 * A song or a voiceover drawn as bars: a steady swell for music, phrases with pauses for speech. The same seed always
 * draws the same shape. It shows what kind of sound sits there, not its real loudness.
 */
export function Wave({ seed, n, speech, className }: { seed: number; n: number; speech?: boolean; className?: string }) {
  const bars = useMemo(() => {
    let a = seed * 7919 + 13;
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      a = (a * 1103515245 + 12345) & 0x7fffffff;
      const r = (a % 1000) / 1000;
      const env = speech ? (Math.sin(i / 6) > -0.3 ? 1 : 0.15) : 0.6 + 0.4 * Math.sin(i / 11);
      out.push(0.15 + r * 0.85 * env);
    }
    return out;
  }, [seed, n, speech]);
  return (
    <div className={cx("tl__wave", className)} aria-hidden>
      {bars.map((h, i) => (
        <i key={i} style={{ height: `${h * 100}%` }} />
      ))}
    </div>
  );
}
