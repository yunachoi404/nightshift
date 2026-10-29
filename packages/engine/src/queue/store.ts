import { JobSchema, type Job } from "@nightshift/contract";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** What the worker needs to run a job again after a restart. Interpreted by the project service. */
export type JobPayload = Record<string, unknown>;

export interface StoredJob {
  job: Job;
  payload: JobPayload;
  seq: number;
}

/** Jobs survive restarts: one SQLite row per job (node:sqlite, no native addon). */
export class JobStore {
  private db: DatabaseSync;
  private seq = 0;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        status TEXT NOT NULL,
        project_id TEXT NOT NULL,
        job TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status);
    `);
    const row = this.db.prepare("SELECT MAX(seq) AS seq FROM jobs").get() as { seq: number | null } | undefined;
    this.seq = row?.seq ?? 0;
  }

  nextSeq(): number {
    return ++this.seq;
  }

  put(entry: StoredJob): void {
    this.db
      .prepare("INSERT INTO jobs (id, seq, status, project_id, job, payload) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, job = excluded.job, payload = excluded.payload")
      .run(entry.job.id, entry.seq, entry.job.status, entry.job.projectId, JSON.stringify(entry.job), JSON.stringify(entry.payload));
  }

  all(): StoredJob[] {
    const rows = this.db.prepare("SELECT seq, job, payload FROM jobs ORDER BY seq").all() as { seq: number; job: string; payload: string }[];
    const out: StoredJob[] = [];
    for (const r of rows) {
      const parsed = JobSchema.safeParse(JSON.parse(r.job));
      if (parsed.success) out.push({ job: parsed.data, payload: JSON.parse(r.payload) as JobPayload, seq: r.seq });
    }
    return out;
  }

  /** Drop finished jobs beyond the newest `keep`, so the table does not grow forever. */
  prune(keep: number): void {
    this.db
      .prepare(
        "DELETE FROM jobs WHERE status IN ('done','failed','cancelled') AND id NOT IN (SELECT id FROM jobs WHERE status IN ('done','failed','cancelled') ORDER BY seq DESC LIMIT ?)",
      )
      .run(keep);
  }

  close(): void {
    this.db.close();
  }
}
