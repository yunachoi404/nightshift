import { HardwareProfileSchema, type HardwareProfile } from "@nightshift/contract";
import { rm } from "node:fs/promises";
import { readJson, writeJsonAtomic } from "../util.js";
import { detectHardware, systemProbeEnv, type ProbeEnv } from "./probe.js";

/** Detected hardware, cached, plus the user's manual override when detection got it wrong. */
export class HardwareService {
  private detected?: Promise<HardwareProfile>;
  private manual?: HardwareProfile;

  constructor(
    private readonly dataDir: string,
    private readonly overridePath: string,
    private readonly env: ProbeEnv = systemProbeEnv(),
  ) {}

  async load(): Promise<void> {
    const saved = HardwareProfileSchema.safeParse(await readJson(this.overridePath));
    this.manual = saved.success ? { ...saved.data, source: "manual" } : undefined;
  }

  /** Fresh detection (the GPU list is cached; free disk is re-read every time). */
  async detect(): Promise<HardwareProfile> {
    this.detected ??= detectHardware(this.dataDir, this.env).catch((err) => {
      this.detected = undefined;
      throw err;
    });
    const base = await this.detected;
    return { ...base, freeDiskGb: await this.env.freeDiskGb(this.dataDir).catch(() => base.freeDiskGb) };
  }

  /** What recipes are matched against: the manual profile if one is saved, else detection. */
  async effective(): Promise<HardwareProfile> {
    if (!this.manual) return this.detect();
    // Free disk is a fact about this machine even when the GPU is entered by hand.
    const freeDiskGb = await this.env.freeDiskGb(this.dataDir).catch(() => this.manual!.freeDiskGb);
    return { ...this.manual, freeDiskGb };
  }

  async setManual(profile: HardwareProfile): Promise<HardwareProfile> {
    this.manual = { ...profile, source: "manual" };
    await writeJsonAtomic(this.overridePath, this.manual);
    return this.effective();
  }

  async clearManual(): Promise<HardwareProfile> {
    this.manual = undefined;
    await rm(this.overridePath, { force: true });
    return this.detect();
  }
}
