/**
 * A shot card, opened. On the left the selected version large, what it is and its prompt under it, and every version
 * in a row below (oldest first, the pick marked). On the right the card's edits: its prompt, a new version, the final,
 * and the timeline. Each new version (a redrawn or edited still, another take, an effect, a camera move) becomes the
 * pick when it lands; Restore makes an older one the pick again. The arrow keys move through the versions, Enter
 * restores the selected one, and Escape closes an open tool first, then the card.
 */
import { cameraMoves, quickEffects, quickMoves, sentenceCase, type FinalKind, type Shot } from "@nightshift/contract";
import { Check, ChevronDown, Clapperboard, ListMinus, ListPlus, Moon, Move3d, Pause, Play, RefreshCw, RotateCcw, Share2, Sparkles, SquarePen, Sun, Trash2, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router";
import { useEngine, useEngineState } from "@/store/engine";
import { upscaleOnly, useInstalledTier } from "@/store/tier";
import { Button, Dialog, Input, Notice, Select, Tag, Textarea, cx, toast } from "@/ui/primitives";
import { Media } from "@/media/Media";
import { activeJob, failureText, frameClass, jobStatusLine, lastFailed } from "@/features/project/helpers";
import { useNow } from "@/lib/useNow";
import { clock, plural, relativeTime, roughDuration } from "@/lib/format";
import { EffectPicker } from "@/features/newproject/EffectFields";
import { CameraMovePicker, cameraPhotoHint } from "@/features/newproject/CameraMoveFields";
import { RevealSheet } from "@/features/reveal/RevealSheet";
import { revealable } from "@/features/reveal/reveal";
import { useMedia } from "./context";
import { ownsArrowKeys, versionKey } from "./dialogKeys";
import { CARD_STEPS, FINAL_STEPS, TAKE_STEPS, canRestore, placeOnTimeline, restingTime, restore, shotHistory, shotLabel, shotPatch, takeOffTimeline, versionLabel, withoutCard, type Version } from "./items";
import { toolBlocked } from "./PromptPanel";
import "./carddialog.css";

export function CardDialog({ shotId, onClose }: { shotId: string | null; onClose: () => void }) {
  const { project } = useMedia();
  const shot = shotId ? project.shots.find((s) => s.id === shotId) : undefined;
  // A card deleted elsewhere closes its popup.
  useEffect(() => {
    if (shotId && !shot) onClose();
  }, [shotId, shot, onClose]);
  return (
    <Dialog open={!!shot} onClose={onClose} width={1120} className="cd">
      {shot && <CardBody key={shot.id} shot={shot} onClose={onClose} />}
    </Dialog>
  );
}

/** The one tool or question open at a time. Escape closes it and returns to the button that opened it. */
type Open = "edit" | "effect" | "camera" | "tonight" | "delete" | null;

function CardBody({ shot, onClose }: { shot: Shot; onClose: () => void }) {
  const { project, jobs, edit } = useMedia();
  const { client, still, draft, final, cancelJob, updateSettings } = useEngine();
  const { settings } = useEngineState();
  const tier = useInstalledTier();
  const history = useMemo(() => shotHistory(project, shot), [project, shot]);
  const pick = history.find((v) => v.pick);
  const [selectedKey, setSelectedKey] = useState(pick?.key);
  // A version that lands becomes the pick: show it.
  useEffect(() => setSelectedKey(pick?.key), [pick?.key]);
  const selected = history.find((v) => v.key === selectedKey) ?? pick;
  const selectedIndex = selected ? history.indexOf(selected) : -1;
  const label = shotLabel(project, shot, history);
  const whatIf = project.template === "what_if";
  const quick = project.template === "vfx_effect" || project.template === "camera_move";
  const onTimeline = shot.onTimeline !== false;
  const aspect = frameClass(shot.aspect ?? project.aspect);
  const promptId = useId();

  const job = activeJob(jobs, shot.id, CARD_STEPS);
  const drawing = activeJob(jobs, shot.id, ["still"]);
  const taking = activeJob(jobs, shot.id, TAKE_STEPS);
  const finishing = activeJob(jobs, shot.id, FINAL_STEPS);
  const failed = job ? undefined : lastFailed(jobs, shot.id, CARD_STEPS);
  const now = useNow(1000, job?.status === "running");

  const [prompt, setPrompt] = useState(shot.prompt);
  useEffect(() => setPrompt(shot.prompt), [shot.prompt]);
  const [open, setOpen] = useState<Open>(null);
  const toggles = useRef<Partial<Record<NonNullable<Open>, HTMLButtonElement | null>>>({});
  const toggle = (what: NonNullable<Open>) => setOpen(open === what ? null : what);
  // The pickers start on the pick's own effect or move, when it is one of theirs.
  const pickTool = pick?.tool;
  const [effect, setEffect] = useState(pickTool?.kind === "effect" && quickEffects.some((e) => e.id === pickTool.effect) ? pickTool.effect : quickEffects[0]!.id);
  const [subject, setSubject] = useState("");
  // A card made from an image has no words: the effect asks what should change. Otherwise it follows the shot's prompt,
  // which it never rewrites.
  const askSubject = !shot.prompt.trim() && !shot.locked;
  const [path, setPath] = useState(pickTool?.kind === "camera_move" && quickMoves.some((m) => m.id === pickTool.move) ? pickTool.move : quickMoves[0]!.id);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [revealOpen, setRevealOpen] = useState(false);
  // A clip loops in the large preview, unless the system asks for less motion. Either way it can be paused or played.
  const [paused, setPaused] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  const tiles = useRef(new Map<string, HTMLButtonElement>());
  const strip = useRef<HTMLDivElement>(null);

  const run = async (what: string, action: () => Promise<unknown>) => {
    setBusy(what);
    try {
      await action();
    } catch (e) {
      toast({ title: "That didn't work", text: e instanceof Error ? e.message : String(e), tone: "bad" });
    } finally {
      setBusy(null);
    }
  };
  const change = (patch: Partial<Shot>) => edit((p) => shotPatch(p, shot.id, patch));
  const savePrompt = async () => {
    if (prompt !== shot.prompt) await change({ prompt });
  };
  const restoreSelected = () => {
    if (!selected || !canRestore(shot, selected)) return;
    const version = selected;
    void run("restore", () => edit((p) => shotPatch(p, shot.id, (s) => restore(s, version))));
  };

  // Finals: same take where the setup has it, else a remaster.
  const finalKind: FinalKind | null = !tier?.steps || tier.steps.includes("video_final_same_take") ? "same_take" : tier.steps.includes("video_final_remaster") ? "remaster" : null;
  const finalStep = finalKind === "remaster" ? "video_final_remaster" : "video_final_same_take";
  const finalSec = (tier?.estimates?.[finalStep]?.seconds ?? 0) * (whatIf ? 15 / 4 : 1);
  const upscale = upscaleOnly(tier);
  const canFinish = pick?.rung === "draft" && shot.chosenDraftId === pick.take?.id && !!finalKind;
  const startAt = settings?.overnight.startAt ?? "23:00";
  const overnightOn = settings?.overnight.enabled ?? true;
  const reveal = revealable(project, shot);

  const finish = (mode: "now" | "overnight") =>
    run(mode, async () => {
      if (!shot.chosenDraftId || !finalKind) return;
      if (mode === "overnight") {
        const latest = await client.settings();
        await updateSettings({ overnight: { ...latest.overnight, enabled: true } });
      }
      await final(project.id, shot.id, { draftId: shot.chosenDraftId, kind: finalKind, mode });
      setOpen(null);
      if (mode === "now") toast({ title: "Finishing the shot", text: finalSec ? `${sentenceCase(roughDuration(finalSec))}. You can keep working.` : "You can keep working.", tone: "accent" });
      else toast({ title: "Final queued for tonight", text: `Starts at ${clock(startAt)}.`, tone: "night" });
    });

  const takeLabel = history.some((v) => v.take) ? "Another take" : whatIf ? "Make the film" : "Make video";
  const takeReady = whatIf ? !!shot.keyframes?.every((k) => k.stillAssetId) : !!shot.stillAssetId;
  const imageBlocked = toolBlocked(tier, "image");
  const videoBlocked = toolBlocked(tier, "video");
  const effectBlocked = toolBlocked(tier, "effect");
  const cameraBlocked = toolBlocked(tier, "camera_move");

  // Edit image: the recipe's image edit step redraws the still as an edit of the still on show (else the card's still),
  // following a short instruction. Quick shots and What if? films keep their own flow and have no edit.
  const canEdit = !quick && !whatIf && !!tier?.steps?.includes("effect_end_frame");
  const editFrom = selected?.rung === "still" ? selected.asset.id : shot.stillAssetId;
  const editBlocked = shot.locked ? "This shot is locked." : !editFrom ? "Draw the still first." : drawing ? "Wait for the still on its way." : undefined;
  const editSec = tier?.estimates?.effect_end_frame?.seconds;
  const editModel = tier?.models?.effect_end_frame;
  const editCost = editSec && editModel ? `${sentenceCase(roughDuration(editSec))} with ${editModel}.` : editSec ? `${sentenceCase(roughDuration(editSec))}.` : editModel ? `Made with ${editModel}.` : "";
  const makeEdit = () => {
    const words = instruction.trim();
    if (!words || !editFrom || editBlocked) return;
    void run("edit", async () => {
      await still(project.id, shot.id, { prompt: words, editFrom });
      setInstruction("");
      setOpen(null);
    });
  };

  const select = (index: number) => {
    const version = history[index];
    if (!version) return;
    setSelectedKey(version.key);
    tiles.current.get(version.key)?.focus();
  };

  // Escape closes the open tool before the card. In the row of versions the arrows, Home and End move and Enter
  // restores; elsewhere Left and Right move, unless the control in focus uses them itself.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // The reveal sheet is a dialog of its own, inside this one: its keys are its own.
    if (revealOpen || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.key === "Escape") {
      if (!open) return;
      e.preventDefault();
      const opener = toggles.current[open];
      setOpen(null);
      opener?.focus();
      return;
    }
    const target = e.target as HTMLElement;
    const inStrip = !!strip.current?.contains(target);
    if (!inStrip && (ownsArrowKeys(target) || (e.key !== "ArrowLeft" && e.key !== "ArrowRight"))) return;
    const action = versionKey(e.key, selectedIndex, history.length);
    if (!action) return;
    if (action === "restore") {
      if (selected && canRestore(shot, selected)) {
        e.preventDefault();
        restoreSelected();
      }
      return;
    }
    e.preventDefault();
    select(action.select);
  };

  const status = job ? (
    <>
      <span className={cx("pulse", job.mode === "overnight" && "pulse--night")} aria-hidden />
      <span className="cd-status__text">{jobStatusLine(job, now)}</span>
      {job === finishing && (
        <Button size="s" variant="quiet" onClick={() => void cancelJob(job.id).catch(() => undefined)}>
          Cancel
        </Button>
      )}
    </>
  ) : (
    <span className="cd-status__text">
      {onTimeline ? "On the timeline" : "On the board only"}, {shot.durationSec} s, {plural(history.length, "version")}
    </span>
  );

  return (
    <div className="cd-grid" onKeyDown={onKeyDown}>
      <div className="cd-view">
        <div className="cd-stage">
          <div className={cx("frame cd-stage__frame", aspect, !selected && "frame--empty")}>
            {selected && (
              <Media
                key={selected.key}
                src={client.assetUrl(project.id, selected.asset.id)}
                kind={selected.rung === "still" ? "image" : "video"}
                playing={!paused}
                durationSec={shot.durationSec}
                fit="contain"
              />
            )}
            {!selected && (
              <div className="cd-stage__empty">
                {drawing ? (
                  <>
                    <span className="pulse" aria-hidden />
                    <span>{jobStatusLine(drawing, now)}</span>
                  </>
                ) : (
                  <span>No still yet</span>
                )}
              </div>
            )}
            {selected && selected.rung !== "still" && (
              <button type="button" className="cd-stage__play" aria-label={paused ? "Play" : "Pause"} title={paused ? "Play" : "Pause"} onClick={() => setPaused(!paused)}>
                {paused ? <Play /> : <Pause />}
              </button>
            )}
          </div>
        </div>

        {selected && (
          <div className="cd-caption">
            <div className="cd-caption__text">
              <div className="cd-caption__line">
                <span className="cd-caption__kind">{versionLabel(project, shot, selected)}</span>
                {selected.pick && <PickTag />}
                <span className="cd-caption__time">{relativeTime(selected.createdAt)}</span>
              </div>
              {selected.prompt && (
                <p className="cd-caption__prompt" title={selected.prompt}>
                  {selected.prompt}
                </p>
              )}
            </div>
            {canRestore(shot, selected) ? (
              <Button size="s" icon={<RotateCcw />} busy={busy === "restore"} title="Make this version the pick" onClick={restoreSelected}>
                Restore
              </Button>
            ) : (
              !selected.pick && <span className="cd-caption__note">Shown as its final</span>
            )}
          </div>
        )}

        {(history.length > 0 || job) && (
          <div className="cd-strip" role="list" aria-label="Versions" ref={strip}>
            {history.map((v, i) => (
              <VersionTile
                key={v.key}
                n={i + 1}
                version={v}
                aspect={aspect}
                label={versionLabel(project, shot, v)}
                selected={v.key === selected?.key}
                onSelect={() => setSelectedKey(v.key)}
                tileRef={(el) => {
                  if (el) tiles.current.set(v.key, el);
                  else tiles.current.delete(v.key);
                }}
              />
            ))}
            {job && (
              <div className="cd-ver cd-ver--working" role="listitem">
                <div className={cx("frame shimmer cd-ver__frame", aspect)}>
                  <div className={cx("cd-ver__progress", job.mode === "overnight" && "cd-ver__progress--night")}>
                    <div style={{ width: `${job.progress * 100}%` }} />
                  </div>
                </div>
                <div className="cd-ver__kind">{job.step === "still" ? "Still" : FINAL_STEPS.includes(job.step as never) ? "Final" : "Take"}</div>
                <div className="cd-ver__time">{jobStatusLine(job, now)}</div>
              </div>
            )}
          </div>
        )}
      </div>

      <aside className="cd-side" aria-label="Card">
        <header className="cd-head">
          <div className="cd-head__text">
            <h2 className="cd-title" title={label}>
              {label}
            </h2>
            <div className="cd-status">{status}</div>
          </div>
          <Button variant="quiet" size="s" iconOnly icon={<X />} aria-label="Close" className="cd-close" onClick={onClose} />
        </header>

        <div className="cd-body">
          {failed && (
            <Notice tone="bad" title="The last try didn't work">
              {failureText(failed)}
            </Notice>
          )}

          {whatIf ? (
            <Section title="Story">
              <p className="cd-text">The film follows its four beats. Change the words or redraw a beat in the story.</p>
              <div>
                <Link to={`/p/${project.id}/storyboard`} className="btn btn--s">
                  Edit the story
                </Link>
              </div>
            </Section>
          ) : (
            <section className="cd-sec">
              <label className="cd-sec__title" htmlFor={promptId}>
                Prompt
              </label>
              <Textarea id={promptId} className="cd-prompt" rows={4} value={prompt} disabled={shot.locked} onChange={(e) => setPrompt(e.target.value)} placeholder="What's in this shot" />
              <div className="cd-row">
                {/* A quick shot's still is its photo: there is nothing to draw. */}
                {!quick && (
                  <Button
                    size="s"
                    icon={<RefreshCw />}
                    disabled={!prompt.trim() || !!drawing || !!imageBlocked || shot.locked}
                    busy={busy === "still"}
                    title={imageBlocked}
                    onClick={() =>
                      void run("still", async () => {
                        await savePrompt();
                        await still(project.id, shot.id, { prompt });
                      })
                    }
                  >
                    {shot.stillAssetId ? "Redraw still" : "Draw the still"}
                  </Button>
                )}
                {canEdit && (
                  <Button
                    ref={(el) => {
                      toggles.current.edit = el;
                    }}
                    size="s"
                    icon={<SquarePen />}
                    className="cd-toggle"
                    aria-expanded={open === "edit"}
                    disabled={!!editBlocked && open !== "edit"}
                    title={editBlocked}
                    onClick={() => toggle("edit")}
                  >
                    Edit image
                  </Button>
                )}
                <span className="cd-row__gap" />
                {prompt !== shot.prompt && (
                  <Button size="s" busy={busy === "save"} onClick={() => void run("save", savePrompt)}>
                    Save
                  </Button>
                )}
              </div>
              {open === "edit" && (
                <form
                  className="cd-tool"
                  aria-label="Edit image"
                  onSubmit={(e) => {
                    e.preventDefault();
                    makeEdit();
                  }}
                >
                  <Input autoFocus aria-label="What to change" value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="Make it night, remove the car" maxLength={3000} />
                  <p className="cd-text">
                    {selected?.rung === "still" ? "Edits the still on show." : "Edits the card's still."} The result is a new version of this card. {editCost}
                  </p>
                  <div className="cd-row cd-row--end">
                    <Button type="submit" size="s" variant="primary" busy={busy === "edit"} disabled={!instruction.trim() || !!editBlocked}>
                      Make the edit
                    </Button>
                  </div>
                </form>
              )}
            </section>
          )}

          <Section title="New version">
            {!quick && !whatIf && (
              <div className="cd-fields">
                <Select aria-label="Camera" value={shot.cameraMove ?? "static"} disabled={shot.locked} onChange={(e) => void change({ cameraMove: e.target.value })}>
                  {cameraMoves.some((m) => m.id === (shot.cameraMove ?? "static")) ? null : <option value={shot.cameraMove}>{shot.cameraMove}</option>}
                  {cameraMoves.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </Select>
                <label className="cd-dur">
                  <Input
                    type="number"
                    min={1}
                    max={tier?.longestShotSec ?? 30}
                    step={0.5}
                    aria-label="Duration in seconds"
                    value={shot.durationSec}
                    disabled={shot.locked}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (Number.isFinite(v) && v > 0) void change({ durationSec: Math.min(tier?.longestShotSec ?? 30, Math.max(1, v)) });
                    }}
                  />
                  <span aria-hidden>s</span>
                </label>
              </div>
            )}
            <div className="cd-actions">
              <Action
                icon={<Clapperboard />}
                disabled={!takeReady || !!taking || !!videoBlocked}
                busy={busy === "take"}
                title={videoBlocked ?? (takeReady ? undefined : "Draw the still first")}
                // The tool the pick was made with. A quick shot's older takes record none and stay on its template's path.
                onClick={() => void run("take", () => draft(project.id, shot.id, undefined, pick?.take?.tool))}
              >
                {takeLabel}
              </Action>
              {!whatIf && (
                <>
                  <Action
                    icon={<Sparkles />}
                    expanded={open === "effect"}
                    actionRef={(el) => {
                      toggles.current.effect = el;
                    }}
                    disabled={!shot.stillAssetId || !!effectBlocked}
                    title={effectBlocked}
                    onClick={() => toggle("effect")}
                  >
                    Effect
                  </Action>
                  {open === "effect" && (
                    <div className="cd-tool">
                      <EffectPicker compact value={effect} onChange={setEffect} />
                      {askSubject ? (
                        <Input aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Optional. What should change." />
                      ) : (
                        shot.prompt.trim() && <p className="cd-text">The effect follows the prompt above.</p>
                      )}
                      <div className="cd-row cd-row--end">
                        <Button
                          size="s"
                          variant="primary"
                          busy={busy === "effect"}
                          disabled={!!taking}
                          onClick={() =>
                            void run("effect", async () => {
                              if (askSubject && subject.trim()) await change({ prompt: subject.trim() });
                              await draft(project.id, shot.id, undefined, { kind: "effect", effect });
                              setOpen(null);
                            })
                          }
                        >
                          Apply effect
                        </Button>
                      </div>
                    </div>
                  )}
                  <Action
                    icon={<Move3d />}
                    expanded={open === "camera"}
                    actionRef={(el) => {
                      toggles.current.camera = el;
                    }}
                    disabled={!shot.stillAssetId || !!cameraBlocked}
                    title={cameraBlocked}
                    onClick={() => toggle("camera")}
                  >
                    Camera move
                  </Action>
                  {open === "camera" && (
                    <div className="cd-tool">
                      <CameraMovePicker value={path} onChange={setPath} />
                      <p className="cd-text">{cameraPhotoHint(path)}</p>
                      <div className="cd-row cd-row--end">
                        <Button
                          size="s"
                          variant="primary"
                          busy={busy === "camera"}
                          disabled={!!taking}
                          onClick={() =>
                            void run("camera", async () => {
                              await draft(project.id, shot.id, undefined, { kind: "camera_move", move: path });
                              setOpen(null);
                            })
                          }
                        >
                          Apply camera move
                        </Button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
            {!takeReady && !taking && <p className="cd-text">{whatIf ? "Draw the story's beats first." : "Draw the still first. Every version starts from it."}</p>}
          </Section>

          <Section title="Final" aside={pick?.rung === "final" && <Tag tone="night">{pick.take?.finalKind === "remaster" ? "Final, remaster" : "Final, same take"}</Tag>}>
            {pick?.rung === "final" ? (
              <>
                <p className="cd-text">{upscale && pick.take?.finalKind !== "remaster" ? `Upscaled${upscale.to}.` : "Full quality."} The editor shows it.</p>
                {reveal && (
                  <div>
                    <Button size="s" icon={<Share2 />} onClick={() => setRevealOpen(true)}>
                      Share reveal
                    </Button>
                  </div>
                )}
              </>
            ) : canFinish ? (
              <>
                <p className="cd-text">
                  {upscale && finalKind === "same_take" ? `The take you picked, upscaled${upscale.to}.` : finalKind === "same_take" ? "The take you picked at full quality. Same motion, same framing." : "A stronger model renders the take again."}{" "}
                  {finalSec ? `${sentenceCase(roughDuration(finalSec))} now, or tonight while you sleep.` : "Finish now, or tonight while you sleep."}
                </p>
                <div className="cd-row">
                  {/* Amber is the night's color: the daytime finish stays plain, so one context has one warm button. */}
                  <Button size="s" icon={<Sun />} busy={busy === "now"} disabled={!!finishing || !!busy} onClick={() => void finish("now")}>
                    Finish now
                  </Button>
                  <Button
                    ref={(el) => {
                      toggles.current.tonight = el;
                    }}
                    size="s"
                    variant="night"
                    icon={<Moon />}
                    disabled={!!finishing || !!busy}
                    aria-expanded={open === "tonight"}
                    onClick={() => toggle("tonight")}
                  >
                    Finish tonight
                  </Button>
                </div>
                {open === "tonight" && (
                  <div className="cd-night">
                    <b>Tonight, while you sleep</b>
                    <p>At {clock(startAt)} Nightshift renders this final at the heaviest settings this machine allows. In the morning it is here.</p>
                    <p className="cd-night__quiet">Keep the computer awake and plugged in. The desktop app keeps it awake for you.{overnightOn ? "" : " This turns overnight runs on. Pause them in Settings."}</p>
                    <div className="cd-row cd-row--end">
                      <Button size="s" variant="quiet" onClick={() => setOpen(null)}>
                        Not now
                      </Button>
                      <Button size="s" variant="night" icon={<Moon />} busy={busy === "overnight"} onClick={() => void finish("overnight")}>
                        Queue for tonight
                      </Button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="cd-text">{!finalKind ? "This setup cannot make finals." : pick?.rung === "still" ? "Pick a take to finish it. A still goes into the cut as it is." : "Make a take first, then finish it."}</p>
            )}
          </Section>
        </div>

        <footer className="cd-foot">
          {open === "delete" && (
            <div className="cd-confirm" role="alert">
              <p>Delete this shot? Its stills and takes go with it.</p>
              <div className="cd-row cd-row--end">
                <Button size="s" variant="quiet" onClick={() => setOpen(null)}>
                  Cancel
                </Button>
                <Button
                  size="s"
                  variant="danger"
                  busy={busy === "delete"}
                  onClick={() =>
                    void run("delete", async () => {
                      await edit((p) => withoutCard(p, shot.id));
                      onClose();
                    })
                  }
                >
                  Delete shot
                </Button>
              </div>
            </div>
          )}
          <div className="cd-row">
            {onTimeline ? (
              <Button icon={<ListMinus />} busy={busy === "timeline"} onClick={() => void run("timeline", () => edit((p) => takeOffTimeline(p, shot.id)))}>
                Take off the timeline
              </Button>
            ) : (
              <Button variant="primary" icon={<ListPlus />} busy={busy === "timeline"} onClick={() => void run("timeline", () => edit((p) => placeOnTimeline(p, [shot.id])))}>
                Add to timeline
              </Button>
            )}
            <span className="cd-row__gap" />
            {!whatIf && (
              <Button
                ref={(el) => {
                  toggles.current.delete = el;
                }}
                variant="quiet"
                icon={<Trash2 />}
                className="cd-delete"
                aria-expanded={open === "delete"}
                onClick={() => toggle("delete")}
              >
                Delete
              </Button>
            )}
          </div>
        </footer>
      </aside>
      {reveal && <RevealSheet project={project} shot={shot} open={revealOpen} onClose={() => setRevealOpen(false)} />}
    </div>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="cd-sec" aria-labelledby={id}>
      <div className="cd-sec__head">
        <h3 className="cd-sec__title" id={id}>
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A row in the list of ways to make a new version. One that opens a picker shows a chevron and its open state. */
function Action({
  icon,
  expanded,
  busy,
  disabled,
  title,
  onClick,
  actionRef,
  children,
}: {
  icon: ReactNode;
  expanded?: boolean;
  busy?: boolean;
  disabled?: boolean;
  title?: string | undefined;
  onClick: () => void;
  actionRef?: (el: HTMLButtonElement | null) => void;
  children: ReactNode;
}) {
  return (
    <button ref={actionRef} type="button" className="cd-action" aria-expanded={expanded} aria-busy={busy || undefined} disabled={disabled || busy} title={title} onClick={onClick}>
      <span className="cd-action__icon" aria-hidden>
        {busy ? <span className="spin" /> : icon}
      </span>
      <span className="cd-action__label">{children}</span>
      {expanded !== undefined && <ChevronDown className="cd-action__chevron" aria-hidden />}
    </button>
  );
}

function PickTag() {
  return (
    <span className="cd-pick">
      <Check aria-hidden /> Pick
    </span>
  );
}

function VersionTile({
  n,
  version,
  aspect,
  label,
  selected,
  onSelect,
  tileRef,
}: {
  n: number;
  version: Version;
  aspect: string;
  label: string;
  selected: boolean;
  onSelect: () => void;
  tileRef: (el: HTMLButtonElement | null) => void;
}) {
  const { project } = useMedia();
  const { client } = useEngine();
  const rest = restingTime(version, 4);
  return (
    <div className={cx("cd-ver", selected && "cd-ver--selected")} role="listitem">
      {/* One version is in the Tab order at a time, the selected one: the arrow keys move between them. The dialog
          starts on it (data-autofocus). */}
      <button
        ref={tileRef}
        type="button"
        className="cd-ver__btn"
        aria-label={`Version ${n}, ${label}${version.pick ? ", the pick" : ""}`}
        aria-pressed={selected}
        tabIndex={selected ? 0 : -1}
        data-autofocus={selected || undefined}
        onClick={onSelect}
      >
        <div className={cx("frame cd-ver__frame", aspect)}>
          <Media src={client.assetUrl(project.id, version.asset.id)} kind={version.rung === "still" ? "image" : "video"} {...(rest !== undefined ? { time: rest } : {})} />
          {version.pick && (
            <div className="cd-ver__pick">
              <PickTag />
            </div>
          )}
        </div>
        <div className={cx("cd-ver__kind", version.rung === "final" && "cd-ver__kind--final")}>{label}</div>
        <div className="cd-ver__time">{relativeTime(version.createdAt)}</div>
      </button>
    </div>
  );
}
