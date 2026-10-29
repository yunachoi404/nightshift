/**
 * Setup is this data dir's fact, not a browser's: whether it is done, and the "First shot" sample it made. Every client
 * asks here, so a new window, browser or profile on a set-up engine goes straight to the studio, and the sample is made
 * at most once, however many clients ask, reconnect or remount. The engine runs the whole sample (shot list, still,
 * then one motion draft), so no client chains its jobs, and none can chain them twice.
 */
import { OnboardingSchema, type Job, type Onboarding, type OnboardingSample, type Project } from "@nightshift/contract";
import { z } from "zod";
import type { EventBus } from "./events.js";
import type { ProjectService } from "./projects/service.js";
import type { ProjectStore } from "./projects/store.js";
import type { JobQueue } from "./queue/queue.js";
import { errorMessage, KeyedMutex, readJson, writeJsonAtomic, type Logger } from "./util.js";

/** The sample: one cinematic shot, made with no typing. */
export const SAMPLE = {
  name: "First shot",
  template: "cinematic_shot",
  aspect: "16:9",
  brief: { idea: "A lone lighthouse on a cliff as a storm rolls in, waves hitting the rocks", cameraMove: "dolly_in", look: "dawn", sequence: "one" },
} as const;

/** On disk: the contract's Onboarding, plus the draft queued for the sample, so at most one is queued. */
const StoredSchema = OnboardingSchema.extend({ draftJobId: z.string().optional() });
type Stored = z.infer<typeof StoredSchema>;

export interface OnboardingDeps {
  /** dataDir/onboarding.json */
  path: string;
  store: ProjectStore;
  service: ProjectService;
  queue: JobQueue;
  bus: EventBus;
  log: Logger;
}

const isSample = (p: Project) => p.name === SAMPLE.name && p.template === SAMPLE.template && p.brief.idea === SAMPLE.brief.idea;

export class OnboardingService {
  private state: Stored = { done: false, sampleProjectId: null };
  private readonly lock = new KeyedMutex();

  constructor(private readonly d: OnboardingDeps) {}

  async load(): Promise<void> {
    const raw = await readJson<unknown>(this.d.path).catch((err: unknown) => this.d.log(`${this.d.path} is unreadable, starting over: ${errorMessage(err)}`));
    const parsed = StoredSchema.safeParse(raw);
    if (parsed.success) {
      this.state = parsed.data;
    } else {
      // A data dir from before the engine kept this. One with projects was set up, and its sample is the oldest
      // project that matches the one the app made by itself.
      const projects = this.d.store.list();
      const sample = projects.filter(isSample).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      this.state = { done: projects.length > 0, sampleProjectId: sample?.id ?? null };
      await this.save();
    }
    this.d.bus.subscribe((e) => {
      if (e.type === "job") this.onJob(e.job);
    });
  }

  get(): Onboarding {
    return { done: this.state.done, sampleProjectId: this.state.sampleProjectId };
  }

  /** Setup is done: the user left the First shot step, or made a project of their own. */
  finish(): Promise<Onboarding> {
    return this.serial(async () => {
      if (!this.state.done) await this.save({ ...this.state, done: true });
      return this.get();
    });
  }

  /**
   * The First shot sample: made and started the first time a client asks, and the same project for every later ask.
   * A deleted sample stays deleted, and once setup is done none is made. `again` makes another: the user asked for it.
   */
  sample(again = false): Promise<OnboardingSample> {
    return this.serial(async () => {
      const id = this.state.sampleProjectId;
      if (!again && (id !== null || this.state.done)) {
        const project = id ? (this.d.store.get(id) ?? null) : null;
        // A start cut short (the engine stopped before the shot list was queued) picks up where it stopped.
        if (project && !this.state.done && project.shots.length === 0 && this.d.queue.list({ projectId: project.id }).length === 0) await this.d.service.storyboard(project.id);
        return { onboarding: this.get(), project };
      }
      const project = await this.d.service.createProject({ ...SAMPLE, brief: { ...SAMPLE.brief } });
      // Kept before any job is queued, so an engine that stops from here on finds this sample instead of making another.
      await this.save({ done: this.state.done, sampleProjectId: project.id });
      await this.d.service.storyboard(project.id);
      return { onboarding: this.get(), project: this.d.store.require(project.id) };
    });
  }

  /** The sample's still is done: queue its motion draft, once, while the user is still on the First shot step. */
  private onJob(job: Job): void {
    if (job.status !== "done" || job.step !== "still" || job.projectId !== this.state.sampleProjectId) return;
    void this.serial(async () => {
      if (this.state.done || this.state.draftJobId || job.projectId !== this.state.sampleProjectId) return;
      const project = this.d.store.get(job.projectId);
      const shot = project?.shots[0];
      if (!project || !shot || shot.id !== job.shotId || !shot.stillAssetId || project.takes.some((t) => t.shotId === shot.id)) return;
      const draft = await this.d.service.draft(project.id, shot.id, {});
      await this.save({ ...this.state, draftJobId: draft.id });
    }).catch((err: unknown) => this.d.log(`the sample's draft did not start: ${errorMessage(err)}`));
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    return this.lock.run("onboarding", fn);
  }

  private async save(next: Stored = this.state): Promise<void> {
    const before = JSON.stringify(this.get());
    this.state = next;
    await writeJsonAtomic(this.d.path, this.state);
    if (JSON.stringify(this.get()) !== before) this.d.bus.emit({ type: "onboarding", onboarding: this.get() });
  }
}
