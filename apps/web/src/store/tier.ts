import type { HardwareProfile, TierSummary } from "@nightshift/contract";
import { useEffect, useState } from "react";
import { useEngine, useEngineState } from "./engine";

/** Cached per compute location: this machine, or the GPU computer on the network. */
let hwCache: { key: string; profile: HardwareProfile } | null = null;

export function useTiers(): TierSummary[] | null {
  return useEngineState().tiers;
}

/** The tier that is installed, with its estimates. Null until known. */
export function useInstalledTier(): TierSummary | null {
  const { settings } = useEngineState();
  const tiers = useTiers();
  return tiers?.find((t) => t.tier === settings?.tier) ?? null;
}

export function useHardware(): HardwareProfile | null {
  const { client } = useEngine();
  const { status, settings } = useEngineState();
  const key = `${status?.mode ?? ""}:${status?.mode === "remote" ? (settings?.remote?.url ?? "") : ""}`;
  const [hw, setHw] = useState<HardwareProfile | null>(hwCache?.key === key ? hwCache.profile : null);
  useEffect(() => {
    if (hwCache?.key === key) {
      setHw(hwCache.profile);
      return;
    }
    let active = true;
    client
      .hardware()
      .then((h) => {
        hwCache = { key, profile: h };
        if (active) setHw(h);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, key]);
  return hw;
}

export function estimateSeconds(tier: TierSummary | null, step: keyof NonNullable<TierSummary["estimates"]>): number | null {
  return tier?.estimates?.[step]?.seconds ?? null;
}

/**
 * On a setup whose same-take final only upscales the draft (it adds no detail), how much: `to` is " to 2x", or "" when
 * the recipe does not say. Null when the final renders the take again, which sharpens it, or the setup is not known.
 * Copy about finals reads this, so it never says "sharper" where it is not.
 */
export function upscaleOnly(tier: TierSummary | null | undefined): { to: string } | null {
  const take = tier?.sameTake;
  if (take?.method !== "upscale") return null;
  return { to: take.scale ? ` to ${take.scale}x` : "" };
}

/**
 * How long writing a list of `shots` shots takes on this setup, or null when it has no estimate. The recipe's `text`
 * time is for a three-shot list (about 200 tokens), and the time grows with what is written: on an RTX 2080 SUPER one
 * shot took 209 s and three took 483 s, so about 15% of it is fixed and the rest goes per shot.
 */
export function shotListSeconds(tier: TierSummary | null | undefined, shots: number): number | null {
  const seconds = tier?.estimates?.text?.seconds;
  if (!seconds || !Number.isFinite(seconds)) return null;
  return seconds * (0.15 + (0.85 * Math.max(1, shots)) / 3);
}

/** Plain names by weight. The user never sees model names. */
export function tierName(t: TierSummary, recommended: TierSummary | null): string {
  const heavy = t.downloadGb >= 80;
  const mid = t.downloadGb >= 40;
  const base = heavy ? "Full studio" : mid ? "Studio" : "Light studio";
  if (recommended && t.tier !== recommended.tier) return t.downloadGb < recommended.downloadGb ? `${base}, lighter` : `${base}, heavier`;
  return base;
}

/**
 * What kind of machine a setup is for, in plain words, from what it needs. The recipe's own label is a note for the
 * people who write recipes and can carry caveats; the Estimated tag already says when times are not measured.
 */
export function tierFor(t: TierSummary): string {
  const m = t.match;
  if (m.vendor === "apple") return `Apple Silicon with ${m.minRamGb} GB or more`;
  if (m.unifiedMemory) return `Machines like a DGX Spark, ${m.minVramGb} GB or more of shared memory`;
  const vendor = m.vendor === "nvidia" ? "NVIDIA" : m.vendor === "amd" ? "AMD" : m.vendor === "intel" ? "Intel" : "Any";
  return `${vendor} graphics with ${m.minVramGb} GB or more${m.minRamGb > 16 ? `, and ${m.minRamGb} GB of memory` : ""}`;
}

/** "This Mac" on a Mac, "This computer" anywhere else. */
export function machineName(mac: boolean, lower = false): string {
  const name = mac ? "This Mac" : "This computer";
  return lower ? name.toLowerCase().replace("mac", "Mac") : name;
}

/** Whether a hardware profile, if known, says macOS; else the best guess from the desktop shell or the browser. */
export function isMac(os?: HardwareProfile["os"] | null): boolean {
  const desktop = typeof window !== "undefined" ? window.nightshiftDesktop?.platform : undefined;
  if (desktop) return desktop === "darwin";
  if (os) return os === "macos";
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);
}

/**
 * The machine the engine runs on: where projects live and exports run. Its hardware is known when work runs here;
 * when it runs on a GPU computer, the hardware read is that computer's, so the desktop shell or the browser decides.
 */
export function useThisMachine(): { name: string; lower: string } {
  const hw = useHardware();
  const { status } = useEngineState();
  const local = status?.mode === "local" || status?.mode === "mock";
  const mac = isMac(local ? hw?.os : null);
  return { name: machineName(mac), lower: machineName(mac, true) };
}
