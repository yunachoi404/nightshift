import { sentenceCase, templates, type Asset, type Project, type TemplateId } from "@nightshift/contract";
import { MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { NightHorizon } from "@/ui/NightHorizon";
import { useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useEngine, useEngineState, useJobs, useProjectList } from "@/store/engine";
import { Button, Dialog, Input, Menu, MenuItem, Segmented, Tag, cx, toast } from "@/ui/primitives";
import { Media } from "@/media/Media";
import { assetById, bestAssetFor, coverFor, fitFor, isActive, projectProgress, projectStage, timelineShots, totalDuration, type ProjectProgress } from "@/features/project/helpers";
import { plural, relativeTime, timecode } from "@/lib/format";
import { useMorningSummary } from "@/features/finals/morning";
import { useCompute } from "@/app/ComputePopover";
import { TemplateIcon } from "@/features/project/TemplateIcon";
import { DemoBanner } from "@/features/demo/DemoNote";
import { modKey } from "@/app/useSidebar";
import { Dawn } from "@/ui/Dawn";
import "./home.css";

type Show = "all" | ProjectProgress;

/** The presets the New project card offers as a start, in its order. Each opens New project on that preset. */
const STARTS: TemplateId[] = ["micro_drama", "product_ad", "music_video"];

export function Home() {
  const projects = useProjectList();
  const jobs = useJobs();
  const { status } = useEngineState();
  const { away } = useCompute();
  const morning = useMorningSummary();
  const [params, setParams] = useSearchParams();
  // The search and the filter live in the address, so Back from a project returns to the same view.
  const query = (params.get("q") ?? "").trim();
  const shown = params.get("show");
  const show: Show = shown === "ready" || shown === "progress" ? shown : "all";

  const named = useMemo(() => {
    const words = query.toLowerCase();
    return words ? projects.filter((p) => p.name.toLowerCase().includes(words)) : projects;
  }, [projects, query]);
  const progress = useMemo(() => new Map(named.map((p) => [p.id, projectProgress(p, jobs, away)])), [named, jobs, away]);
  const count = (s: ProjectProgress) => named.filter((p) => progress.get(p.id) === s).length;
  const visible = show === "all" ? named : named.filter((p) => progress.get(p.id) === show);

  const setShow = (next: Show) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next === "all") p.delete("show");
        else p.set("show", next);
        return p;
      },
      { replace: true },
    );
  const clearSearch = () =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.delete("q");
        return p;
      },
      { replace: true },
    );

  return (
    <div className="page page--home">
      <div className="page__head">
        <div>
          <h1 className="page__title">Projects</h1>
          <p className="page__sub">{projects.length ? `${plural(projects.length, "project")} on this machine. Drafts by day, finals overnight.` : "Everything you make lives here, on this machine"}</p>
        </div>
        {projects.length > 0 && (
          <Segmented
            label="Show"
            className="home-filter"
            value={show}
            onChange={setShow}
            options={[
              { value: "all", label: <FilterLabel label="All" count={named.length} /> },
              { value: "progress", label: <FilterLabel label="In progress" count={count("progress")} /> },
              { value: "ready", label: <FilterLabel label="Ready" count={count("ready")} /> },
            ]}
          />
        )}
      </div>

      <DemoBanner />

      {morning && (
        <div className="morning" role="status">
          <Dawn className="morning__dawn" />
          <div className="morning__body">
            <div className="morning__title">Finished overnight</div>
            <div className="morning__text">
              {morning.done ? `${plural(morning.done, "final")} finished` : "No finals finished"}
              {morning.failed ? `, ${morning.failed} didn't work` : ""}
              {morning.projectIds.length === 1 ? "" : ` across ${morning.projectIds.length} projects`}
            </div>
          </div>
          <div className="morning__actions">
            {morning.projectIds.length === 1 && (
              <Link to={`/p/${morning.projectIds[0]}/media`} className="btn btn--night btn--s" onClick={morning.dismiss}>
                See the finals
              </Link>
            )}
            <Button variant="quiet" size="s" onClick={morning.dismiss}>
              Got it
            </Button>
          </div>
        </div>
      )}

      {projects.length === 0 ? (
        <div className="empty">
          <NightHorizon className="empty__art" />
          <div className="empty__title">Start a project</div>
          <p className="empty__text">Start blank, or from a preset like a micro drama or a product ad. Make images, clips, voice and music, then cut them on one timeline.</p>
          <Link to="/new" className="btn btn--primary">
            <Plus /> New project
          </Link>
          {status?.phase !== "ready" && <p className="t-small t-muted">The engine is {status?.phase === "starting" ? "starting" : "not ready"}. You can set things up, rendering waits.</p>}
        </div>
      ) : (
        <>
          <div className="home-grid">
            {/* Starting a project is where the page begins, unless the page is narrowed to some of them. */}
            {show === "all" && !query && <NewProjectCard />}
            {visible.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
          {visible.length === 0 && (
            <div className="home-none">
              {query ? (
                <>
                  <p>{show === "ready" ? "No ready projects" : show === "progress" ? "No projects in progress" : "No projects"} match “{query}”</p>
                  <Button size="s" onClick={clearSearch}>
                    Clear the search
                  </Button>
                </>
              ) : (
                <p>{show === "ready" ? "Nothing is ready to export yet. A project is ready when every shot in its cut has a final." : "Every project is ready to export"}</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function FilterLabel({ label, count }: { label: string; count: number }) {
  return (
    <>
      {label}
      <span className="home-filter__count">{count}</span>
    </>
  );
}

/**
 * The first card: an empty frame to start a project in, beside the projects' pictures, and three presets people start
 * with most, each a link to New project on that preset.
 */
function NewProjectCard() {
  return (
    <div className="pnew">
      <Link to="/new" className="pnew__link" title={`New project (${modKey()}N)`}>
        <span className="pnew__stage" aria-hidden>
          <span className="corners" />
          <span className="pnew__plus">
            <Plus />
          </span>
        </span>
        <span className="pnew__text">
          <span className="pnew__name">New project</span>
          <kbd className="kbd kbd--bare pnew__keys" aria-hidden>
            {modKey()}N
          </kbd>
        </span>
      </Link>
      <div className="pnew__starts" role="group" aria-label="Start from a preset">
        {STARTS.map((id) => {
          const name = templates.find((t) => t.id === id)?.name ?? id;
          return (
            <Link key={id} to={`/new?preset=${id}`} className="pnew__start" title={`New ${name.toLowerCase()}`}>
              {name}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/** A project as its picture, with where it stands on it, its length, and a footer with its name, size and age. */
function ProjectCard({ project }: { project: Project }) {
  const jobs = useJobs();
  const [hover, setHover] = useState(false);
  const cover = coverFor(project);
  const { away } = useCompute();
  const stage = projectStage(project, jobs, away);
  const cut = timelineShots(project).length;
  const shots = cut || project.shots.length;
  const meta = [shots ? plural(shots, "shot") : "No shots yet", sentenceCase(relativeTime(project.updatedAt))].join(" · ");
  return (
    <article className={cx("pcard", !cover && "pcard--empty")} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <Link to={`/p/${project.id}`} className="pcard__link" onFocus={() => setHover(true)} onBlur={() => setHover(false)}>
        <div className="pcard__media">
          {cover ? <Cover project={project} cover={cover} playing={hover} /> : <div className="pcard__picture"><TemplateIcon template={project.template} className="tpl-icon--l" /></div>}
          <span className="pcard__stage">
            <Tag tone={stage.tone} onMedia>
              {stage.label}
            </Tag>
          </span>
          {cut > 0 && <span className="pcard__length">{timecode(totalDuration(project), false)}</span>}
        </div>
        <div className="pcard__text">
          <div className="pcard__name">{project.name}</div>
          <div className="pcard__meta">{meta}</div>
        </div>
      </Link>
      <ProjectMenu project={project} />
    </article>
  );
}

/**
 * A card's picture. A cover close to the card's shape fills it. A tall one (a vertical project) shows three of its
 * shots side by side, which fill the wide card, with the cover in the middle; with fewer shots it shows whole over a
 * blurred, darkened copy of itself, never on flat black bars.
 */
function Cover({ project, cover, playing }: { project: Project; cover: Asset; playing: boolean }) {
  const { client } = useEngine();
  const url = (a: Asset) => client.assetUrl(project.id, a.id);
  const main = <Media src={url(cover)} kind={cover.kind === "video" ? "video" : "image"} playing={playing} durationSec={cover.durationSec} fit={fitFor(cover, 16 / 9)} />;
  if (fitFor(cover, 16 / 9) === "cover") return <div className="pcard__picture">{main}</div>;
  const sides = sideStills(project, cover);
  if (sides.length === 2)
    return (
      <div className="pcard__picture pcard__picture--three">
        <Media src={url(sides[0]!)} kind="image" fit="cover" />
        <Media src={url(cover)} kind={cover.kind === "video" ? "video" : "image"} playing={playing} durationSec={cover.durationSec} fit="cover" />
        <Media src={url(sides[1]!)} kind="image" fit="cover" />
      </div>
    );
  const backdrop = cover.kind === "image" ? cover : stillOf(project, cover);
  return (
    <div className="pcard__picture">
      {backdrop && <img className="pcard__backdrop" src={url(backdrop)} alt="" aria-hidden draggable={false} />}
      {main}
    </div>
  );
}

/** Two stills of other shots in the cut, in its order, for a tall cover's sides: the ones before and after it. */
function sideStills(project: Project, cover: Asset): Asset[] {
  const stills = timelineShots(project)
    .filter((s) => bestAssetFor(project, s)?.asset.id !== cover.id)
    .map((s) => assetById(project, s.stillAssetId))
    .filter((a): a is Asset => a?.kind === "image" && fitFor(a, 9 / 16) === "cover");
  return stills.length >= 2 ? [stills[0]!, stills[1]!] : [];
}

/** The still a video cover's shot starts from, for the blurred backdrop behind it. */
function stillOf(project: Project, cover: Asset): Asset | undefined {
  const shot = project.shots.find((s) => bestAssetFor(project, s)?.asset.id === cover.id);
  const still = assetById(project, shot?.stillAssetId);
  return still?.kind === "image" ? still : undefined;
}

/** A project's own actions: rename it, or delete it after a confirm. */
function ProjectMenu({ project }: { project: Project }) {
  const { updateProject, deleteProject } = useEngine();
  const jobs = useJobs();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState<"rename" | "delete" | null>(null);
  const [name, setName] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const working = jobs.some((j) => j.projectId === project.id && isActive(j));

  const run = async (work: () => Promise<unknown>, failed: string) => {
    setBusy(true);
    try {
      await work();
      setSheet(null);
    } catch (e) {
      toast({ title: failed, text: e instanceof Error ? e.message : String(e), tone: "bad" });
    } finally {
      setBusy(false);
    }
  };
  const rename = () => {
    const next = name.trim();
    if (!next || next === project.name) return setSheet(null);
    void run(() => updateProject(project.id, { name: next }), "Couldn't rename the project");
  };

  return (
    <div className="pcard__more">
      <Button ref={anchor} variant="quiet" iconOnly icon={<MoreHorizontal />} aria-label={`More for ${project.name}`} title="More" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} />
      <Menu open={open} onClose={() => setOpen(false)} anchor={anchor}>
        <MenuItem
          icon={<Pencil />}
          onClick={() => {
            setOpen(false);
            setName(project.name);
            setSheet("rename");
          }}
        >
          Rename
        </MenuItem>
        <div className="menu__sep" role="separator" />
        <MenuItem
          icon={<Trash2 />}
          danger
          onClick={() => {
            setOpen(false);
            setSheet("delete");
          }}
        >
          Delete
        </MenuItem>
      </Menu>

      <Dialog open={sheet === "rename"} onClose={() => !busy && setSheet(null)} width={420}>
        <form
          className="dialog__form"
          onSubmit={(e) => {
            e.preventDefault();
            rename();
          }}
        >
          <h2 className="dialog__title">Rename project</h2>
          <Input aria-label="Project name" autoFocus value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
          <div className="dialog__actions">
            <Button variant="quiet" onClick={() => setSheet(null)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" busy={busy} disabled={!name.trim()}>
              Rename
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={sheet === "delete"} onClose={() => !busy && setSheet(null)} width={440}>
        <h2 className="dialog__title">Delete “{project.name}”?</h2>
        <p className="dialog__text">
          Everything in it is deleted from this machine: its pictures, clips, sound and exports.{working ? " Its work in the queue stops." : ""} This can't be undone.
        </p>
        <div className="dialog__actions">
          <Button variant="quiet" onClick={() => setSheet(null)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" busy={busy} onClick={() => void run(() => deleteProject(project.id), "Couldn't delete the project")}>
            Delete project
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
