import type { Job } from '@nightshift/contract';

export const isActive = (job: Job): boolean => job.status === 'queued' || job.status === 'running';
export const isFinal = (job: Job): boolean => job.step === 'video_final_same_take' || job.step === 'video_final_remaster';

/** Reconciles snapshots without replaying historical notifications on app launch. */
export class JobTracker {
  private jobs = new Map<string, Job>();
  private notified = new Set<string>();
  constructor(private notify: (job: Job) => void, private changed: (active: number) => void) {}

  get activeCount(): number {
    return [...this.jobs.values()].filter(j => j.mode === 'overnight' && isActive(j)).length;
  }
  snapshot(jobs: Job[]): void {
    const old = this.jobs;
    this.jobs = new Map(jobs.map(job => [job.id, job]));
    for (const job of jobs) this.check(job, old.get(job.id), false);
    this.changed(this.activeCount);
  }
  event(job: Job): void {
    const old = this.jobs.get(job.id);
    // Frames buffered during snapshot fetch can predate the snapshot. Terminal jobs stay terminal.
    if (old && !isActive(old)) return;
    if (old?.status === 'running' && job.status === 'queued') return;
    this.jobs.set(job.id, job);
    this.check(job, old, true);
    this.changed(this.activeCount);
  }
  clear(): void { this.jobs.clear(); this.changed(0); }
  private check(job: Job, previous: Job | undefined, live: boolean): void {
    const key = `${job.id}:${job.status}`;
    if (job.mode !== 'overnight' || !isFinal(job) || !['done', 'failed'].includes(job.status)) return;
    if (this.notified.has(key) || (!live && (!previous || !isActive(previous)))) return;
    if (previous?.status === job.status) return;
    this.notified.add(key);
    this.notify(job);
  }
}
