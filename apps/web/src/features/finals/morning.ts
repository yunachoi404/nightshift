import { useCallback, useMemo, useState } from "react";
import { useJobs } from "@/store/engine";

const KEY = "nightshift.overnightSeen";

/** Overnight finals that finished since the user last looked. Null when there is nothing to tell. */
export function useMorningSummary(projectId?: string) {
  const jobs = useJobs();
  const [seen, setSeen] = useState<string>(() => {
    const v = localStorage.getItem(KEY);
    if (v) return v;
    const now = new Date().toISOString();
    localStorage.setItem(KEY, now);
    return now;
  });
  const dismiss = useCallback(() => {
    const now = new Date().toISOString();
    localStorage.setItem(KEY, now);
    setSeen(now);
  }, []);
  return useMemo(() => {
    const finished = jobs.filter((j) => j.mode === "overnight" && (j.status === "done" || j.status === "failed") && j.finishedAt && j.finishedAt > seen && (!projectId || j.projectId === projectId));
    if (!finished.length) return null;
    const stillRunning = jobs.some((j) => j.mode === "overnight" && (j.status === "running" || j.status === "queued") && (!projectId || j.projectId === projectId));
    if (stillRunning) return null;
    return {
      done: finished.filter((j) => j.status === "done").length,
      failed: finished.filter((j) => j.status === "failed").length,
      projectIds: Array.from(new Set(finished.map((j) => j.projectId))),
      dismiss,
    };
  }, [jobs, seen, projectId, dismiss]);
}
