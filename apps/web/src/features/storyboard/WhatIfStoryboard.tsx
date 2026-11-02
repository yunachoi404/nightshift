import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Clapperboard, PenLine, RefreshCw } from "lucide-react";
import { ownShot, whatIfBeatNames, type Job, type Keyframe, type Project } from "@nightshift/contract";
import { useEngine, useProjectJobs } from "@/store/engine";
import { Button, Dialog, Notice, Textarea, toast } from "@/ui/primitives";
import { Media } from "@/media/Media";
import { WriterNote } from "@/features/media/BoardView";
import { failureText, frameClass, isActive } from "@/features/project/helpers";
import "./what-if.css";

type Field = "prompt" | "line";

/** Jobs that make the film's story, its keyframes or its takes: the beats wait for them. */
const FILM_WORK = new Set<Job["step"]>(["text", "still", "video_what_if"]);
/** Jobs a new story changes under them, so a rewrite stops them first. A final or an export goes on. */
const STOPPABLE = (job: Job) => job.step !== "video_final_same_take" && job.step !== "video_final_remaster" && job.step !== "export";

const STATUS: Partial<Record<Job["step"], string>> = {
  text: "Writing your story",
  still: "Drawing the keyframes",
  video_what_if: "Making your film",
  voice: "Recording the narration",
  music: "Making the music",
  video_final_same_take: "Finishing the saved take",
  export: "Exporting your film",
};

export function WhatIfStoryboard({ project }: { project: Project }) {
  const { client, updateProject, storyboard, still, draft, audio, cancelJob } = useEngine();
  const nav = useNavigate();
  const saves = useRef(Promise.resolve());
  /** What each beat's fields hold that is not saved yet. Every action saves it first, so it uses what was typed. */
  const edits = useRef(new Map<string, Partial<Record<Field, string>>>());
  const [busy, setBusy] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  // The film is the project's own shot. Cards made with the tools in Media, and their jobs, are not the story's.
  const shot = ownShot(project);
  const jobs = useProjectJobs(project.id).filter((job) => !job.shotId || job.shotId === shot?.id);
  const takes = project.takes.filter((take) => take.shotId === shot?.id);
  const active = jobs.filter(isActive);
  const writing = active.some((job) => job.step === "text");
  const working = busy || active.some((job) => FILM_WORK.has(job.step));
  const voicing = active.some((job) => job.step === "voice");
  const stoppable = active.filter(STOPPABLE);
  const ready = shot?.keyframes?.every(frame => frame.stillAssetId);
  const failed = jobs.filter(job => job.status === "failed").at(-1);
  const note = !writing ? project.shotList?.note : undefined;

  /** Save the beats' unsaved words, after any save already on its way. Rejects when this save fails. */
  const flush = (): Promise<void> => {
    const pending = new Map(edits.current);
    edits.current.clear();
    if (!pending.size) return saves.current;
    const saved = saves.current.then(async () => {
      const current = await client.getProject(project.id);
      const source = ownShot(current);
      if (!source?.keyframes) return;
      const keyframes = source.keyframes.map(frame => {
        const edit = pending.get(frame.id);
        const prompt = edit?.prompt?.trim();
        return { ...frame, ...(prompt ? { prompt } : {}), ...(edit?.line !== undefined ? { line: edit.line.trim() } : {}) };
      });
      if (keyframes.every((frame, i) => frame.prompt === source.keyframes![i]!.prompt && frame.line === source.keyframes![i]!.line)) return;
      const film = { ...source, keyframes, line: keyframes.map(frame => frame.line).join(" ") };
      await updateProject(project.id, { shots: current.shots.map(item => item.id === film.id ? film : item) });
    });
    saves.current = saved.catch(() => undefined);
    return saved;
  };
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try { await flush(); await action(); }
    catch (error) { toast({ title: "Couldn't finish that", text: error instanceof Error ? error.message : String(error), tone: "bad" }); }
    finally { setBusy(false); }
  };
  const stop = () => Promise.all(stoppable.map((job) => cancelJob(job.id)));
  const rewrite = () => void act(async () => {
    await stop();
    await storyboard(project.id);
    setRewriting(false);
  });

  return <div className="page">
    <div className="page__head">
      <div><h1 className="page__title">{String(project.brief.question)}</h1>
        <p className="page__sub">Four linked keyframes. One continuous film.</p></div>
      <div className="page__actions">
        {shot && <Button variant="quiet" icon={<RefreshCw />} disabled={busy || writing} onClick={() => setRewriting(true)}>Rewrite story</Button>}
        {shot && <Button variant="primary" icon={<Clapperboard />} disabled={working || !ready} onClick={() => void act(async () => {
          await draft(project.id, shot.id); nav(`/p/${project.id}/takes`);
        })}>{takes.length ? "Another take" : "Make a film"}</Button>}
        {!!takes.length && <Link className="btn" to={`/p/${project.id}/takes`}>View takes</Link>}
      </div>
    </div>
    {!!active.length && <div className="whatif-status" role="status"><span className="pulse" />
      <span className="whatif-status__text">{active.map(job => job.message || STATUS[job.step] || "Working").join(" · ")}</span>
      {!!stoppable.length && <Button size="s" variant="quiet" onClick={() => void stop().catch(error => toast({ title: "Couldn't stop that", text: error instanceof Error ? error.message : String(error), tone: "bad" }))}>Stop</Button>}
    </div>}
    {failed && !working && <Notice tone="bad" title="A step needs another try">{failureText(failed)}</Notice>}
    {note && <div className="whatif-note"><WriterNote note={note} project={project} beforeUse={flush} onStory /></div>}
    {!shot?.keyframes ? <div className="empty"><Clapperboard className="empty__icon" /><div className="empty__title">{working ? "Writing your story" : "Your story starts here"}</div>
      <p className="empty__text">An ordinary moment, an impossible change, then its consequence</p>
      {/* A new What if? starts with its question only. Nothing is written until you ask. */}
      {!shot && !active.length && <Button variant="primary" icon={<PenLine />} busy={busy} onClick={() => void act(() => storyboard(project.id))}>Write the story</Button>}</div>
      : <>
        <div className={`whatif-grid ${project.aspect === "9:16" ? "whatif-grid--tall" : ""}`}>
          {shot.keyframes.map((frame, index) => <Beat key={`${shot.id}-${frame.id}`} frame={frame} index={index} project={project} disabled={working}
            drawing={active.some((job) => job.step === "still")}
            onEdit={(field, value) => edits.current.set(frame.id, { ...edits.current.get(frame.id), [field]: value })}
            onLeave={() => void flush().catch(error => toast({ title: "Couldn't save the beat", text: error instanceof Error ? error.message : String(error), tone: "bad" }))}
            onRedraw={() => void act(() => still(project.id, shot.id, { keyframeIndex: index }))} />)}
        </div>
        <div className="whatif-foot"><p className="t-small t-muted">Redrawing a beat also redraws the beats after it. Your existing takes stay saved.</p>
          <Button size="s" variant="quiet" disabled={working || voicing} onClick={() => void act(async () => {
            const current = await client.getProject(project.id);
            await audio(project.id, { role: "voice", text: ownShot(current)?.line ?? "", voice: "mara" });
          })}>{voicing ? "Updating the narration" : "Update narration"}</Button></div>
      </>}
    <Dialog open={rewriting} onClose={() => !busy && setRewriting(false)} width={480}>
      <h2 className="dialog__title">Rewrite the story?</h2>
      <p className="dialog__text">The writer writes four new beats and their narration from your question. Then the keyframes are drawn, and a new film, narration and music are made.</p>
      <p className="dialog__text">The beats and narration on this page are replaced. Your takes and finals stay saved, and the new film becomes the pick when it lands.</p>
      {!!stoppable.length && <p className="dialog__text">What is being made now stops first: {[...new Set(stoppable.map((job) => (STATUS[job.step] ?? "Working").toLowerCase()))].join(", ")}.</p>}
      <div className="dialog__actions">
        <Button onClick={() => setRewriting(false)} disabled={busy}>Cancel</Button>
        <Button variant="primary" busy={busy} onClick={rewrite}>Rewrite story</Button>
      </div>
    </Dialog>
  </div>;
}

