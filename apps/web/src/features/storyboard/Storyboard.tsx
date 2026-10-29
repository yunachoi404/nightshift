import { DRAFT_STEPS, draftStepFor } from "@/features/project/draftSteps";
import type { Project, Shot } from "@nightshift/contract";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Clapperboard, LayoutGrid, Lock, LockOpen, MoreHorizontal, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useEngine, useProject, useProjectJobs } from "@/store/engine";
import { useInstalledTier } from "@/store/tier";
import { Button, Dialog, Menu, MenuItem, Notice, Select, Tag, cx, toast } from "@/ui/primitives";
import { Media } from "@/media/Media";
import { activeJob, bestAssetFor, failureText, frameClass, isActive, jobElapsed, jobStatusLine, lastFailed, totalDuration } from "@/features/project/helpers";
import { useNow } from "@/lib/useNow";
import { cameraMoves, sentenceCase } from "@nightshift/contract";
import { id as newId } from "@/lib/ids";
import { plural, roughDuration, shortDuration } from "@/lib/format";
import { CameraShot } from "./CameraShot";
import { EffectShot } from "./EffectShot";
import { References, ShotReferences, referenceDropHandlers, type ShotEdit } from "@/features/references/References";
import "./storyboard.css";
import { WhatIfStoryboard } from "./WhatIfStoryboard";

