/**
 * One folder per project under dataDir/projects: project.json plus assets/. Projects are cached in memory
 * and written through atomically. Every change goes out as a "project" event.
 *
 * Every change to a timeline bumps its revision, and the last few timelines of each project are kept in memory, so a
 * PATCH can be judged against the timeline it was read from (see timeline.ts).
 */
import { ProjectSchema, type Asset, type Project, type Timeline } from "@nightshift/contract";
import { copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { extname, join } from "node:path";
import { notFound } from "../errors.js";
import type { EventBus } from "../events.js";
import { probeMedia } from "../media/ffmpeg.js";
import { KeyedMutex, newId, nowIso, readJson, writeJsonAtomic, type Logger } from "../util.js";
import { projectReferences } from "./references.js";
import { withRevision } from "./timeline.js";

/** How many recent timelines each project remembers. */
const KEEP_TIMELINES = 16;

/** Ids we mint look like "prj_lx3k2a9f0c1d2e". Checked before any id touches a path. */
export const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

export class ProjectStore {
  private cache = new Map<string, Project>();
  private locks = new KeyedMutex();
  private recent = new Map<string, Timeline[]>();

  constructor(
    private readonly root: string,
    private readonly bus: EventBus,
    private readonly log: Logger,
  ) {}

  async load(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    for (const id of await readdir(this.root)) {
      if (!SAFE_ID.test(id)) continue;
      const raw = await readJson<unknown>(join(this.root, id, "project.json")).catch(() => undefined);
      const parsed = ProjectSchema.safeParse(raw);
      if (parsed.success) {
        parsed.data.references = projectReferences(parsed.data);
        this.cache.set(parsed.data.id, parsed.data);
        this.remember(parsed.data);
      } else if (raw !== undefined) this.log(`skipping project ${id}: project.json does not match the schema`);
    }
  }

  list(): Project[] {
    return [...this.cache.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): Project | undefined {
    return this.cache.get(id);
  }

  /** The project's recent timelines, newest first: the stored one, then those it replaced. */
  timelines(id: string): Timeline[] {
    return this.recent.get(id) ?? [];
  }

  require(id: string): Project {
    const p = this.cache.get(id);
    if (!p) throw notFound(`No project ${id}`);
    return p;
  }

  dir(id: string): string {
    if (!SAFE_ID.test(id)) throw notFound(`No project ${id}`);
    return join(this.root, id);
  }

  assetPath(project: Project, asset: Asset): string {
    return join(this.dir(project.id), asset.path);
  }

  findAsset(project: Project, assetId: string | undefined): Asset | undefined {
    return assetId ? project.assets.find((a) => a.id === assetId) : undefined;
  }

  async create(fields: Pick<Project, "name" | "template" | "aspect" | "brief"> & Partial<Pick<Project, "references" | "shots" | "boards">>): Promise<Project> {
    const now = nowIso();
    const project: Project = { id: newId("prj"), shots: [], ...fields, takes: [], assets: [], timeline: null, createdAt: now, updatedAt: now };
    await mkdir(join(this.dir(project.id), "assets"), { recursive: true });
    await this.save(project);
    return project;
  }

  /** Apply a change under the project's lock, validate, persist and announce it. */
  async mutate(id: string, fn: (p: Project) => Project | void | Promise<Project | void>): Promise<Project> {
    return this.locks.run(id, async () => {
      const current = this.require(id);
      const draft = structuredClone(current);
      const result = (await fn(draft)) ?? draft;
      // Revisions only grow, even across a timeline set to null, so an old one is never mistaken for a new one.
      result.timeline = withRevision(current.timeline, result.timeline, this.timelines(id)[0]?.revision);
      result.updatedAt = nowIso();
      const valid = ProjectSchema.parse(result);
      await this.save(valid);
      if (valid.timeline && valid.timeline.revision !== current.timeline?.revision) this.remember(valid);
      return valid;
    });
  }

  async delete(id: string): Promise<void> {
    await this.locks.run(id, async () => {
      this.require(id);
      this.cache.delete(id);
      this.recent.delete(id);
      await rm(this.dir(id), { recursive: true, force: true });
    });
  }

  /**
   * Bring a file into the project as an asset (copied, or moved when `move`), probing its size and length.
   * Returns the asset; the caller links it to shots or takes in a mutate.
   */
  async importFile(id: string, src: string, kind: Asset["kind"], opts: { move?: boolean; role?: Asset["role"] } = {}): Promise<Asset> {
    this.require(id);
    const assetId = newId("ast");
    const ext = extname(src).toLowerCase() || ".bin";
    const rel = `assets/${assetId}${ext}`;
    const dest = join(this.dir(id), rel);
    await mkdir(join(this.dir(id), "assets"), { recursive: true });
    if (opts.move) await rename(src, dest).catch(async () => copyFile(src, dest));
    else await copyFile(src, dest);
    const info = kind === "latent" ? {} : await probeMedia(dest);
    const asset: Asset = { id: assetId, kind, path: rel, createdAt: nowIso(), ...info };
    if (opts.role) asset.role = opts.role;
    return asset;
  }

  private remember(project: Project): void {
    if (!project.timeline) return;
    this.recent.set(project.id, [project.timeline, ...this.timelines(project.id)].slice(0, KEEP_TIMELINES));
  }

  private async save(project: Project): Promise<void> {
    await writeJsonAtomic(join(this.dir(project.id), "project.json"), project);
    this.cache.set(project.id, project);
    this.bus.emit({ type: "project", project });
  }
}
