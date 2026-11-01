import type { RuntimeStatus, Settings, TierSummary } from "@nightshift/contract";
import { useEffect, useRef, useState } from "react";
import { useEngine, useEngineState, useJobs } from "@/store/engine";
import { jobLabel } from "@/features/project/helpers";
import { NightArc, finalSeconds } from "@/features/queue/NightArc";
import { useNow } from "@/lib/useNow";
import { tierFor, useHardware, useInstalledTier, useThisMachine, useTiers } from "@/store/tier";
import { useThemeMode } from "@/store/theme";
import { sentenceCase } from "@nightshift/contract";
import { Button, Dialog, Input, Segmented, Slider, Switch, cx, toast } from "@/ui/primitives";
import { clock, gb, roughDuration } from "@/lib/format";
import { RemoteSetup } from "@/features/compute/RemoteSetup";
import { DemoSection } from "@/features/demo/DemoNote";
import "./settings.css";

export function SettingsPage() {
  const { settings, status, projects } = useEngineState();
  const { updateSettings, refreshSetup, remoteForget, remoteCheck, reload, client } = useEngine();
  const hw = useHardware();
  const tier = useInstalledTier();
  const tiers = useTiers();
  const [theme, setTheme] = useThemeMode();
  const here = useThisMachine();
  const gpu = hw?.gpus[0];
  const total = hw?.ramGb ?? 0;
  const peakMax = Math.max(...Object.values(tier?.estimates ?? {}).map((e) => e?.peakGb ?? 0), 4);
  const minMem = Math.min(total || 8, gpu?.unifiedMemory ? Math.ceil(peakMax) : Math.max(8, tier?.match.minRamGb ?? 8));
  const remote = settings?.remote ?? null;
  const onRemote = status?.mode === "remote" && !!remote;
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const remoteAway = onRemote && status?.phase === "ready" && !status.comfyui.running;
  const remoteError = onRemote && status?.phase === "ready" && status.comfyui.running ? status.error : undefined;

  // Follow server updates until the user starts adjusting this page's slider.
  const [memoryOverride, setMemory] = useState<number | null>(null);
  const memory = memoryOverride ?? (settings && hw && tier ? Math.min(total, Math.max(minMem, settings.memoryLimitGb ?? tier.defaultMemoryLimitGb ?? Math.round(total * 0.8))) : null);
  const saveTimer = useRef<number | null>(null);
  const overnightSaves = useRef(Promise.resolve());
  /** Saves a change to the night shift, after any save before it, and says it saved: the window it now runs in. */
  const saveOvernight = (patch: Partial<Settings["overnight"]>): Promise<void> => {
    const save = overnightSaves.current.then(async () => {
      const current = await client.settings();
      const saved = await updateSettings({ overnight: { ...current.overnight, ...patch } });
      const night = saved.overnight;
      toast({ title: night.enabled ? "Night shift saved" : "Night shift paused", text: night.enabled ? `Finals for tonight run from ${clock(night.startAt)} to ${clock(night.endAt)}` : "Finals for tonight wait until you turn it back on", tone: "ok", ttl: 2600 });
    });
    overnightSaves.current = save.catch(() => undefined);
    return save.catch((e) => toast({ title: "Couldn't save the night shift", text: e instanceof Error ? e.message : String(e), tone: "bad" }));
  };
  useEffect(() => {
    void refreshSetup().catch((e) => toast({ title: "Couldn't refresh settings", text: String(e), tone: "bad" }));
  }, [refreshSetup]);

  const saveMemory = (v: number) => {
    setMemory(v);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      updateSettings({ memoryLimitGb: v })
        .then(() => toast({ title: "Memory limit saved", text: "Takes effect on the next render", tone: "ok", ttl: 2600 }))
        .catch((e) => toast({ title: "Couldn't save", text: String(e), tone: "bad" }));
    }, 500);
  };

  const overnight = settings?.overnight;
  // Tonight's finals, the one running first, for the night's arc.
  const jobs = useJobs();
  const tonightJobs = [...jobs.filter((j) => j.mode === "overnight" && j.status === "running"), ...jobs.filter((j) => j.mode === "overnight" && j.status === "queued")];
  const now = useNow(30_000, true);
  const measured = tier?.estimates ? Object.values(tier.estimates).some((e) => e?.measured) : false;
  const remoteName = remote?.name ?? remote?.url.replace(/^https?:\/\//, "") ?? "";
  const models = modelRows(tier);

  const checkAgain = async () => {
    if (!remote) return;
    setChecking(true);
    try {
      const r = await remoteCheck(remote.url);
      await reload();
      if (r.reachable) toast({ title: `${r.name ?? remoteName} is answering`, text: r.missingNodes.length || r.missingModels.length ? "Some nodes or models are still missing there." : "Queued work starts on its own.", tone: "ok" });
      else toast({ title: `${remoteName} is not answering`, text: r.error, tone: "bad" });
    } catch (e) {
      toast({ title: "Couldn't check", text: e instanceof Error ? e.message : String(e), tone: "bad" });
    } finally {
      setChecking(false);
    }
  };

  const useThisMac = async () => {
    setLeaving(true);
    try {
      const s = await remoteForget();
      toast({ title: `Back to ${here.lower}`, text: s.phase === "ready" ? "Work runs here again" : `${here.name} has no setup yet. Set one up to render here.`, tone: "ok" });
    } catch (e) {
      toast({ title: "Couldn't switch", text: e instanceof Error ? e.message : String(e), tone: "bad" });
    } finally {
      setLeaving(false);
    }
  };

  return (
    <div className="page page--narrow">
      <div className="page__head">
        <div>
          <h1 className="page__title">Settings</h1>
          <p className="page__sub">{onRemote ? `Your projects and settings stay on this machine. Renders run on ${remoteName}.` : "Everything here stays on this machine"}</p>
        </div>
      </div>
      <div className="settings">
        <DemoSection />
        <section>
          <div className="group__head">Appearance</div>
          <div className="group">
            <div className="group__row">
              <div className="group__k">
                <b>Theme</b>
                <small>Dark shows pictures and video best. System follows your computer's setting.</small>
              </div>
              <Segmented
                label="Theme"
                value={theme}
                onChange={setTheme}
                options={[
                  { value: "dark", label: "Dark" },
                  { value: "light", label: "Light" },
                  { value: "system", label: "System" },
                ]}
              />
            </div>
          </div>
        </section>

        <section>
          <div className="group__head">Compute</div>
          <div className="group">
            <div className="group__row">
              <span className={cx("compute__dot", status?.phase !== "ready" ? "compute__dot--off" : !status.comfyui.running ? "compute__dot--bad" : remoteError ? "compute__dot--warn" : "")} />
              <div className="group__k">
                <b>{onRemote ? remoteName : here.name}</b>
                <small>{onRemote ? `${remote.url}. ${status?.phase !== "ready" ? `${engineLine(status)}.` : status.comfyui.running ? (remoteError ? remoteError : "Answering.") : "Not answering. Queued work waits."}` : "Renders run on this computer"}</small>
              </div>
              <div className="settings__actions">
                {onRemote && (remoteAway || remoteError) && (
                  <Button size="s" busy={checking} onClick={() => void checkAgain()}>
                    Check again
                  </Button>
                )}
                {onRemote && (
                  <Button size="s" busy={leaving} onClick={() => void useThisMac()}>
                    Use {here.lower}
                  </Button>
                )}
                <Button size="s" onClick={() => setRemoteOpen(true)}>
                  {onRemote ? "Change" : "Use a GPU computer"}
                </Button>
              </div>
            </div>
            <div className="group__row">
              <div className="group__k">
                <b>Setup</b>
                <small>{measured ? "Times were measured on this kind of machine" : "Times are estimates for this kind of machine"}</small>
              </div>
              <span className="group__v">{tier ? tierFor(tier) : (settings?.tier ?? "None")}</span>
            </div>
            {!!tier?.estimates?.video_draft?.seconds && (
              <div className="group__row">
                <div className="group__k">
                  <b>A draft</b>
                </div>
                <span className="group__v">{sentenceCase(roughDuration(tier.estimates.video_draft.seconds ?? 0))}</span>
              </div>
            )}
            {!!tier?.estimates?.video_final_same_take?.seconds && (
              <div className="group__row">
                <div className="group__k">
                  <b>A final</b>
                </div>
                <span className="group__v">{sentenceCase(roughDuration(tier.estimates.video_final_same_take.seconds ?? 0))}</span>
              </div>
            )}
          </div>
        </section>

        <section>
          <div className="group__head">{onRemote ? "GPU computer" : "Hardware"}</div>
          <div className="group">
            <div className="group__row">
              <div className="group__k">
                <b>Graphics</b>
              </div>
              <span className="group__v">{gpu ? `${gpu.name}${onRemote && gpu.vramGb > 0 ? `, ${gb(gpu.vramGb)}` : ""}` : "Reading"}</span>
            </div>
            {!onRemote && (
              <div className="group__row">
                <div className="group__k">
                  <b>Memory</b>
                </div>
                <span className="group__v">{hw ? `${gb(hw.ramGb)}${gpu?.unifiedMemory ? ", shared with graphics" : gpu ? `, plus ${gb(gpu.vramGb)} on the graphics card` : ""}` : ""}</span>
              </div>
            )}
            {!onRemote && (
              <div className="group__row">
                <div className="group__k">
                  <b>Free disk</b>
                </div>
                <span className="group__v">{hw ? gb(hw.freeDiskGb) : ""}</span>
              </div>
            )}
            <div className="group__row">
              <div className="group__k">
                <b>Engine</b>
                {status?.phase === "ready" && !status.comfyui.running && <small>{status.error ? `${status.error.replace(/[.\s]+$/, "")}. ` : ""}Queued work starts on its own when it is back.</small>}
              </div>
              <span className="group__v">{engineLine(status, remoteName)}</span>
            </div>
          </div>
        </section>

        {!onRemote && (
        <section>
          <div className="group__head">Memory</div>
          <div className="group">
            <div className="group__row group__row--stack">
              <div className="settings__memhead">
                <div className="group__k">
                  <b>Leave room for other apps</b>
                  <small>{gpu?.unifiedMemory ? "The most memory Nightshift may use. Lower is safer with other apps open, higher is faster." : "System memory Nightshift may use next to the graphics card. The card itself is used in full."}</small>
                </div>
                <b className="t-num settings__memvalue">{memory !== null ? `${gb(memory)} of ${gb(total)}` : "Reading"}</b>
              </div>
              {memory !== null && total > 0 && <Slider value={memory} min={minMem} max={total} onChange={saveMemory} label="Memory limit" />}
              <div className="settings__scale" style={{ visibility: hw ? "visible" : "hidden" }}>
                <span>{gb(minMem)}, slower</span>
                <span>{gb(total)}, everything</span>
              </div>
            </div>
          </div>
          <p className="settings__foot">If a render runs out of memory, raise this or close other apps. Changes apply to the next render.</p>
        </section>
        )}

        <section>
          <div className="group__head">Night shift</div>
          <div className="group">
            {overnight && (
              <div className="group__row group__row--stack settings__night">
                <NightArc
                  startAt={overnight.startAt}
                  endAt={overnight.endAt}
                  enabled={overnight.enabled}
                  now={now}
                  finals={tonightJobs.map((j) => ({ id: j.id, label: jobLabel(j, projects[j.projectId]), seconds: finalSeconds(j, tier) * (j.status === "running" ? 1 - j.progress : 1) }))}
                />
              </div>
            )}
            <div className="group__row">
              <div className="group__k">
                <b>Run finals overnight</b>
                <small>Finals you queue for tonight run in this window, one after another, at the heaviest settings your machine allows</small>
              </div>
              <Switch label="Enable overnight runs" checked={overnight?.enabled ?? true} onChange={(v) => saveOvernight({ enabled: v })} />
            </div>
            <div className="group__row">
              <div className="group__k">
                <b>Starts</b>
              </div>
              <TimeField label="Overnight start" value={overnight?.startAt ?? "23:00"} onSave={(startAt) => saveOvernight({ startAt })} />
            </div>
            <div className="group__row">
              <div className="group__k">
                <b>Ends</b>
              </div>
              <TimeField label="Overnight end" value={overnight?.endAt ?? "07:00"} onSave={(endAt) => saveOvernight({ endAt })} />
            </div>
          </div>
          <p className="settings__foot">Keep the computer awake and plugged in through the night. The desktop app does that for you.</p>
        </section>

        {models.length > 0 && (
          <section>
            <div className="group__head">Under the hood</div>
            <div className="group">
              {models.map(([what, model]) => (
                <div key={what} className="group__row">
                  <div className="group__k">
                    <b>{what}</b>
                  </div>
                  <span className="group__v">{model}</span>
                </div>
              ))}
            </div>
            <p className="settings__foot">Nightshift picks the models for your machine, so you don't have to</p>
          </section>
        )}
      </div>

      <Dialog open={remoteOpen} onClose={() => setRemoteOpen(false)} width={520}>
        <h2 className="dialog__title">Use a GPU computer on your network</h2>
        <p className="dialog__text">Nightshift sends every render there and keeps your projects here. Type the computer's name or address.</p>
        <RemoteSetup
          initialUrl={remote?.url}
          tiers={tiers}
          onCancel={() => setRemoteOpen(false)}
          demoAction={{ label: `Keep using ${here.lower}`, onAction: () => setRemoteOpen(false) }}
          onUsed={() => {
            setRemoteOpen(false);
            toast({ title: "Work now runs on the network", text: `Projects stay on ${here.lower}`, tone: "ok" });
          }}
        />
      </Dialog>
    </div>
  );
}

