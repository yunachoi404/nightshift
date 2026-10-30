import { DRAFT_STEPS, draftStepFor, isDraftStep } from "@/features/project/draftSteps";
import { quickEffects, quickMoves } from "@nightshift/contract";
import type { Project, Shot, Take } from "@nightshift/contract";
import { ArrowRight, Check, Clapperboard, Columns2, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useEngine, useProject, useProjectJobs } from "@/store/engine";
import { useInstalledTier } from "@/store/tier";
import { Button, Notice, Tag, cx, toast } from "@/ui/primitives";
import { Media } from "@/media/Media";
import { activeJob, assetById, bestAssetFor, draftsFor, failureText, frameClass, jobStatusLine, lastFailed, timelineShots } from "@/features/project/helpers";
import { useNow } from "@/lib/useNow";
import { roughDuration } from "@/lib/format";
import "./takes.css";

export function Takes() {
  const { id } = useParams();
  const project = useProject(id)!;
  const jobs = useProjectJobs(id);
  const [params, setParams] = useSearchParams();
  const { draft, updateProject, client } = useEngine();
  const tier = useInstalledTier();
  const nav = useNavigate();

  // The cut's shots. Shots kept in Media only are picked from their cards there.
  const shots = timelineShots(project);
  const shotId = params.get("shot") ?? shots.find((s) => s.stillAssetId)?.id ?? shots[0]?.id;
  const shot = shots.find((s) => s.id === shotId) ?? shots[0];
  const [compare, setCompare] = useState(false);
  const [compareIds, setCompareIds] = useState<string[]>([]);

  useEffect(() => {
    setCompare(false);
    setCompareIds([]);
  }, [shot?.id]);

  const drafts = shot ? draftsFor(project, shot) : [];
  const drafting = shot ? jobs.filter((j) => j.shotId === shot.id && isDraftStep(j.step) && (j.status === "queued" || j.status === "running")) : [];
  const failed = shot && !drafting.length ? lastFailed(jobs, shot.id, DRAFT_STEPS) : undefined;
  const est = tier?.estimates?.[draftStepFor(project)]?.seconds;
  const now = useNow(1000, drafting.length > 0);

  const pick = async (take: Take) => {
    if (!shot) return;
    // The engine gives the pick its final (the draft's newest, or none), so the shot leaves the old one out.
    const picked = ({ chosenFinalId: _, ...s }: Shot): Shot => ({ ...s, chosenDraftId: take.id });
    await updateProject(project.id, { shots: project.shots.map((s) => (s.id === shot.id ? picked(s) : s)) }).catch((e) => toast({ title: "Couldn't save", text: String(e), tone: "bad" }));
  };

  const newTake = async () => {
    if (!shot) return;
    try {
      await draft(project.id, shot.id);
    } catch (e) {
      toast({ title: "Couldn't start the draft", text: String(e), tone: "bad" });
    }
  };

  const picked = shots.filter((s) => s.chosenDraftId).length;
  const allPicked = shots.length > 0 && picked === shots.length;
  const nextUnpicked = shots.find((s) => !s.chosenDraftId && s.id !== shot?.id);

  const whatIf = project.template === "what_if";
  const singleShot = whatIf || project.template === "camera_move" || project.template === "vfx_effect";
  const visible = compare && compareIds.length === 2 ? drafts.filter((d) => compareIds.includes(d.id)) : drafts;
  // One-photo projects: what was done to the photo, as the page title and the label between photo and takes.
  const quickLabel = whatIf ? "Your film" : project.template === "vfx_effect" ? (quickEffects.find((effect) => effect.id === project.brief.effect)?.label ?? "Effect") : project.template === "camera_move" ? (quickMoves.find((move) => move.id === (shot?.cameraMove ?? project.brief.move))?.label ?? "Camera move") : undefined;
  const sourcePhoto = singleShot ? assetById(project, shot?.stillAssetId) : undefined;
  // How many takes sit side by side before the row wraps. The CSS sizes each take from this.
  const stageCount = Math.min(Math.max(1, visible.length + (compare ? 0 : drafting.length)), project.aspect === "9:16" ? 4 : 3);

  if (!shots.length) {
    const preparing = singleShot && jobs.some((j) => j.step === "text" && (j.status === "queued" || j.status === "running"));
    return (
      <div className="page">
        <div className="empty">
          <Clapperboard className="empty__icon" />
          <div className="empty__title">{preparing ? "Preparing your photo" : "No shots on the timeline"}</div>
          <p className="empty__text">{preparing ? "Your shot will appear here as it renders." : whatIf ? "Takes are films made from your story. Write the story first." : "Takes are motion drafts of the shots on the timeline. Make shots in Media first."}</p>
          {!preparing && <Link to={`/p/${project.id}/${whatIf ? "storyboard" : "media"}`} className="btn btn--primary">
            {whatIf ? "Go to the story" : "Go to Media"}
          </Link>}
        </div>
      </div>
    );
  }

  return (
    <div className={cx("tk", singleShot && "tk--single")}>
      <nav className="tk-rail" aria-label="Shots">
        <div className="side__head">Shots</div>
        {shots.map((s, i) => (
          <RailShot key={s.id} project={project} shot={s} index={i} current={s.id === shot?.id} onClick={() => setParams({ shot: s.id })} jobs={jobs} />
        ))}
        <div className="tk-rail__foot">
          <span className="t-small t-muted">{picked} of {shots.length} picked</span>
          {allPicked && !shot?.chosenDraftId && (
            <Link to={`/p/${project.id}/finals`} className="btn btn--primary btn--s">
              Go to finals
            </Link>
          )}
        </div>
      </nav>

      {shot && (
        <div className="tk-main">
          <div className="page__head">
            <div>
              <h1 className="page__title">{quickLabel ?? `Shot ${shots.indexOf(shot) + 1}`}</h1>
              <p className="page__sub">{whatIf ? String(project.brief.question) : shot.prompt}</p>
            </div>
            <div className="page__actions">
                  {drafts.length >= 2 && (
                    <Button
                      variant={compare ? "primary" : "ghost"}
                      icon={<Columns2 />}
                      onClick={() => {
                        setCompare((v) => !v);
                        setCompareIds(compare ? [] : drafts.slice(-2).map((d) => d.id));
                      }}
                    >
                      Compare
                    </Button>
                  )}
                  <Button variant={drafts.length ? "ghost" : "primary"} icon={<Plus />} disabled={!shot.stillAssetId || drafting.length > 0 || (whatIf && !shot.keyframes?.every(frame => frame.stillAssetId))} onClick={() => void newTake()} title={est ? roughDuration(est) : undefined}>
                    {drafts.length ? "Another take" : drafting.length ? "Making your shot" : "Make a draft"}
                  </Button>
            </div>
          </div>
          <div className="tk-body">

              {!shot.stillAssetId && (
                <Notice title="This shot has no still yet">
                  Drafts start from a still. <Link to={`/p/${project.id}/storyboard`}>Make one in the storyboard.</Link>
                </Notice>
              )}

              {failed && (
                <Notice tone="bad" title={failed.message ?? "The draft didn't work"}>
                  {failureText(failed)}
                  <div className="notice__actions">
                    <Button size="s" onClick={() => void newTake()}>
                      Try again
                    </Button>
                    {failed.message === "Out of memory" && (
                      <Link to="/settings" className="btn btn--quiet btn--s">
                        Memory settings
                      </Link>
                    )}
                  </div>
                </Notice>
              )}

              {!drafts.length && !drafting.length && shot.stillAssetId && !failed && (
                <div className="tk-empty">
                  <div className="tk-empty__title">No takes yet for this shot</div>
                  <p className="tk-empty__text">A draft is a quick, soft preview of the motion{est ? `, ${roughDuration(est)} on this machine` : ""}. Make two or three and pick the one you like. The final keeps the exact take.</p>
                </div>
              )}

              {compare && compareIds.length === 2 && <div className="t-small t-muted">Comparing two takes. Click Compare again to see all.</div>}

              <div className={cx("tk-stage", singleShot && "tk-stage--single")} style={singleShot ? ({ "--n": stageCount } as React.CSSProperties) : undefined}>
              {singleShot && sourcePhoto && (drafts.length > 0 || drafting.length > 0) && (
                <>
                  <div className="tk-source">
                    <div className={cx("frame", frameClass(project.aspect))}>
                      <Media src={client.assetUrl(project.id, sourcePhoto.id)} kind="image" />
                    </div>
                    <div className="take__line">
                      <span className="take__name">{whatIf ? "Opening frame" : "Your photo"}</span>
                    </div>
                  </div>
                  <div className="tk-arrow" aria-hidden>
                    <ArrowRight />
                    <span>{whatIf ? `${shot.durationSec} s film` : quickLabel}</span>
                  </div>
                </>
              )}
              <div className={cx("tk-grid", project.aspect === "9:16" && "tk-grid--tall", compare && compareIds.length === 2 && "tk-grid--compare")}>
                {visible.map((t) => {
                  const asset = assetById(project, t.videoAssetId);
                  const n = drafts.indexOf(t) + 1;
                  const chosen = shot.chosenDraftId === t.id;
                  const hasFinal = project.takes.some((f) => f.parentTakeId === t.id);
                  return (
                    <div key={t.id} className="take">
                      <div
                        className={cx("frame take__frame frame--selectable", frameClass(project.aspect), chosen && "frame--selected")}
                        onClick={() => {
                          if (compare) setCompareIds((ids) => (ids.includes(t.id) ? ids : [ids[1] ?? ids[0] ?? t.id, t.id].slice(-2)));
                          else void pick(t);
                        }}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.preventDefault();
                          e.currentTarget.click();
                        }}
                        aria-label={`Take ${n}`}
                        aria-pressed={chosen}
                      >
                        {asset && <Media key={`${t.id}-${compare}`} src={client.assetUrl(project.id, asset.id)} kind="video" playing durationSec={shot.durationSec} />}
                        <div className="frame__corner">
                          <Tag onMedia>Draft</Tag>
                          {hasFinal && <Tag onMedia tone="night">Finished</Tag>}
                        </div>
                      </div>
                      <div className="take__line">
                        <span className="take__name">Take {n}</span>
                        <span className="take__meta">{shot.durationSec} s</span>
                        <span className="take__spacer" />
                        <Button size="s" variant={chosen ? "primary" : "ghost"} className="take__pick" icon={chosen ? <Check /> : undefined} onClick={() => void pick(t)}>
                          {chosen ? "Picked" : "Pick"}
                        </Button>
                      </div>
                    </div>
                  );
                })}
                {!compare &&
                  drafting.map((j) => (
                    <div key={j.id} className="take take--working">
                      <div className={cx("frame", frameClass(project.aspect), "frame--empty")}>
                        <div className="take__working">
                          <span className="pulse" />
                          <span>{jobStatusLine(j, now)}</span>
                        </div>
                        <div className="frame__progress">
                          <div style={{ width: `${j.progress * 100}%` }} />
                        </div>
                      </div>
                      <div className="take__line">
                        <span className="take__name">Take {drafts.length + drafting.indexOf(j) + 1}</span>
                        <span className="take__meta">{j.status === "running" ? `${Math.round(j.progress * 100)}%` : "waiting"}</span>
                      </div>
                    </div>
                  ))}
              </div>
              </div>

          </div>
          {shot.chosenDraftId && (
            <div className="tk-pickbar">
              <span className="pulse pulse--ok" />
              <span className="tk-pickbar__text">Take {drafts.findIndex((d) => d.id === shot.chosenDraftId) + 1} is picked for this shot.</span>
              {nextUnpicked ? (
                <Button onClick={() => setParams({ shot: nextUnpicked.id })}>
                  Next shot
                </Button>
              ) : (
                <Button variant="primary" onClick={() => nav(`/p/${project.id}/finals`)}>
                  Finish
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RailShot({ project, shot, index, current, onClick, jobs }: { project: Project; shot: Shot; index: number; current: boolean; onClick: () => void; jobs: ReturnType<typeof useProjectJobs> }) {
  const { client } = useEngine();
  const best = bestAssetFor(project, shot);
  const drafts = useMemo(() => draftsFor(project, shot), [project, shot]);
  const working = activeJob(jobs, shot.id, DRAFT_STEPS);
  const status = shot.chosenFinalId ? "Final ready" : shot.chosenDraftId ? `Take ${drafts.findIndex((d) => d.id === shot.chosenDraftId) + 1} picked` : working ? "Drafting" : drafts.length ? `${drafts.length} to pick from` : shot.stillAssetId ? "No takes" : "No still";
  return (
    <button type="button" className="tk-shot" aria-current={current} onClick={onClick}>
      <div className="tk-shot__thumb">
        <div className={cx("frame", frameClass(project.aspect), !best && "frame--empty")}>{best && <Media src={client.assetUrl(project.id, best.asset.id)} kind={best.rung === "still" ? "image" : "video"} />}</div>
      </div>
      <div className="tk-shot__text">
        <div className="tk-shot__n">Shot {index + 1}</div>
        <div className="tk-shot__s">{status}</div>
      </div>
      {shot.chosenDraftId && <Check className="tk-shot__ok" aria-label="Picked" />}
    </button>
  );
}
