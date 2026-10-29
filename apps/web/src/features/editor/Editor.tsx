import type { Aspect, Caption, Project, Timeline } from "@nightshift/contract";
import { Download, Pause, Play, RectangleHorizontal, RectangleVertical, Scissors, Share2, SkipBack, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { useEngine, useProject, useProjectJobs } from "@/store/engine";
import { upscaleOnly, useInstalledTier } from "@/store/tier";
import { Button, Notice, Segmented, Select, Switch, Tag, Textarea, cx, toast } from "@/ui/primitives";
import { Media } from "@/media/Media";
import { assetById, failureText, frameClass, isActive, jobStatusLine } from "@/features/project/helpers";
import { useNow } from "@/lib/useNow";
import { isMock } from "@/api/config";
import { plural, relativeTime, roughDuration, timecode } from "@/lib/format";
import { genres, voices, scriptLines } from "@nightshift/contract";
import { RevealSheet } from "@/features/reveal/RevealSheet";
import { filmExportJobs, revealable } from "@/features/reveal/reveal";
import "./editor.css";
import { Filmstrip } from "./Filmstrip";

interface Clip {
  shotId: string;
  assetId: string;
  src: string;
  kind: "image" | "video";
  rung: "still" | "draft" | "final";
  in: number;
  start: number;
  dur: number;
  move: string;
}

type CaptionLook = "clean" | "boxed" | "serif";
type CaptionPos = "bottom" | "center";

export function Editor() {
  const { id } = useParams();
  const project = useProject(id)!;
  return <ProjectEditor key={project.id} project={project} />;
}

function ProjectEditor({ project }: { project: Project }) {
  const id = project.id;
  const jobs = useProjectJobs(id);
  const { audio, exportVideo, updateProject, client } = useEngine();
  const tier = useInstalledTier();
  const upscale = upscaleOnly(tier);

  const timeline: Timeline = project.timeline ?? { clips: [], audio: [], captions: [], style: {} };
  const clips = useMemo<Clip[]>(() => (project.timeline?.clips ?? []).flatMap((cut) => {
    const asset = assetById(project, cut.assetId);
    const shot = project.shots.find((s) => s.id === cut.shotId);
    if (!asset || !shot || (asset.kind !== "image" && asset.kind !== "video")) return [];
    const take = project.takes.find((t) => t.videoAssetId === asset.id);
    return [{ shotId: shot.id, assetId: asset.id, src: client.assetUrl(project.id, asset.id), kind: asset.kind,
      rung: take?.rung ?? "still", start: cut.start, dur: cut.out - cut.in, in: cut.in, move: shot.cameraMove ?? "static" }];
  }), [project, client]);
  const total = clips.reduce((end, c) => Math.max(end, c.start + c.dur), 0);
  const style = timeline.style as { captions?: boolean; captionLook?: CaptionLook; captionPos?: CaptionPos; captionSize?: number; picture?: Record<string, unknown> & { reframe?: "crop" | "fit_blur" } };
  const captionsOn = style.captions ?? true;
  const captionLook: CaptionLook = style.captionLook ?? defaultLook(project);
  const captionPos: CaptionPos = style.captionPos ?? "bottom";
  const styleSaves = useRef(Promise.resolve());
  const saveStyle = (patch: Partial<typeof style>) => {
    styleSaves.current = styleSaves.current.then(async () => {
      const current = await client.getProject(project.id);
      if (!current.timeline) return;
      await updateProject(project.id, { timeline: { ...current.timeline, style: { ...current.timeline.style, ...patch } } });
    }).catch((e) => toast({ title: "Couldn't save", text: String(e), tone: "bad" }));
  };

  // ------------------------------------------------------------ playback clock
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const hasClips = clips.length > 0;
  // Move focus out of the navigation control that opened the editor. Space should play immediately.
  useEffect(() => {
    if (hasClips) stageRef.current?.focus({ preventScroll: true });
  }, [id, hasClips]);
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.defaultPrevented || (t?.closest("input, textarea, select, button, a, [role=slider], [role=radio], dialog, [contenteditable=true]") && !t.closest(".tl, .toolbar"))) return;
      if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      }
      if (e.key === "Home") setTime(0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const current = clips.find((c) => time >= c.start && time < c.start + c.dur);
  const caption = captionsOn ? timeline.captions.find((c) => time >= c.start && time < c.end) : undefined;
  const musicTrack = timeline.audio.find((a) => a.role === "music");
  const voiceTrack = timeline.audio.find((a) => a.role === "voice");
  const musicJob = jobs.find((j) => j.step === "music" && isActive(j));
  const voiceJob = jobs.find((j) => j.step === "voice" && isActive(j));
  // The newest music or voice the GPU made (analysis jobs only measure one). If it failed, its section says why.
  const failedMaking = (step: "music" | "voice") => {
    const last = jobs.filter((j) => j.step === step && !j.analysis && j.status !== "cancelled").at(-1);
    return last?.status === "failed" ? last : undefined;
  };
  const musicFailed = failedMaking("music");
  const voiceFailed = failedMaking("voice");
  // Film exports only: a reveal is an export job that carries its shot, and has its own sheet.
  const exportJob = filmExportJobs(jobs).at(-1);
  const revealShot = project.shots.length === 1 && project.shots[0] && revealable(project, project.shots[0]) ? project.shots[0] : undefined;
  const [revealOpen, setRevealOpen] = useState(false);
  const now = useNow(1000, !!musicJob || !!voiceJob || (!!exportJob && isActive(exportJob)));
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
  const [musicPrompt, setMusicPrompt] = useState<string>(typeof project.brief.songPrompt === "string" ? project.brief.songPrompt : "");
  const [voiceText, setVoiceText] = useState<string>(project.template === "what_if"
    ? (voiceTrack && assetById(project, voiceTrack.assetId)?.text) ?? project.shots.map(shot => shot.line ?? "").join(" ")
    : typeof project.brief.script === "string" ? project.brief.script : scriptLines(project.template, project.brief).join(" "));
  const [voiceId, setVoiceId] = useState<string>(typeof project.brief.voice === "string" ? project.brief.voice : "mara");
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

  if (!clips.length) {
    return (
      <div className="page">
        <div className="empty">
          <Scissors className="empty__icon" />
          <div className="empty__title">Nothing to cut yet</div>
          <p className="empty__text">The editor lays your shots on a timeline with music, voice and captions. Make some stills first.</p>
          <Link to={`/p/${project.id}/storyboard`} className="btn btn--primary">
            Go to the storyboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="ed">
      {!isMock() && timeline.audio.map((track) => (
        <PreviewAudio key={track.assetId} src={client.assetUrl(project.id, track.assetId)} time={time} start={track.start} playing={playing} gain={track.gain} trimIn={track.in ?? 0} trimOut={track.out} />
      ))}
      <div className="ed__top">
        <div className="ed__stage" ref={stageRef} tabIndex={-1}>
          <div className="ed__preview">
            <div className={cx("frame", frameClass(project.aspect))}>
              {current && <Media key={`${current.assetId}-${current.start}`} src={current.src} kind={current.kind} playing={playing} loop={false} durationSec={current.dur} time={Math.max(0, time - current.start + current.in)} fit="cover" />}
              {caption && <CaptionOverlay caption={caption} time={time} look={captionLook} pos={captionPos} aspect={project.aspect} scale={style.captionSize ?? (project.template === "what_if" ? 1.6 : 1)} />}
            </div>
          </div>
          <div className="ed__transport">
            <Button variant="quiet" iconOnly icon={<SkipBack />} aria-label="Back to start" onClick={() => setTime(0)} />
            <Button variant="quiet" iconOnly icon={playing ? <Pause /> : <Play />} aria-label={playing ? "Pause" : "Play"} onClick={() => setPlaying((p) => !p)} className="ed__play" />
            <span className="ed__time">
              {timecode(time)} <span className="ed__time-total">/ {timecode(total)}</span>
            </span>
            {current && <Tag tone={current.rung === "final" ? "night" : undefined}>{current.rung === "final" ? "Final" : current.rung === "draft" ? "Draft" : "Still"}</Tag>}
            <span className="ed__spacer" />
            {timeline.edited && <><Tag outline>Edited by hand</Tag><Button size="s" busy={busy === "recut"} onClick={() => void run("recut", updateProject(project.id, { timeline: { ...timeline, edited: false } }))}>Re-cut</Button></>}
            {draftsOnly && (
              <span className="t-small t-muted ed__note">
                Previewing unfinished shots. <Link to={`/p/${project.id}/finals`} className="ed__link">Finish shots</Link> {upscale ? `to upscale them${upscale.to}.` : "for full quality."}
              </span>
            )}
            <span className="t-small t-muted ed__hint"><kbd className="kbd">Space</kbd> plays</span>
          </div>
        </div>

        <aside className="ed__side inspector" aria-label="Inspector">
          <section className="insp">
            <div className="insp__head">
              <span className="insp__title">Captions</span>
              <Switch label="Show captions" checked={captionsOn} onChange={(v) => saveStyle({ captions: v })} />
            </div>
            {timeline.captions.length ? (
              <>
                <div className="insp__text">{plural(timeline.captions.length, "line")} with word timings. The export result says how they were timed.</div>
                <div className="insp__row">
                  <span>Style</span>
                  <Segmented
                    label="Caption style"
                    value={captionLook}
                    onChange={(v) => saveStyle({ captionLook: v })}
                    options={[
                      { value: "clean", label: "Clean" },
                      { value: "boxed", label: "Boxed" },
                      { value: "serif", label: "Film" },
                    ]}
                  />
                </div>
                <div className="insp__row">
                  <span>Place</span>
                  <Segmented
                    label="Caption position"
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
              <div className="insp__text">Captions appear once there is a voice. Add one below.</div>
            )}
          </section>

          <section className="insp">
            <div className="insp__head">
              <span className="insp__title">Music</span>
              {musicTrack && <Tag tone="ok">On the timeline</Tag>}
            </div>
            {musicJob ? (
              <div className="insp__status">
                <span className="pulse" />
                {jobStatusLine(musicJob, now)}
              </div>
            ) : (
              <>
                {musicFailed && (
                  <Notice tone="bad" title="The music didn't finish">
                    {failureText(musicFailed)}
                  </Notice>
                )}
                <Textarea aria-label="Music prompt" value={musicPrompt} onChange={(e) => setMusicPrompt(e.target.value)} placeholder={project.template === "music_video" ? "The song for this video" : "Slow piano, warm, a little hopeful"} rows={2} />
                <div className="insp__row">
                  <span className="insp__text">{tier?.estimates?.music?.seconds ? `Takes ${roughDuration(tier.estimates.music.seconds)}` : ""}</span>
                  <Button size="s" variant={musicTrack ? "ghost" : "primary"} busy={busy === "music"} disabled={!musicPrompt.trim()} onClick={() => void run("music", updateProject(project.id, { brief: { ...project.brief, songPrompt: musicPrompt } }).then(() => audio(project.id, { role: "music", prompt: musicPrompt, durationSec: project.template === "music_video" && Number(project.brief.length) > 0 ? Number(project.brief.length) : total })))}>
                    {musicTrack ? "Make another" : "Make music"}
                  </Button>
                </div>
              </>
            )}
          </section>

          <section className="insp">
            <div className="insp__head">
              <span className="insp__title">Voice</span>
              {voiceTrack && <Tag tone="ok">On the timeline</Tag>}
            </div>
            {voiceJob ? (
              <div className="insp__status">
                <span className="pulse" />
                {jobStatusLine(voiceJob, now)}
              </div>
            ) : (
              <>
                {voiceFailed && (
                  <Notice tone="bad" title="The voice didn't finish">
                    {failureText(voiceFailed)}
                  </Notice>
                )}
                <Textarea aria-label="Voice script" value={voiceText} onChange={(e) => setVoiceText(e.target.value)} placeholder="What the voice says. Each sentence becomes a caption." rows={3} />
                <div className="insp__row">
                  <Select value={voiceId} onChange={(e) => setVoiceId(e.target.value)} aria-label="Voice" className="insp__voice">
                    {voices.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}, {v.hint.toLowerCase()}
                      </option>
                    ))}
                  </Select>
                  <Button size="s" variant={voiceTrack ? "ghost" : "primary"} busy={busy === "voice"} disabled={!voiceText.trim()} onClick={() => void run("voice", updateProject(project.id, { brief: { ...project.brief, script: voiceText, voice: voiceId } }).then(() => audio(project.id, { role: "voice", text: voiceText, voice: voiceId })))}>
                    {voiceTrack ? "Speak again" : "Make voice"}
                  </Button>
                </div>
              </>
            )}
          </section>

          <section className="insp insp__export">
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
            <div className="insp__text">{hasDifferentShape
              ? "Keep the whole picture if cropping loses your subject. Nearly matching shots still fill the frame."
              : "The shots match this format. Small differences are cropped to avoid blurred edges."}</div>
            {!allFinals && <div className="insp__text">Some shots are stills or drafts. The export uses the best version of each shot.</div>}
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
              <Button disabled={busy === "export"} busy={busy === "preview"} onClick={() => void run("preview", exportVideo(project.id, exportAspect, "preview"))}>Preview</Button>
              <Button disabled={busy === "preview"} variant="primary" icon={<Download />} busy={busy === "export"} onClick={() => void run("export", exportVideo(project.id, exportAspect))}>
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
                    if (window.nightshiftDesktop) {
                      void window.nightshiftDesktop.revealExport(project.id, exportAsset.id).catch((error) => toast({ title: "Couldn't show the export", text: error instanceof Error ? error.message : String(error), tone: "bad" }));
                    } else if (isMock()) toast({ title: "This is the mock engine", text: "Nothing was written to disk. The real engine saves to your Nightshift folder.", tone: "accent" });
                    else window.open(client.assetUrl(project.id, exportAsset.id), "_blank");
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

      <TimelineView project={project} clips={clips} total={total} time={time} onSeek={setTime} current={current} timeline={timeline} />
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

