import { SettingsSchema, type Settings } from "@nightshift/contract";
import { z } from "zod";
import { readJson, writeJsonAtomic } from "./util.js";

export const DEFAULT_SETTINGS: Settings = {
  tier: null,
  memoryLimitGb: null,
  overnight: { enabled: false, startAt: "23:00", endAt: "07:00" },
  remote: null,
};

const TimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM, 24-hour");

/** PATCH /api/settings body: any subset, and any subset of `overnight`. `remote` is set through /api/remote only. */
export const SettingsPatchSchema = z
  .object({
    tier: SettingsSchema.shape.tier,
    memoryLimitGb: z.number().positive().nullable(),
    overnight: z.object({ enabled: z.boolean(), startAt: TimeSchema, endAt: TimeSchema }).partial(),
  })
  .partial();

export type SettingsPatch = z.infer<typeof SettingsPatchSchema> & { remote?: Settings["remote"] };

/**
 * The time zone this engine's clock is in (IANA, "America/Los_Angeles"): the one the overnight window opens and closes
 * in (`inWindow` reads the local clock). The TZ variable sets it, else the system's.
 */
export function engineTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** The overnight window as saved: its zone is the engine's, added on every read and never saved. */
function savedWindow(w: Settings["overnight"]): Settings["overnight"] {
  return { enabled: w.enabled, startAt: w.startAt, endAt: w.endAt };
}

export class SettingsStore {
  private current: Settings = structuredClone(DEFAULT_SETTINGS);

  constructor(private readonly path: string) {}

  async load(): Promise<Settings> {
    const raw = await readJson<unknown>(this.path);
    const parsed = SettingsSchema.safeParse(raw);
    this.current = parsed.success ? { ...parsed.data, overnight: savedWindow(parsed.data.overnight), remote: parsed.data.remote ?? null } : structuredClone(DEFAULT_SETTINGS);
    return this.get();
  }

  /** The settings, with the overnight window's time zone: the engine's own, so a browser elsewhere reads its times right. */
  get(): Settings {
    const out = structuredClone(this.current);
    out.overnight.timeZone = engineTimeZone();
    return out;
  }

  async update(patch: SettingsPatch): Promise<Settings> {
    const next: Settings = {
      tier: patch.tier !== undefined ? patch.tier : this.current.tier,
      memoryLimitGb: patch.memoryLimitGb !== undefined ? patch.memoryLimitGb : this.current.memoryLimitGb,
      overnight: savedWindow({ ...this.current.overnight, ...patch.overnight }),
      remote: patch.remote !== undefined ? patch.remote : (this.current.remote ?? null),
    };
    this.current = SettingsSchema.parse(next);
    await writeJsonAtomic(this.path, this.current);
    return this.get();
  }
}

/** Minutes since midnight for "HH:MM". */
export function parseClock(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * When the window `date` falls in ends (local time), or undefined for the all-day window. Windows may cross midnight:
 * at 23:30 in 23:00 to 07:00 it ends at 07:00 the next day.
 */
export function windowEnd(date: Date, startAt: string, endAt: string): Date | undefined {
  if (parseClock(startAt) === parseClock(endAt)) return undefined;
  const end = parseClock(endAt);
  const out = new Date(date);
  out.setHours(Math.floor(end / 60), end % 60, 0, 0);
  if (out.getTime() <= date.getTime()) out.setDate(out.getDate() + 1);
  return out;
}

/** True when `date` (local time) falls in the [startAt, endAt) window. Windows may cross midnight. */
export function inWindow(date: Date, startAt: string, endAt: string): boolean {
  const now = date.getHours() * 60 + date.getMinutes();
  const start = parseClock(startAt);
  const end = parseClock(endAt);
  if (start === end) return true; // a zero-length window means "all day"
  return start < end ? now >= start && now < end : now >= start || now < end;
}
