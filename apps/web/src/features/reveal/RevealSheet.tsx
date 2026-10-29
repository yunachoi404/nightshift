import type { Aspect, Project, Shot } from "@nightshift/contract";
import { Play, RectangleHorizontal, RectangleVertical, Share2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useEngine, useProjectJobs } from "@/store/engine";
import { Button, Dialog, Notice, Segmented, Tag, cx, toast } from "@/ui/primitives";
import { Media } from "@/media/Media";
import { assetById, failureText, frameClass, isActive, jobStatusLine } from "@/features/project/helpers";
import { useNow } from "@/lib/useNow";
import { isMock } from "@/api/config";
import { relativeTime, timecode } from "@/lib/format";
import { revealJobs, revealable, sourceLabel } from "./reveal";
import "./reveal.css";

type RevealAspect = Extract<Aspect, "9:16" | "16:9">;

/**
 * The "Share reveal" sheet: makes an 8 to 12 second clip of one shot that shows the photo, the draft, and the
 * same-take final at the same frame. One shape at a time; the last clip of each shape stays listed here.
 */
export function RevealSheet({ project, shot, open, onClose }: { project: Project; shot: Shot; open: boolean; onClose: () => void }) {
  const { exportVideo, cancelJob, client } = useEngine();
  const jobs = revealJobs(useProjectJobs(project.id), shot.id);
  const pair = revealable(project, shot);
  const [aspect, setAspect] = useState<RevealAspect>("9:16");
  const [busy, setBusy] = useState(false);
  const running = jobs.find(isActive);
  const now = useNow(1000, Boolean(running));
  const last = jobs.at(-1);
  const failed = last?.status === "failed" ? last : undefined;
  const clips = jobs
    .filter((j) => j.status === "done")
    .flatMap((j) => {
      const asset = assetById(project, j.outputAssetIds[0]);
      return asset?.width && asset.height ? [{ job: j, asset, aspect: (asset.width > asset.height ? "16:9" : "9:16") as RevealAspect }] : [];
    });
  const latest = clips.at(-1);
  // The shape control follows the clip just made, so the choice and the result below it agree.
  useEffect(() => {
    if (latest) setAspect(latest.aspect);
  }, [latest?.asset.id]);

  const make = async () => {
    setBusy(true);
    try {
      await exportVideo(project.id, aspect, "standard", { kind: "reveal", shotId: shot.id });
    } catch (e) {
      toast({ title: "Couldn't start the reveal", text: e instanceof Error ? e.message : String(e), tone: "bad" });
    } finally {
      setBusy(false);
    }
  };
  const openFile = (assetId: string) => {
    if (window.nightshiftDesktop) {
      void window.nightshiftDesktop.revealExport(project.id, assetId).catch((error) => toast({ title: "Couldn't show the clip", text: error instanceof Error ? error.message : String(error), tone: "bad" }));
    } else if (isMock()) toast({ title: "This is the mock engine", text: "Nothing was written to disk. The real engine saves to your Nightshift folder.", tone: "accent" });
    else window.open(client.assetUrl(project.id, assetId), "_blank");
  };
  const shotNo = [...project.shots].sort((a, b) => a.index - b.index).findIndex((s) => s.id === shot.id) + 1;
  const size = (a: { width?: number; height?: number }) => (a.width && a.height ? `${a.width}×${a.height}` : "");

  return (
    <Dialog open={open} onClose={onClose} width={520} className="rv-dialog">
      <div className="rv">
        <div className="rv__head">
          <span className="rv__icon" aria-hidden>
            <Share2 />
          </span>
          <div>
            <h2 className="dialog__title">Share reveal</h2>
            <p className="dialog__text">A short clip that shows the draft and its finished take side by side, on the same frame. Long takes play the moments around that frame. The sound is the take's own. Post it as it is.</p>
          </div>
        </div>

        {pair ? (
          <>
            <div className="rv__strip" aria-label="What the clip shows">
              <RevealStep label={sourceLabel(pair, shotNo)} src={pair.source ? client.assetUrl(project.id, pair.source.id) : client.assetUrl(project.id, pair.draftAsset.id)} kind={pair.source ? "image" : "video"} />
              <span className="rv__arrow" aria-hidden />
              <RevealStep label="Draft" meta={size(pair.draftAsset)} src={client.assetUrl(project.id, pair.draftAsset.id)} kind="video" />
              <span className="rv__arrow" aria-hidden />
              <RevealStep label="Same take, finished" meta={size(pair.finalAsset)} src={client.assetUrl(project.id, pair.finalAsset.id)} kind="video" tone="night" />
            </div>

            <div className="rv__row">
              <span className="rv__k">Shape</span>
              <Segmented
                value={aspect}
                onChange={setAspect}
                label="Shape"
                size="s"
                options={[
                  { value: "9:16", label: "Vertical", icon: <RectangleVertical /> },
                  { value: "16:9", label: "Wide", icon: <RectangleHorizontal /> },
                ]}
              />
            </div>
            <p className="rv__hint">{aspect === "9:16" ? "1080×1920 for Reels, Shorts and TikTok." : "1920×1080 for X, LinkedIn and the web."}</p>

            {running ? (
              <div className="rv__status" role="status">
                <div className="insp__status">
                  <span className="pulse" />
                  {jobStatusLine(running, now)}
                </div>
                <div className="bar">
                  <div className="bar__fill" style={{ width: `${running.progress * 100}%` }} />
                </div>
                <div>
                  <Button size="s" variant="quiet" onClick={() => void cancelJob(running.id)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
            {failed && !running && (
              <Notice tone="bad" title="The reveal didn't finish">
                {failureText(failed)}
              </Notice>
            )}

            {clips.length > 0 && (
              <div className="rv__clips">
                {clips.slice(-2).reverse().map(({ job, asset, aspect: a }) => (
                  <div className="rv__clip" key={asset.id}>
                    <div className={cx("frame", frameClass(a))}>
                      <Media src={client.assetUrl(project.id, asset.id)} kind="video" playing durationSec={asset.durationSec} />
                    </div>
                    <div className="rv__clip-text">
                      <div className="t-small rv__clip-name">
                        <Tag tone="ok">Ready</Tag>
                        {a === "9:16" ? "Vertical" : "Wide"}, {size(asset)}
                      </div>
                      <div className="insp__text">
                        {timecode(asset.durationSec ?? 0, false)}, made {relativeTime(job.finishedAt ?? asset.createdAt)}
                      </div>
                      {job.message && <div className="insp__text rv__clip-note">{job.message}</div>}
                    </div>
                    <Button size="s" icon={<Play />} onClick={() => openFile(asset.id)}>
                      {window.nightshiftDesktop ? (window.nightshiftDesktop.platform === "darwin" ? "Show in Finder" : "Show in folder") : "Open"}
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="dialog__actions">
              <Button onClick={onClose}>{clips.length ? "Done" : "Not now"}</Button>
              <Button variant="primary" icon={<Share2 />} busy={busy} disabled={Boolean(running)} autoFocus onClick={() => void make()}>
                {clips.some((c) => c.aspect === aspect) ? "Make again" : "Make clip"}
              </Button>
            </div>
          </>
        ) : (
          <>
            <Notice tone="night" title="Nothing to reveal yet">
              A reveal needs a same-take final. Finish the shot with Same take first. A remaster re-renders the take, so it cannot be shown as the same one.
            </Notice>
            <div className="dialog__actions">
              <Button onClick={onClose}>Close</Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

function RevealStep({ label, meta, src, kind, tone }: { label: string; meta?: string; src: string; kind: "image" | "video"; tone?: "night" }) {
  return (
    <div className="rv__step">
      <div className="frame frame--16x9 rv__step-frame">
        <Media src={src} kind={kind} />
      </div>
      <div className={cx("rv__step-label", tone && `rv__step-label--${tone}`)}>{label}</div>
      {meta && <div className="rv__step-meta t-num">{meta}</div>}
    </div>
  );
}
