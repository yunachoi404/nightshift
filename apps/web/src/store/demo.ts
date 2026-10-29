import { isMock } from "@/api/config";
import { useEngineState } from "./engine";

/** Renders are simulated: the engine runs in mock mode, or the UI talks to its in-browser mock. */
export function useDemoMode(): boolean {
  return useEngineState().status?.mode === "mock" || isMock();
}