function Beat({ frame, index, project, disabled, drawing, onEdit, onLeave, onRedraw }: {
  frame: Keyframe; index: number; project: Project; disabled: boolean; drawing: boolean;
  onEdit(field: Field, value: string): void; onLeave(): void; onRedraw(): void;
}) {
  const { client } = useEngine();
  const [prompt, setPrompt] = useState(frame.prompt);
  const [line, setLine] = useState(frame.line);
  useEffect(() => { setPrompt(frame.prompt); }, [frame.prompt]);
  useEffect(() => { setLine(frame.line); }, [frame.line]);
  return <section className="whatif-beat" aria-label={`Beat ${index + 1}: ${whatIfBeatNames[index]}`}>
    <div className="whatif-beat__head"><span>{index + 1}. {whatIfBeatNames[index]}</span><span className="t-micro t-muted">{index * 5}s</span></div>
    <div className={`frame ${frameClass(project.aspect)} ${frame.stillAssetId ? "" : "frame--empty"}`}>
      {frame.stillAssetId ? <Media kind="image" src={client.assetUrl(project.id, frame.stillAssetId)} thumb={640} />
        : <span className="t-small t-muted">{drawing ? "Waiting for this keyframe" : "Not drawn yet"}</span>}
    </div>
    <label className="whatif-beat__label" htmlFor={`${frame.id}-visual`}>What we see</label>
    <Textarea id={`${frame.id}-visual`} rows={4} value={prompt} disabled={disabled} onBlur={onLeave}
      onChange={event => { setPrompt(event.target.value); onEdit("prompt", event.target.value); }} />
    <label className="whatif-beat__label" htmlFor={`${frame.id}-line`}>Narration</label>
    <Textarea id={`${frame.id}-line`} rows={3} value={line} disabled={disabled} onBlur={onLeave}
      onChange={event => { setLine(event.target.value); onEdit("line", event.target.value); }} />
    <Button size="s" variant="quiet" icon={<RefreshCw />} disabled={disabled || !prompt.trim()} onClick={onRedraw}>{index === 3 ? "Redraw beat" : "Redraw from here"}</Button>
  </section>;
}
