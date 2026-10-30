import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Clapperboard, PenLine, RefreshCw } from "lucide-react";
import { whatIfBeatNames, type Keyframe, type Project } from "@nightshift/contract";
import { useEngine, useProjectJobs } from "@/store/engine";
import { Button, Notice, Textarea, toast } from "@/ui/primitives";
import { Media } from "@/media/Media";
import { failureText, frameClass, isActive } from "@/features/project/helpers";
import "./what-if.css";

export function WhatIfStoryboard({ project }: { project: Project }) {
  const jobs = useProjectJobs(project.id);
  const { client, updateProject, storyboard, still, draft, audio } = useEngine();
  const nav = useNavigate();
  const saves = useRef(Promise.resolve());
  const [busy, setBusy] = useState(false);
  const shot = project.shots[0];
  const active = jobs.filter(isActive);
  const working = busy || active.some(job => job.step !== "video_final_same_take" && job.step !== "video_final_remaster" && job.step !== "export");
  const ready = shot?.keyframes?.every(frame => frame.stillAssetId);
  const failed = jobs.filter(job => job.status === "failed").at(-1);
  const writer = jobs.find(job => job.step === "text" && job.status === "done");

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try { await saves.current; await action(); }
    catch (error) { toast({ title: "Couldn't finish that", text: String(error), tone: "bad" }); }
    finally { setBusy(false); }
  };
  const save = (id: string, field: "prompt" | "line", value: string) => {
    saves.current = saves.current.then(async () => {
      const current = await client.getProject(project.id);
      const source = current.shots[0];
      if (!source?.keyframes) return;
      const keyframes = source.keyframes.map(frame => frame.id === id ? { ...frame, [field]: value } : frame);
      await updateProject(project.id, { shots: [{ ...source, keyframes, line: keyframes.map(frame => frame.line).join(" ") }] });
    }).catch(error => toast({ title: "Couldn't save the beat", text: String(error), tone: "bad" }));
  };

  return <div className="page">
    <div className="page__head">
      <div><h1 className="page__title">{String(project.brief.question)}</h1>
        <p className="page__sub">Four linked keyframes. One continuous film.</p></div>
      <div className="page__actions">
        {shot && <Button variant="quiet" icon={<RefreshCw />} disabled={busy || active.length > 0} onClick={() => void act(() => storyboard(project.id))}>Rewrite story</Button>}
        {shot && <Button variant="primary" icon={<Clapperboard />} disabled={working || !ready} onClick={() => void act(async () => {
          await draft(project.id, shot.id); nav(`/p/${project.id}/takes`);
        })}>{project.takes.length ? "Another take" : "Make a film"}</Button>}
        {!!project.takes.length && <Link className="btn" to={`/p/${project.id}/takes`}>View takes</Link>}
      </div>
    </div>
    {!!active.length && <div className="whatif-status" role="status"><span className="pulse" />{active.map(job => job.message || (job.step === "text" ? "Writing your story" : job.step === "still" ? "Drawing the keyframes" : job.step === "video_final_same_take" ? "Finishing the saved take" : job.step === "export" ? "Exporting your film" : "Making your film")).join(" · ")}</div>}
    {failed && !working && <Notice tone="bad" title="A step needs another try">{failureText(failed)}</Notice>}
    {writer?.message?.includes("starter story") && <p className="t-small t-muted">The writer used a starter story. You can edit any beat below.</p>}
    {!shot?.keyframes ? <div className="empty"><Clapperboard className="empty__icon" /><div className="empty__title">{working ? "Writing your story" : "Your story starts here"}</div>
      <p className="empty__text">An ordinary moment, an impossible change, then its consequence.</p>
      {/* A new What if? starts with its question only. Nothing is written until you ask. */}
      {!shot && !active.length && <Button variant="primary" icon={<PenLine />} busy={busy} onClick={() => void act(() => storyboard(project.id))}>Write the story</Button>}</div>
      : <>
        <div className={`whatif-grid ${project.aspect === "9:16" ? "whatif-grid--tall" : ""}`}>
          {shot.keyframes.map((frame, index) => <Beat key={`${shot.id}-${frame.id}`} frame={frame} index={index} project={project} disabled={working}
            onSave={(field, value) => save(frame.id, field, value)} onRedraw={() => void act(() => still(project.id, shot.id, { keyframeIndex: index }))} />)}
        </div>
        <div className="whatif-foot"><p className="t-small t-muted">Redrawing a beat also redraws the beats after it. Your existing takes stay saved.</p>
          <Button size="s" variant="quiet" disabled={working} onClick={() => void act(async () => {
            const current = await client.getProject(project.id);
            await audio(project.id, { role: "voice", text: current.shots[0]?.line ?? "", voice: "mara" });
          })}>Update narration</Button></div>
      </>}
  </div>;
}

function Beat({ frame, index, project, disabled, onSave, onRedraw }: {
  frame: Keyframe; index: number; project: Project; disabled: boolean;
  onSave(field: "prompt" | "line", value: string): void; onRedraw(): void;
}) {
  const { client } = useEngine();
  const [prompt, setPrompt] = useState(frame.prompt);
  const [line, setLine] = useState(frame.line);
  useEffect(() => { setPrompt(frame.prompt); }, [frame.prompt]);
  useEffect(() => { setLine(frame.line); }, [frame.line]);
  return <section className="whatif-beat" aria-label={`Beat ${index + 1}: ${whatIfBeatNames[index]}`}>
    <div className="whatif-beat__head"><span>{index + 1}. {whatIfBeatNames[index]}</span><span className="t-micro t-muted">{index * 5}s</span></div>
    <div className={`frame ${frameClass(project.aspect)} ${frame.stillAssetId ? "" : "frame--empty"}`}>
      {frame.stillAssetId ? <Media kind="image" src={client.assetUrl(project.id, frame.stillAssetId)} /> : <span className="t-small t-muted">Waiting for this keyframe</span>}
    </div>
    <label className="whatif-beat__label" htmlFor={`${frame.id}-visual`}>What we see</label>
    <Textarea id={`${frame.id}-visual`} rows={4} value={prompt} disabled={disabled} onChange={event => setPrompt(event.target.value)}
      onBlur={() => { if (prompt.trim() && prompt !== frame.prompt) onSave("prompt", prompt.trim()); }} />
    <label className="whatif-beat__label" htmlFor={`${frame.id}-line`}>Narration</label>
    <Textarea id={`${frame.id}-line`} rows={3} value={line} disabled={disabled} onChange={event => setLine(event.target.value)}
      onBlur={() => { if (line !== frame.line) onSave("line", line.trim()); }} />
    <Button size="s" variant="quiet" icon={<RefreshCw />} disabled={disabled || !prompt.trim()} onClick={onRedraw}>{index === 3 ? "Redraw beat" : "Redraw from here"}</Button>
  </section>;
}
