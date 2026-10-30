import type { Aspect, Project, Timeline } from "@nightshift/contract";
import { Download, Film, Pause, Play, RectangleHorizontal, RectangleVertical, Share2, SkipBack, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { useEngine, useProject, useProjectJobs } from "@/store/engine";
import { upscaleOnly, useInstalledTier } from "@/store/tier";
import { Button, Notice, Segmented, Select, Switch, Tag, cx, toast } from "@/ui/primitives";
import { Media } from "@/media/Media";
import { assetById, failureText, frameClass, isActive, jobStatusLine } from "@/features/project/helpers";
import { cutShots, isCanvasDrag, readDrag, shotLabel } from "@/features/media/items";
import { useNow } from "@/lib/useNow";
import { noFileToast } from "@/store/demo";
import { plural, relativeTime, timecode } from "@/lib/format";
import { scriptLines } from "@nightshift/contract";
import { RevealSheet } from "@/features/reveal/RevealSheet";
import { CaptionPreview, defaultCaptionLook, defaultCaptionSize, type CaptionLook, type CaptionPos } from "./CaptionPreview";
import { filmExportJobs, revealable } from "@/features/reveal/reveal";
import "./editor.css";
import { useCutEdits } from "./edits";
import { MediaSidebar } from "./MediaSidebar";
import { TimelineView, type Clip } from "./Timeline";

export function Editor() {
  const { id } = useParams();
  const project = useProject(id)!;
  return <ProjectEditor key={project.id} project={project} />;
}

/**
 * The editor: the media sidebar on the left, the player and its transport in the middle, captions and export on the
 * right, and the timeline below. Cards come onto the timeline by drag and drop; songs and voiceovers are made on their
 * lanes. The cut itself is the engine's: every edit is a PATCH, and the engine cuts the film again.
 */
function ProjectEditor({ project }: { project: Project }) {
  const id = project.id;
  const jobs = useProjectJobs(id);
  const { exportVideo, updateProject, client } = useEngine();
  const tier = useInstalledTier();
  const upscale = upscaleOnly(tier);
  const edits = useCutEdits(id);

  const timeline: Timeline = project.timeline ?? { clips: [], audio: [], captions: [], style: {} };
  const clips = useMemo<Clip[]>(() => (project.timeline?.clips ?? []).flatMap((cut) => {
    const asset = assetById(project, cut.assetId);
    const shot = project.shots.find((s) => s.id === cut.shotId);
    if (!asset || !shot || (asset.kind !== "image" && asset.kind !== "video")) return [];
    const take = project.takes.find((t) => t.videoAssetId === asset.id);
    return [{ shotId: shot.id, assetId: asset.id, src: client.assetUrl(project.id, asset.id), kind: asset.kind,
      rung: take?.rung ?? "still", start: cut.start, dur: cut.out - cut.in, in: cut.in, move: shot.cameraMove ?? "static", label: shotLabel(project, shot) }];
  }), [project, client]);
  const total = clips.reduce((end, c) => Math.max(end, c.start + c.dur), 0);
  const style = timeline.style as { captions?: boolean; captionLook?: CaptionLook; captionPos?: CaptionPos; captionSize?: number; picture?: Record<string, unknown> & { reframe?: "crop" | "fit_blur" } };
  const captionsOn = style.captions ?? true;
  const captionLook: CaptionLook = style.captionLook ?? defaultCaptionLook(project.template);
  const captionPos: CaptionPos = style.captionPos ?? "bottom";
  const saveStyle = (patch: Partial<typeof style>) =>
    void edits.save((current) => (current.timeline ? { timeline: { ...current.timeline, style: { ...current.timeline.style, ...patch } } } : undefined));

  // ------------------------------------------------------------ playback clock
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const hasClips = clips.length > 0;
  // Move focus out of the navigation control that opened the editor. Space should play immediately.
  useEffect(() => {
    if (hasClips) stageRef.current?.focus({ preventScroll: true });
  }, [id, hasClips]);
  // A shorter cut (a clip taken off) never leaves the playhead past its end.
  useEffect(() => {
    setTime((t) => (t > total ? 0 : t));
    if (!total) setPlaying(false);
  }, [total]);
  const raf = useRef(0);
  const last = useRef(0);
  useEffect(() => {
    if (!playing) return;
    last.current = performance.now();
    const step = (now: number) => {
      const dt = (now - last.current) / 1000;
      last.current = now;
      setTime((t) => {
        const n = t + dt;
        if (n >= total) {
          setPlaying(false);
          return 0;
        }
        return n;
      });
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, total]);

  const totalRef = useRef(total);
  totalRef.current = total;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      // Typing never plays. Other controls keep their keys, except on the timeline and the toolbar.
      if (t?.closest("input, textarea, select, [contenteditable=true], dialog, [role=dialog]")) return;
      if (t?.closest("button, a, [role=slider], [role=radio]") && !t.closest(".tl, .toolbar")) return;
      if (e.key === " ") {
        e.preventDefault();
        if (totalRef.current > 0) setPlaying((p) => !p);
      }
      if (e.key === "Home") setTime(0);
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const step = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 2 : 0.5);
        setTime((now) => Math.max(0, Math.min(totalRef.current, now + step)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const current = clips.find((c) => time >= c.start && time < c.start + c.dur);
  const caption = captionsOn ? timeline.captions.find((c) => time >= c.start && time < c.end) : undefined;
  const voiceTrack = timeline.audio.find((a) => a.role === "voice");
  // Film exports only: a reveal is an export job that carries its shot, and has its own sheet.
  const exportJob = filmExportJobs(jobs).at(-1);
  const cut = cutShots(project);
  const revealShot = cut.length === 1 && cut[0] && revealable(project, cut[0]) ? cut[0] : undefined;
  const [revealOpen, setRevealOpen] = useState(false);
  const now = useNow(1000, !!exportJob && isActive(exportJob));
  const exportAsset = exportJob?.status === "done" ? assetById(project, exportJob.outputAssetIds[0]) : undefined;
  const exportedAspect = exportAsset?.width && exportAsset.height ? aspectOf(exportAsset.width, exportAsset.height) : undefined;
  // The format control follows the last finished export, so the selection and the result below it agree.
  useEffect(() => {
    if (exportedAspect) setExportAspect(exportedAspect);
  }, [exportedAspect, exportAsset?.id]);

  const [exportAspect, setExportAspect] = useState<Aspect>(project.aspect);
  const ratio = (aspect: Aspect) => { const [w, h] = aspect.split(":").map(Number); return w! / h!; };
  const hasDifferentShape = clips.some((clip) => {
    const asset = assetById(project, clip.assetId);
    const sourceRatio = asset?.width && asset?.height ? asset.width / asset.height : ratio(project.aspect);
    return Math.abs(Math.log(sourceRatio / ratio(exportAspect))) > Math.log(1.1);
  });
  const voiceText = project.template === "what_if"
    ? (voiceTrack && assetById(project, voiceTrack.assetId)?.text) ?? project.shots.map((shot) => shot.line ?? "").join(" ")
    : typeof project.brief.script === "string" ? project.brief.script : scriptLines(project.template, project.brief).join(" ");
  const [busy, setBusy] = useState<string | null>(null);

  const run = useCallback(async (key: string, p: Promise<unknown>) => {
    setBusy(key);
    try {
      await p;
    } catch (e) {
      toast({ title: "That didn't work", text: e instanceof Error ? e.message : String(e), tone: "bad" });
    } finally {
      setBusy(null);
    }
  }, []);

  const allFinals = clips.length > 0 && clips.every((c) => c.rung === "final");
  const draftsOnly = clips.length > 0 && clips.every((c) => c.rung !== "final");
  const seekShot = (shotId: string) => {
    const clip = clips.find((c) => c.shotId === shotId);
    if (clip) setTime(clip.start + 0.01);
  };

  // The player takes drops too: cards dropped on it go to the end of the timeline.
  const [stageDrop, setStageDrop] = useState(false);
  useEffect(() => {
    const clear = () => setStageDrop(false);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
    };
  }, []);
  const media = `/p/${project.id}/media`;

  return (
    <div className="ed">
      {/* A voice is often several pieces of one file, so each piece is keyed by where it starts. The mock's own songs and
          voices are stand-ins with nothing to play; the browser demo's recorded ones are real files. */}
      {timeline.audio.map((track) => ({ track, src: client.assetUrl(project.id, track.assetId) })).filter(({ src }) => !src.startsWith("mock:")).map(({ track, src }) => (
        <PreviewAudio key={`${track.assetId}@${track.start}`} src={src} time={time} start={track.start} playing={playing} gain={track.gain} trimIn={track.in ?? 0} trimOut={track.out} />
      ))}
      <MediaSidebar project={project} jobs={jobs} onSeekShot={seekShot} onAdd={(items) => void edits.place(items)} />
      <div className="ed__main">
        <div className="ed__top">
          <div className="ed__stage" ref={stageRef} tabIndex={-1}>
            <div
              className={cx("ed__preview", stageDrop && "ed__preview--drop")}
              onDragOver={(e) => {
                if (!isCanvasDrag(e)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
                if (!stageDrop) setStageDrop(true);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setStageDrop(false);
              }}
              onDrop={(e) => {
                const payload = readDrag(e);
                if (!payload) return;
                e.preventDefault();
                setStageDrop(false);
                void edits.place(payload.items);
              }}
            >
              {hasClips ? (
                <div className={cx("frame", frameClass(project.aspect))}>
                  {current && <Media key={`${current.assetId}-${current.start}`} src={current.src} kind={current.kind} playing={playing} loop={false} durationSec={current.dur} time={Math.max(0, time - current.start + current.in)} fit="cover" />}
                  {caption && <CaptionPreview caption={caption} time={time} look={captionLook} pos={captionPos} aspect={project.aspect} scale={style.captionSize ?? defaultCaptionSize(project.template)} template={project.template} />}
                </div>
              ) : (
                <div className={cx("frame", frameClass(project.aspect), "ed__blank")}>
                  <div className="ed__blank-body">
                    <Film className="ed__blank-icon" aria-hidden />
                    <div className="ed__blank-title">Nothing on the timeline yet.</div>
                    <div className="ed__blank-text">Drag cards here from the Media sidebar.</div>
                    <Link to={media} className="ed__blank-link">
                      Go to Media
                    </Link>
                  </div>
                </div>
              )}
            </div>
            <div className="ed__transport">
              <Button variant="quiet" iconOnly icon={<SkipBack />} aria-label="Back to start" disabled={!hasClips} onClick={() => setTime(0)} />
              <Button variant="quiet" iconOnly icon={playing ? <Pause /> : <Play />} aria-label={playing ? "Pause" : "Play"} disabled={!hasClips} onClick={() => setPlaying((p) => !p)} className="ed__play" />
              <span className="ed__time">
                {timecode(time)} <span className="ed__time-total">/ {timecode(total)}</span>
              </span>
              {current && <Tag tone={current.rung === "final" ? "night" : undefined}>{current.rung === "final" ? "Final" : current.rung === "draft" ? "Draft" : "Still"}</Tag>}
              <span className="ed__spacer" />
              {timeline.edited && <><Tag outline>Edited by hand</Tag><Button size="s" busy={busy === "recut"} onClick={() => void run("recut", updateProject(project.id, { timeline: { ...timeline, edited: false } }))}>Re-cut</Button></>}
              {draftsOnly && (
                <span className="t-small t-muted ed__note">
                  Previewing unfinished shots. Make finals in <Link to={media} className="ed__link">Media</Link> {upscale ? `to upscale them${upscale.to}.` : "for full quality."}
                </span>
              )}
              {hasClips && <span className="t-small t-muted ed__hint"><kbd className="kbd">Space</kbd> plays</span>}
            </div>
          </div>

          <aside className="ed__side inspector" aria-label="Inspector">
            <section className="insp">
              <div className="insp__head">
                <span className="insp__title">Captions</span>
                {/* The style is the timeline's, and there is none until a shot or a sound is on it. */}
                <fieldset className="insp__switch" disabled={!project.timeline}>
                  <Switch label="Show captions" checked={captionsOn} onChange={(v) => saveStyle({ captions: v })} />
                </fieldset>
              </div>
              {!project.timeline ? (
                <div className="insp__text">Captions appear once there is a voice. Write one on the Voice lane below. You can turn them off once there is a shot on the timeline.</div>
              ) : timeline.captions.length ? (
                <>
                  <div className="insp__text">{plural(timeline.captions.length, "line")} with word timings. The export result says how they were timed.</div>
                  <div className="insp__row">
                    <span>Style</span>
                    <Segmented
                      label="Caption style"
                      size="s"
                      value={captionLook}
                      onChange={(v) => saveStyle({ captionLook: v })}
                      options={[
                        { value: "clean", label: "Clean" },
                        { value: "boxed", label: "Boxed" },
                        { value: "serif", label: "Film" },
                        { value: "lyrics", label: "Lyrics" },
                      ]}
                    />
                  </div>
                  <div className="insp__row">
                    <span>Place</span>
                    <Segmented
                      label="Caption position"
                      size="s"
                      value={captionPos}
                      onChange={(v) => saveStyle({ captionPos: v })}
                      options={[
                        { value: "bottom", label: "Bottom" },
                        { value: "center", label: "Center" },
                      ]}
                    />
                  </div>
                </>
              ) : (
                <div className="insp__text">Captions appear once there is a voice. Write one on the Voice lane below.</div>
              )}
            </section>

            <section className="insp">
              <div className="insp__head">
                <span className="insp__title">Export</span>
                <Segmented
                  value={exportAspect}
                  onChange={setExportAspect}
                  label="Format"
                  size="s"
                  options={[
                    { value: "16:9", label: "16:9", icon: <RectangleHorizontal /> },
                    { value: "9:16", label: "9:16", icon: <RectangleVertical /> },
                    { value: "1:1", label: "1:1", icon: <Square /> },
                  ]}
                />
              </div>
              <div className="insp__row">
                <span>Framing</span>
                {hasDifferentShape ? <Select className="insp__framing" aria-label="Export framing" value={style.picture?.reframe ?? "crop"} onChange={(e) => saveStyle({ picture: { ...style.picture, reframe: e.target.value as "crop" | "fit_blur" } })}>
                  <option value="crop">Crop to fill</option>
                  <option value="fit_blur">Whole picture, blurred background</option>
                </Select> : <span>Crop to fill</span>}
              </div>
              <div className="insp__text">{!hasClips
                ? "Put shots on the timeline to export a video."
                : hasDifferentShape
                  ? "Keep the whole picture if cropping loses your subject. Nearly matching shots still fill the frame."
                  : "The shots match this format. Small differences are cropped to avoid blurred edges."}</div>
              {hasClips && !allFinals && <div className="insp__text">Some shots are stills or drafts. The export uses the best version of each shot.</div>}
              {exportJob && isActive(exportJob) ? (
                <div className="insp__result">
                  <div className="insp__status">
                    <span className="pulse" />
                    {jobStatusLine(exportJob, now)}
                  </div>
                  <div className="bar">
                    <div className="bar__fill" style={{ width: `${exportJob.progress * 100}%` }} />
                  </div>
                </div>
              ) : (
                <div className="insp__row">
                  <Button disabled={!hasClips || busy === "export"} busy={busy === "preview"} onClick={() => void run("preview", exportVideo(project.id, exportAspect, "preview"))}>Preview</Button>
                  <Button disabled={!hasClips || busy === "preview"} variant="primary" icon={<Download />} busy={busy === "export"} onClick={() => void run("export", exportVideo(project.id, exportAspect))}>
                    Export video
                  </Button>
                </div>
              )}
              {exportJob?.status === "failed" && (
                <Notice tone="bad" title="Export didn't finish">
                  {failureText(exportJob)}
                </Notice>
              )}
              {exportJob?.status === "done" && exportJob.message && <p className="insp__text" role="status">{exportJob.message}</p>}
              {exportAsset && (
                <div className="insp__file">
                  <div className={cx("frame", frameClass(aspectOf(exportAsset.width, exportAsset.height)))}>
                    <Media src={client.assetUrl(project.id, exportAsset.id)} kind="video" playing durationSec={exportAsset.durationSec} />
                  </div>
                  <div className="insp__file-text">
                    <div className="t-small insp__filename">
                      {project.name.replace(/[.\s]+$/, "")}.mp4
                    </div>
                    <div className="insp__text">
                      {exportedAspect ? `${exportedAspect}, ${exportAsset.width}x${exportAsset.height}, ` : ""}
                      {timecode(exportAsset.durationSec ?? total, false)}
                    </div>
                    <div className="insp__text">Exported {relativeTime(exportJob!.finishedAt ?? exportAsset.createdAt)}</div>
                  </div>
                  <Button
                    size="s"
                    className="insp__file-open"
                    onClick={() => {
                      const url = client.assetUrl(project.id, exportAsset.id);
                      if (window.nightshiftDesktop) {
                        void window.nightshiftDesktop.revealExport(project.id, exportAsset.id).catch((error) => toast({ title: "Couldn't show the export", text: error instanceof Error ? error.message : String(error), tone: "bad" }));
                      } else if (url.startsWith("mock:")) toast(noFileToast());
                      else window.open(url, "_blank");
                    }}
                  >
                    {window.nightshiftDesktop ? window.nightshiftDesktop.platform === "darwin" ? "Show in Finder" : "Show in folder" : "Open file"}
                  </Button>
                </div>
              )}
              {revealShot && (
                <div className="insp__reveal">
                  <div className="insp__row">
                    <span>Share reveal</span>
                    <Button size="s" icon={<Share2 />} onClick={() => setRevealOpen(true)}>
                      Share reveal
                    </Button>
                  </div>
                  <div className="insp__text">The draft, a freeze and the finished take on the same frame. 8 to 12 seconds, ready to post.</div>
                  <RevealSheet project={project} shot={revealShot} open={revealOpen} onClose={() => setRevealOpen(false)} />
                </div>
              )}
            </section>
          </aside>
        </div>

        <TimelineView project={project} clips={clips} total={total} time={time} onSeek={setTime} current={current} timeline={timeline} jobs={jobs} edits={edits} voiceText={voiceText} />
      </div>
    </div>
  );
}

function PreviewAudio({ src, time, start, playing, gain, trimIn, trimOut }: { src: string; time: number; start: number; playing: boolean; gain: number; trimIn: number; trimOut?: number }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const audio = ref.current;
    if (!audio) return;
    audio.volume = Math.min(1, Math.max(0, gain));
    if (time < start) {
      audio.pause();
      return;
    }
    if (time - start + trimIn >= (trimOut ?? audio.duration)) {
      audio.pause();
      return;
    }
    if (Math.abs(audio.currentTime - (time - start + trimIn)) > 0.2) audio.currentTime = time - start + trimIn;
    if (playing && audio.paused) void audio.play().catch(() => undefined);
    else if (!playing) audio.pause();
  }, [time, start, playing, gain, trimIn, trimOut]);
  return <audio ref={ref} src={src} preload="metadata" hidden />;
}

function aspectOf(w?: number, h?: number): Aspect {
  if (!w || !h) return "16:9";
  if (Math.abs(w / h - 1) < 0.05) return "1:1";
  return w > h ? "16:9" : "9:16";
}