export function Storyboard() {
  const { id } = useParams();
  const project = useProject(id)!;
  const jobs = useProjectJobs(id);
  const { storyboard, still, draft, updateProject, client } = useEngine();
  const tier = useInstalledTier();
  const nav = useNavigate();
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const saves = useRef(Promise.resolve());
  const writing = jobs.find((j) => j.step === "text" && isActive(j));
  // The shot list can take minutes on a small GPU: its elapsed time ticks.
  const now = useNow(1000, writing?.status === "running");
  const writingFailed = !writing && !project.shots.length ? jobs.filter((j) => j.step === "text" && j.status === "failed").at(-1) : undefined;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const saveShots = useCallback(
    (change: (shots: Shot[]) => Shot[]) => {
      // Apply each edit to the last saved version. Blur, camera and duration changes can arrive together.
      saves.current = saves.current.then(async () => {
        const current = await client.getProject(project.id);
        await updateProject(project.id, { shots: change(current.shots).map((s, i) => ({ ...s, index: i })) });
      }).catch((e) => toast({ title: "Couldn't save", text: String(e), tone: "bad" }));
    },
    [project.id, updateProject, client],
  );

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    saveShots((shots) => {
      const from = shots.findIndex((s) => s.id === active.id);
      const to = shots.findIndex((s) => s.id === over.id);
      return from < 0 || to < 0 ? shots : arrayMove(shots, from, to);
    });
  };

  const readyForDrafts = project.shots.filter((s) => s.stillAssetId && !project.takes.some((t) => t.shotId === s.id) && !activeJob(jobs, s.id, DRAFT_STEPS));
  const draftEst = tier?.estimates?.[draftStepFor(project)]?.seconds;

  const makeAllDrafts = async () => {
    try {
      for (const s of readyForDrafts) await draft(project.id, s.id);
      toast({ title: `Making ${plural(readyForDrafts.length, "draft")}`, text: draftEst ? `${sentenceCase(roughDuration(draftEst))} each. Watch them land in Takes.` : "Watch them land in Takes.", tone: "accent" });
      nav(`/p/${project.id}/takes`);
    } catch (e) {
      toast({ title: "Couldn't start drafts", text: String(e), tone: "bad" });
    }
  };

  const addShot = () => {
    const shot: Shot = { id: newId("sht"), index: project.shots.length, prompt: "", cameraMove: "static", durationSec: 4, locked: false };
    saveShots((shots) => [...shots, shot]);
  };

  const gridClass = project.aspect === "9:16" ? "sb-grid--tall" : project.aspect === "1:1" ? "sb-grid--square" : "";

  if (project.template === "camera_move") return <CameraShot key={project.id} project={project} />;
  if (project.template === "vfx_effect") return <EffectShot key={project.id} project={project} />;
  if (project.template === "what_if") return <WhatIfStoryboard key={project.id} project={project} />;

  return (
    <div className="page">
      <div className="page__head">
          <div>
            <h1 className="page__title">Storyboard</h1>
            <p className="page__sub">
              {project.shots.length ? `${plural(project.shots.length, "shot")}, ${shortDuration(totalDuration(project))}. Edit the words, drag to reorder, lock what you like.` : writing ? "Nightshift is writing a shot list from your brief." : "The shot list for this project."}
            </p>
          </div>
          <div className="page__actions">
            {project.shots.length > 0 && (
              <Button variant="quiet" icon={<RefreshCw />} disabled={!!writing} onClick={() => setRewriteOpen(true)}>
                Rewrite shot list
              </Button>
            )}
            {project.shots.length > 0 && (
              <Button variant="quiet" icon={<Plus />} onClick={addShot}>
                Add shot
              </Button>
            )}
            {readyForDrafts.length > 0 && (
              <Button variant="primary" icon={<Clapperboard />} onClick={() => void makeAllDrafts()}>
                {readyForDrafts.length === project.shots.length ? "Make drafts" : `Make ${plural(readyForDrafts.length, "draft")}`}
              </Button>
            )}
            {readyForDrafts.length === 0 && project.shots.length > 0 && project.shots.every((s) => project.takes.some((t) => t.shotId === s.id)) && (
              <Link to={`/p/${project.id}/takes`} className="btn btn--primary">
                Go to takes
              </Link>
            )}
          </div>
        </div>

        <References project={project} />

        {writing && (
          <div className="sb-writing">
            <span className="pulse" />
            {/* A running text job's stage is "Writing" too, so only its time follows. */}
            {writing.status === "queued" ? jobStatusLine(writing) : ["Writing the shot list", jobElapsed(writing, now)].filter(Boolean).join(", ")}
          </div>
        )}

        {writingFailed && (
          <Notice tone="bad" title="Couldn't write the shot list">
            {failureText(writingFailed)}
            <div className="notice__actions">
              <Button size="s" onClick={() => void storyboard(project.id)}>
                Try again
              </Button>
            </div>
          </Notice>
        )}

        {!project.shots.length && !writing && !writingFailed && (
          <div className="empty">
            <LayoutGrid className="empty__icon" />
            <div className="empty__title">No shots yet</div>
            <p className="empty__text">Nightshift writes a shot list from your brief, then draws a still for each shot.</p>
            <Button variant="primary" onClick={() => void storyboard(project.id)}>
              Write the shot list
            </Button>
          </div>
        )}

        {(project.shots.length > 0 || writing) && (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} accessibility={{
            screenReaderInstructions: { draggable: "To reorder this shot, press Space. Use the arrow keys to move it. Press Space to drop it, or Escape to cancel." },
            announcements: {
              onDragStart: ({ active }) => `Picked up shot ${project.shots.findIndex((s) => s.id === active.id) + 1}.`,
              onDragOver: ({ over }) => over ? `Moving to position ${project.shots.findIndex((s) => s.id === over.id) + 1}.` : undefined,
              onDragEnd: ({ over }) => over ? `Shot dropped at position ${project.shots.findIndex((s) => s.id === over.id) + 1}.` : "Shot returned to its place.",
              onDragCancel: () => "Reordering cancelled.",
            },
          }}>
            <SortableContext items={project.shots.map((s) => s.id)} strategy={rectSortingStrategy}>
              <div className={cx("sb-grid", gridClass)}>
                {project.shots.map((s, i) => (
                  <ShotCard
                    key={s.id}
                    project={project}
                    shot={s}
                    index={i}
                    jobs={jobs}
                    onChange={(patch) => saveShots((shots) => shots.map((x) => (x.id === s.id ? { ...x, ...(typeof patch === "function" ? patch(x) : patch) } : x)))}
                    onDelete={() => saveShots((shots) => shots.filter((x) => x.id !== s.id))}
                    onStill={() => void still(project.id, s.id).catch((e) => toast({ title: "Couldn't start", text: String(e), tone: "bad" }))}
                    onDraft={async () => {
                      try {
                        await draft(project.id, s.id);
                        nav(`/p/${project.id}/takes?shot=${s.id}`);
                      } catch (e) {
                        toast({ title: "Couldn't start the draft", text: String(e), tone: "bad" });
                      }
                    }}
                  />
                ))}
                {writing && !project.shots.length && [0, 1, 2].map((k) => <div key={k} className={cx("frame shimmer", frameClass(project.aspect))} />)}
                {project.shots.length > 0 && (
                  <button type="button" className={cx("frame shot__add", frameClass(project.aspect))} onClick={addShot}>
                    <Plus /> Add a shot
                  </button>
                )}
              </div>
            </SortableContext>
          </DndContext>
        )}
      <Dialog open={rewriteOpen} onClose={() => !rewriting && setRewriteOpen(false)} width={480}>
        <h2 className="dialog__title">Rewrite the shot list?</h2>
        <p className="dialog__text">Locked shots keep their place, stills and takes. The new shot list fills the other slots, then adds any remaining shots. Takes for replaced shots are removed.</p>
        <div className="dialog__actions">
          <Button onClick={() => setRewriteOpen(false)} disabled={rewriting}>Cancel</Button>
          <Button variant="primary" busy={rewriting} onClick={async () => {
            setRewriting(true);
            try {
              await storyboard(project.id);
              setRewriteOpen(false);
            } catch (error) {
              toast({ title: "Couldn't rewrite the shot list", text: error instanceof Error ? error.message : String(error), tone: "bad" });
            } finally {
              setRewriting(false);
            }
          }}>Rewrite shot list</Button>
        </div>
      </Dialog>
    </div>
  );
}