/** The engine row, in plain words. Attached to a shared GPU that is away, the engine is up but cannot render. */
function engineLine(status: RuntimeStatus | null | undefined, remoteName = ""): string {
  if (!status) return "";
  if (status.phase === "ready") return status.comfyui.running ? `Running${status.comfyui.version ? `, ComfyUI ${status.comfyui.version}` : ""}` : remoteName ? `Waiting for ${remoteName}` : "Waiting for the GPU";
  return { not_installed: "Not set up", installing: "Installing", starting: "Starting", stopped: "Stopped", error: "Needs attention" }[status.phase];
}

/**
 * A time of the night window. Typing goes to a draft, saved when the field loses focus or on Enter. Saving on every
 * keystroke re-rendered the field and reset the browser's typing in its hour and minute: typing 3, 2, 5 gave 05:12. The
 * draft shows until the engine has the new time, so the field never jumps back to the old one.
 */
export function TimeField({ label, value, onSave }: { label: string; value: string; onSave: (value: string) => Promise<void> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const latest = useRef({ draft, value, onSave });
  latest.current = { draft, value, onSave };
  const commit = () => {
    const { draft: next, value: saved } = latest.current;
    // An empty draft is a time typed only in part: the saved one comes back.
    if (next === null || !next || next === saved) return setDraft(null);
    void onSave(next).finally(() => setDraft((d) => (d === next ? null : d)));
  };
  // Leaving the page with a time typed and not yet saved still saves it.
  useEffect(
    () => () => {
      const { draft: next, value: saved, onSave: save } = latest.current;
      if (next && next !== saved) void save(next);
    },
    [],
  );
  return (
    <Input
      className="settings__time"
      type="time"
      aria-label={label}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}

/** The models this setup runs, by what they make, in plain words. Steps the setup lacks are left out. */
function modelRows(tier: TierSummary | null): Array<[string, string]> {
  const m = tier?.models;
  if (!m) return [];
  const rows: Array<[string, string | undefined]> = [
    ["Images", m.still],
    ["Images from references", tier.referenceStillModel],
    ["Image edits", m.effect_end_frame],
    ["Video", m.video_draft],
    ["Finals", m.video_final_same_take ?? m.video_final_remaster],
    ["Remasters", m.video_final_same_take ? m.video_final_remaster : undefined],
    ["Voice", m.voice],
    ["Music", m.music],
    ["Shot lists", m.text],
  ];
  return rows.filter((r): r is [string, string] => !!r[1]);
}
