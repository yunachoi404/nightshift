import { useEffect, useState } from "react";

/** The current time, refreshed every `ms`. For elapsed-time labels on running jobs. */
export function useNow(ms = 1000, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms, active]);
  return now;
}
