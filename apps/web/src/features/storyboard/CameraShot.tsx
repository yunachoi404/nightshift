import { useRef, useState } from "react";
import type { Project, StepId } from "@nightshift/contract";
import { useNavigate } from "react-router";
import { useEngine, useProjectJobs } from "@/store/engine";
import { Button, Field, Notice, Textarea, toast } from "@/ui/primitives";
import { CameraMovePicker, cameraPhotoHint } from "@/features/newproject/CameraMoveFields";
import { failureText, isActive, jobStatusLine } from "@/features/project/helpers";

export function CameraShot({ project }: { project: Project }) {
  const { updateProject, draft, client } = useEngine();
  const jobs = useProjectJobs(project.id);
  const nav = useNavigate();
  const shot = project.shots[0];
  const [prompt, setPrompt] = useState(shot?.prompt ?? String(project.brief.prompt ?? ""));
  const [saving, setSaving] = useState(false);
  const saves = useRef(Promise.resolve());
  const active = jobs.find((j) => isActive(j) && (["text", "camera_layout", "video_camera_move"] as StepId[]).includes(j.step as StepId));
  const failed = !active && jobs.find((j) => j.step === "video_camera_move" && j.status === "failed");
  const photoId = shot?.stillAssetId ?? String(project.brief.photoAssetId ?? "");
  const save = async (move?: string) => {
    if (!shot) return false;
    let failed = false;
    setSaving(true);
    const next = saves.current.then(async () => {
      const latest = await client.getProject(project.id);
      const current = latest.shots[0];
      if (!current) return;
      await updateProject(project.id, { brief: { ...latest.brief, prompt, ...(move ? { move } : {}) }, shots: [{ ...current, prompt, ...(move ? { cameraMove: move } : {}) }] });
    }).catch((e) => { failed = true; toast({ title: "Couldn't save the shot", text: String(e), tone: "bad" }); });
    saves.current = next;
    await next;
    if (saves.current === next) setSaving(false);
    return !failed;
  };
  return <div className="page">
    <div className="page__head"><div><h1 className="page__title">Photo & camera move</h1><p className="page__sub">One photo, one 4-second shot. Try a different path or compare takes.</p></div>
      <Button variant="primary" disabled={!shot || saving || !!active} onClick={async () => { if (!shot || !(await save())) return; try { await draft(project.id, shot.id); nav(`/p/${project.id}/takes`); } catch (e) { toast({ title: "Couldn't start the shot", text: String(e), tone: "bad" }); } }}>Make another take</Button></div>
    {active && <Notice title="Making your shot">{jobStatusLine(active)}</Notice>}
    {failed && <Notice title="Couldn't make the shot" tone="bad">{failureText(failed)}</Notice>}
    <div className="camera-shot">
      <div className="camera-shot__photo">{photoId && <img src={client.assetUrl(project.id, photoId)} alt="Source photo for the camera move" />}<p>{cameraPhotoHint(shot?.cameraMove ?? String(project.brief.move))}</p></div>
      <div className="camera-shot__controls">
        <Field label="Camera move">{() => <CameraMovePicker value={shot?.cameraMove ?? String(project.brief.move)} onChange={(move) => void save(move)} />}</Field>
        <Field label="Scene">{(id) => <Textarea id={id} value={prompt} rows={3} onChange={(e) => setPrompt(e.target.value)} onBlur={() => void save()} />}</Field>
      </div>
    </div>
  </div>;
}