function ShotCard({
  project,
  shot,
  index,
  jobs,
  onChange,
  onDelete,
  onStill,
  onDraft,
}: {
  project: Project;
  shot: Shot;
  index: number;
  jobs: ReturnType<typeof useProjectJobs>;
  onChange: (patch: ShotEdit) => void;
  onDelete: () => void;
  onStill: () => void;
  onDraft: () => void;
}) {
  const { client } = useEngine();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: shot.id });
  const best = bestAssetFor(project, shot);
  const stillJob = activeJob(jobs, shot.id, ["still"]);
  const draftJob = activeJob(jobs, shot.id, DRAFT_STEPS);
  const failed = !stillJob ? lastFailed(jobs, shot.id, ["still"]) : undefined;
  const [prompt, setPrompt] = useState(shot.prompt);
  const [menu, setMenu] = useState(false);
  const now = useNow(1000, !!stillJob);
  const menuRef = useRef<HTMLButtonElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setPrompt(shot.prompt), [shot.prompt]);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const resize = () => {
      ta.style.height = "0px";
      ta.style.height = `${Math.max(54, ta.scrollHeight)}px`;
    };
    resize();
    let width = ta.clientWidth;
    const observer = new ResizeObserver(() => {
      if (ta.clientWidth === width) return;
      width = ta.clientWidth;
      resize();
    });
    observer.observe(ta);
    return () => observer.disconnect();
  }, [prompt]);

  const hasDraft = project.takes.some((t) => t.shotId === shot.id);
  const canStill = !shot.locked && prompt.trim().length > 0 && !stillJob;
  const compact = project.aspect !== "16:9";

  return (
    <div {...referenceDropHandlers(project, shot, onChange)} ref={setNodeRef} className={cx("shot", isDragging && "shot--dragging")} style={{ transform: CSS.Transform.toString(transform), transition }}>
      <div className={cx("frame shot__frame", frameClass(project.aspect), !best && "frame--empty", stillJob && best && "frame--working")} {...attributes} {...listeners} aria-label={`Reorder shot ${index + 1}`}>
        {best && <Media src={client.assetUrl(project.id, best.asset.id)} kind={best.rung === "still" ? "image" : "video"} playing={false} />}
        {!best && !stillJob && !failed && (
          <div className="shot__status">
            {prompt.trim() ? (
              <Button size="s" onClick={onStill} onPointerDown={(e) => e.stopPropagation()}>
                Make the still
              </Button>
            ) : (
              <span>Write what's in the shot, then make the still.</span>
            )}
          </div>
        )}
        {stillJob && (
          <>
            <div className="shot__status">
              <span className="pulse" />
              <span>{jobStatusLine(stillJob, now)}</span>
            </div>
            <div className="frame__progress">
              <div style={{ width: `${stillJob.progress * 100}%` }} />
            </div>
          </>
        )}
        {failed && (
          <div className="shot__status shot__status--failed">
            <span>{failed.message ?? "Didn't work"}</span>
            <span className="t-micro">{failureText(failed)}</span>
            <Button size="s" onClick={onStill} onPointerDown={(e) => e.stopPropagation()}>
              Try again
            </Button>
          </div>
        )}
        <div className="frame__corner">
          {best?.rung === "draft" && <Tag onMedia>Draft</Tag>}
          {best?.rung === "final" && <Tag onMedia tone="night">Final</Tag>}
          {draftJob && <Tag onMedia>Drafting</Tag>}
        </div>
        {shot.locked && (
          <div className="frame__corner frame__corner--right">
            <Tag onMedia>
              <Lock /> Locked
            </Tag>
          </div>
        )}
      </div>
      <div className="shot__line">
        <span className="shot__n">Shot {index + 1}</span>
        <span className="shot__dur">
          <input
            type="number"
            min={1}
            max={30}
            step={0.1}
            value={shot.durationSec}
            style={{ width: `${Math.max(1.2, String(shot.durationSec).length + 0.2)}ch` }}
            disabled={shot.locked}
            aria-label="Duration in seconds"
            onChange={(e) => onChange({ durationSec: Math.min(30, Math.max(1, Number(e.target.value) || 1)) })}
          />
          s
        </span>
        <span className="shot__spacer" />
        <Select className="shot__move" value={shot.cameraMove ?? "static"} aria-label="Camera move" onChange={(e) => onChange({ cameraMove: e.target.value })} disabled={shot.locked}>
          {cameraMoves.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
      </div>
      <textarea
        ref={taRef}
        className="shot__prompt"
        aria-label={`Prompt for shot ${index + 1}`}
        value={prompt}
        placeholder="What's in this shot"
        disabled={shot.locked}
        onChange={(e) => setPrompt(e.target.value)}
        onBlur={() => prompt !== shot.prompt && onChange({ prompt })}
        rows={2}
      />
      <ShotReferences project={project} shot={shot} onChange={onChange} />
      <div className="shot__actions">
        <Button size="s" variant="quiet" icon={<RefreshCw />} iconOnly={compact} aria-label={shot.stillAssetId ? "Redraw" : "Draw"} disabled={!canStill} title={shot.locked ? "Unlock to regenerate" : shot.stillAssetId ? "Draw this still again" : "Draw this still"} onClick={onStill}>
          {shot.stillAssetId ? "Redraw" : "Draw"}
        </Button>
        <Button size="s" variant="quiet" icon={<Clapperboard />} disabled={!shot.stillAssetId || !!draftJob} onClick={onDraft} title="Make a motion draft">
          {hasDraft ? "Another take" : "Make draft"}
        </Button>
        <span className="shot__spacer" />
        <Button size="s" variant="quiet" iconOnly icon={shot.locked ? <Lock className="sb-lock" /> : <LockOpen />} aria-label={shot.locked ? "Unlock shot" : "Lock shot"} title={shot.locked ? "Unlock" : "Lock: keep this shot as it is"} onClick={() => onChange({ locked: !shot.locked })} />
        <div style={{ position: "relative" }}>
          <Button ref={menuRef} size="s" variant="quiet" iconOnly icon={<MoreHorizontal />} aria-label="More" onClick={() => setMenu((v) => !v)} />
          <Menu open={menu} onClose={() => setMenu(false)} anchor={menuRef}>
            <MenuItem
              icon={<Trash2 />}
              danger
              onClick={() => {
                setMenu(false);
                onDelete();
              }}
            >
              Delete shot
            </MenuItem>
          </Menu>
        </div>
      </div>
    </div>
  );
}
