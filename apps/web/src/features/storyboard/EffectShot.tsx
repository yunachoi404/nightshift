import { useRef, useState } from "react";
import type { Project, StepId } from "@nightshift/contract";
import { useNavigate } from "react-router";
import { useEngine, useProjectJobs } from "@/store/engine";
import { Button, Field, Notice, Textarea, toast } from "@/ui/primitives";
import { EffectPicker } from "@/features/newproject/EffectFields";
import { failureText, isActive, jobStatusLine } from "@/features/project/helpers";

/** The first stage of an Effect project: the photo, the effect, and the subject line. Same shape as CameraShot. */
export function EffectShot({ project }: { project: Project }) {
  const { updateProject, draft, client } = useEngine();
  const jobs = useProjectJobs(project.id);
  const nav = useNavigate();
  const shot = project.shots[0];
  const [prompt, setPrompt] = useState(shot?.prompt ?? String(project.brief.prompt ?? ""));
  const [saving, setSaving] = useState(false);
  const saves = useRef(Promise.resolve());
  const active = jobs.find((j) => isActive(j) && (["text", "effect_end_frame", "video_effect"] as StepId[]).includes(j.step as StepId));
  const failed = !active && jobs.filter((j) => (j.step === "video_effect" || j.step === "text") && j.status === "failed").at(-1);
  const photoId = shot?.stillAssetId ?? String(project.brief.photoAssetId ?? "");
  const effect = String(project.brief.effect ?? "");
  const save = async (next?: string) => {
    if (!shot) return false;
    let failed = false;
    setSaving(true);
    const run = saves.current.then(async () => {
      const latest = await client.getProject(project.id);
      const current = latest.shots[0];
      if (!current) return;
      await updateProject(project.id, { brief: { ...latest.brief, prompt, ...(next ? { effect: next } : {}) }, shots: [{ ...current, prompt }] });
    }).catch((e) => { failed = true; toast({ title: "Couldn't save the shot", text: String(e), tone: "bad" }); });
    saves.current = run;
    await run;
    if (saves.current === run) setSaving(false);
    return !failed;
  };
  return <div className="page">
    <div className="page__head">
      <div>
        <h1 className="page__title">Photo & effect</h1>
        <p className="page__sub">One photo, one 4-second effect shot. Try a different effect or compare takes.</p>
      </div>
      <Button variant="primary" disabled={!shot || saving || !!active} onClick={async () => { if (!shot || !(await save())) return; try { await draft(project.id, shot.id); nav(`/p/${project.id}/takes`); } catch (e) { toast({ title: "Couldn't start the shot", text: String(e), tone: "bad" }); } }}>Make another take</Button>
    </div>
    {active && <Notice title={active.step === "text" ? "Preparing your photo" : "Making your shot"}>{jobStatusLine(active)}</Notice>}
    {failed && <Notice title={failed.step === "text" ? "Couldn't prepare the photo" : "Couldn't make the shot"} tone="bad">{failureText(failed)}</Notice>}
    <div className="camera-shot effect-shot">
      <div className="camera-shot__photo">
        {photoId && <img src={client.assetUrl(project.id, photoId)} alt="Source photo for the effect" />}
        <p>The shot starts from this exact photo. One clear subject with space around it holds the effect best.</p>
      </div>
      <div className="camera-shot__controls">
        <Field label="Effect">{() => <EffectPicker compact value={effect} onChange={(next) => void save(next)} />}</Field>
        <Field label="Subject" hint="Optional. What should change, such as the bottle or the person in the coat.">{(id) => <Textarea id={id} value={prompt} rows={2} placeholder="The amber perfume bottle" onChange={(e) => setPrompt(e.target.value)} onBlur={() => void save()} />}</Field>
      </div>
    </div>
  </div>;
}
