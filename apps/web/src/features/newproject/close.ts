import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router";

/**
 * Leaves New project: back to where you came from (Projects, or the project you pressed Cmd+N in), or to Projects when
 * the app opened on it.
 */
export function useCloseNewProject(): () => void {
  const nav = useNavigate();
  const loc = useLocation();
  return useCallback(() => {
    if (loc.key !== "default") nav(-1);
    else nav("/", { replace: true });
  }, [nav, loc.key]);
}