function defaultLook(p: Project): CaptionLook {
  return p.template === "cinematic_shot" || p.template === "music_video" ? "serif" : p.template === "product_ad" ? "boxed" : "clean";
}

function CaptionOverlay({ caption, time, look, pos, aspect, scale }: { caption: Caption; time: number; look: CaptionLook; pos: CaptionPos; aspect: Aspect; scale: number }) {
  const size = aspect === "9:16" ? "4.6cqw" : aspect === "1:1" ? "4cqw" : "3.2cqw";
  return (
    <div className={cx("cap", `cap--${pos}`)} style={{ containerType: "inline-size" } as React.CSSProperties}>
      <span className={cx("cap__text", look === "boxed" && "cap__text--boxed", look === "serif" && "cap__text--serif")} style={{ "--cap-size": `calc(${size} * ${scale})` } as React.CSSProperties}>
        {caption.words?.length
          ? caption.words.map((w, i) => (
              <span key={i} className={cx("cap__word", time >= w.start && "cap__word--on", look !== "serif" && "cap__word--lamp")}>
                {w.text}{" "}
              </span>
            ))
          : caption.text}
      </span>
    </div>
  );
}

function TimelineView({ project, clips, total, time, onSeek, current, timeline }: { project: Project; clips: Clip[]; total: number; time: number; onSeek: (t: number) => void; current: Clip | undefined; timeline: Timeline }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pxPerSec = Math.max(28, (width - 24) / Math.max(total, 1));
  const innerW = Math.max(width, total * pxPerSec + 24);
  const x = (t: number) => 12 + t * pxPerSec;
  const ticks: number[] = [];
  const stepSec = total > 40 ? 5 : total > 15 ? 2 : 1;
  for (let t = 0; t <= total; t += stepSec) ticks.push(t);
  // The last label aligns leftward at the edge. Leave it room beside the previous label.
  if (ticks.length > 2 && x(ticks.at(-1)!) > innerW - 40 && (ticks.at(-1)! - ticks.at(-2)!) * pxPerSec < 64) ticks.splice(-2, 1);

  const seekFromEvent = (e: React.MouseEvent) => {
    const rect = scrollRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left + scrollRef.current!.scrollLeft - 12;
    onSeek(Math.max(0, Math.min(total, px / pxPerSec)));
  };

  // A paced voiceover is one entry per sentence (the same file, trimmed); each is drawn at its own start.
  const entries = (role: "music" | "voice") =>
    timeline.audio
      .filter((a) => a.role === role)
      .flatMap((a) => {
        const asset = assetById(project, a.assetId);
        if (!asset) return [];
        const length = Math.max(0, Math.min((a.out ?? asset.durationSec ?? total) - (a.in ?? 0), total - a.start));
        return length > 0 ? [{ start: a.start, length, key: `${a.assetId}-${a.start}` }] : [];
      });
  const music = entries("music");
  const voice = entries("voice");
  const clipClass = project.aspect === "9:16" ? "tl__clip--tall" : project.aspect === "1:1" ? "tl__clip--sq" : "";

  return (
    <div className="tl">
      <div className="tl__labels">
        <div className="tl__label" />
        <div className="tl__label">Shots</div>
        <div className="tl__label">Music</div>
        <div className="tl__label">Voice</div>
        <div className="tl__label">Captions</div>
      </div>
      <div className="tl__scroll" ref={scrollRef}>
        <div className="tl__inner" style={{ width: innerW }}>
          <div className="tl__ruler" role="slider" tabIndex={0} aria-label="Playhead" aria-valuemin={0} aria-valuemax={total} aria-valuenow={Math.round(time * 10) / 10} aria-valuetext={timecode(time)} onKeyDown={(e) => {
            const next = e.key === "ArrowRight" ? time + 0.5 : e.key === "ArrowLeft" ? time - 0.5 : e.key === "Home" ? 0 : e.key === "End" ? total : undefined;
            if (next === undefined) return;
            e.preventDefault();
            onSeek(Math.max(0, Math.min(total, next)));
          }} onMouseDown={seekFromEvent}>
            {ticks.map((t) => (
              <span key={t} className={cx("tl__tick", x(t) > innerW - 40 && "tl__tick--end")} style={{ left: x(t) }}>
                <span>{timecode(t, false)}</span>
              </span>
            ))}
          </div>
          <div className="tl__track" onMouseDown={seekFromEvent}>
            {clips.map((c, i) => (
              <button
                type="button"
                key={`${c.shotId}-${i}`}
                aria-label={`Seek to shot ${i + 1}`}
                onClick={(e) => { if (e.detail === 0) onSeek(c.start + 0.01); }}
                className={cx("tl__clip", clipClass, current === c && "tl__clip--on")}
                style={{ left: x(c.start), width: Math.max(8, c.dur * pxPerSec - 3) }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  seekFromEvent(e);
                }}
                title={`Shot ${i + 1}, ${Math.round(c.dur * 100) / 100} s`}
              >
                <Filmstrip src={c.src} kind={c.kind} start={c.in} duration={c.dur}
                  ratio={project.aspect === "9:16" ? 9 / 16 : project.aspect === "1:1" ? 1 : 16 / 9}
                  count={Math.max(1, Math.ceil(c.dur * pxPerSec / (60 * (project.aspect === "9:16" ? 9 / 16 : project.aspect === "1:1" ? 1 : 16 / 9))))} />
                <span className={cx("tl__clip-label", c.rung === "final" && "tl__clip-label--final")}>{i + 1}</span>
              </button>
            ))}
          </div>
          <div className="tl__track" onMouseDown={seekFromEvent}>
            {music.length ? (
              music.map((m, i) => (
                <div key={m.key} className="tl__audio" style={{ left: x(m.start), width: Math.max(4, m.length * pxPerSec - 2) }}>
                  <Wave seed={3 + i} n={Math.floor((m.length * pxPerSec) / 3)} />
                </div>
              ))
            ) : (
              <div className="tl__empty">No music yet</div>
            )}
          </div>
          <div className="tl__track" onMouseDown={seekFromEvent}>
            {voice.length ? (
              voice.map((v, i) => (
                <div key={v.key} className="tl__audio tl__audio--voice" style={{ left: x(v.start), width: Math.max(4, v.length * pxPerSec - 2) }}>
                  <Wave seed={9 + i} n={Math.floor((v.length * pxPerSec) / 3)} speech />
                </div>
              ))
            ) : (
              <div className="tl__empty">No voice yet</div>
            )}
          </div>
          <div className="tl__track" onMouseDown={seekFromEvent}>
            {timeline.captions.length ? (
              timeline.captions.map((c, i) => (
                <div
                  key={i}
                  className={cx("tl__caption", x(c.start) > innerW / 2 && "tl__caption--end")}
                  style={{ left: x(c.start), "--cap-w": `${Math.max(6, (c.end - c.start) * pxPerSec - 2)}px` } as React.CSSProperties}
                >
                  {/* Its own box, so a line longer than the chip ends in an ellipsis. Hovering the chip shows all of it. */}
                  <span className="tl__caption-text">{c.text}</span>
                </div>
              ))
            ) : (
              <div className="tl__empty">Captions follow the voice</div>
            )}
          </div>
          <div className="tl__head" style={{ left: x(time) }} />
        </div>
      </div>
    </div>
  );
}

function Wave({ seed, n, speech }: { seed: number; n: number; speech?: boolean }) {
  const bars = useMemo(() => {
    let a = seed * 7919 + 13;
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      a = (a * 1103515245 + 12345) & 0x7fffffff;
      const r = (a % 1000) / 1000;
      const env = speech ? (Math.sin(i / 6) > -0.3 ? 1 : 0.15) : 0.6 + 0.4 * Math.sin(i / 11);
      out.push(0.15 + r * 0.85 * env);
    }
    return out;
  }, [seed, n, speech]);
  return (
    <div className="tl__wave" aria-hidden>
      {bars.map((h, i) => (
        <i key={i} style={{ height: `${h * 100}%` }} />
      ))}
    </div>
  );
}
