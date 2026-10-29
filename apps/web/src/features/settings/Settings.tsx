import type { RuntimeStatus, Settings } from "@nightshift/contract";
import { useEffect, useRef, useState } from "react";
import { useEngine, useEngineState } from "@/store/engine";
import { tierFor, useHardware, useInstalledTier, useThisMachine, useTiers } from "@/store/tier";
import { useThemeMode } from "@/store/theme";
import { Button, Dialog, Input, Segmented, Slider, Switch, cx, toast } from "@/ui/primitives";
import { clock, gb, roughDuration } from "@/lib/format";
import { RemoteSetup } from "@/features/compute/RemoteSetup";
import "./settings.css";

export function SettingsPage() {
  const { settings, status } = useEngineState();
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
  const saveOvernight = (patch: Partial<Settings["overnight"]>) => {
    overnightSaves.current = overnightSaves.current.then(async () => {
      const current = await client.settings();
      await updateSettings({ overnight: { ...current.overnight, ...patch } });
    }).catch((e) => toast({ title: "Couldn't save the overnight window", text: e instanceof Error ? e.message : String(e), tone: "bad" }));
  };
  useEffect(() => {
    void refreshSetup().catch((e) => toast({ title: "Couldn't refresh settings", text: String(e), tone: "bad" }));
  }, [refreshSetup]);

  const saveMemory = (v: number) => {
    setMemory(v);
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      updateSettings({ memoryLimitGb: v })
        .then(() => toast({ title: "Memory limit saved", text: "Takes effect on the next render.", tone: "ok", ttl: 2600 }))
        .catch((e) => toast({ title: "Couldn't save", text: String(e), tone: "bad" }));
    }, 500);
  };

  const overnight = settings?.overnight;
  const measured = tier?.estimates ? Object.values(tier.estimates).some((e) => e?.measured) : false;
  const remoteName = remote?.name ?? remote?.url.replace(/^https?:\/\//, "") ?? "";

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
      toast({ title: `Back to ${here.lower}`, text: s.phase === "ready" ? "Work runs here again." : `${here.name} has no setup yet. Set one up to render here.`, tone: "ok" });
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
          <p className="page__sub">Everything here stays on this machine.</p>
        </div>
      </div>
      <div className="settings">
        <section>
          <div className="group__head">Appearance</div>
          <div className="group">
            <div className="group__row">
              <div className="group__k">
                <b>Theme</b>
                <small>System follows your Mac's setting.</small>
              </div>
              <Segmented
                label="Theme"
                value={theme}
                onChange={setTheme}
                options={[
                  { value: "system", label: "System" },
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
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
                <small>{onRemote ? `${remote.url}. ${status?.phase !== "ready" ? `${engineLine(status)}.` : status.comfyui.running ? (remoteError ? remoteError : "Answering.") : "Not answering. Queued work waits."}` : gpu ? `${gpu.name}. ${engineLine(status)}.` : engineLine(status)}</small>
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
                <small>{measured ? "Times were measured on this kind of machine." : "Times are estimates for this kind of machine."}</small>
              </div>
              <span className="group__v">{tier ? tierFor(tier) : (settings?.tier ?? "None")}</span>
            </div>
            {tier?.estimates && (
              <div className="group__row">
                <div className="group__k">
                  <b>A draft, a final</b>
                </div>
                <span className="group__v">
                  {roughDuration(tier.estimates.video_draft?.seconds ?? 0)}, {roughDuration(tier.estimates.video_final_same_take?.seconds ?? 0)}
                </span>
              </div>
            )}
          </div>
        </section>

        <section>
          <div className="group__head">{onRemote ? remoteName : here.name}</div>
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
          <div className="group__head">Overnight</div>
          <div className="group">
            <div className="group__row">
              <div className="group__k">
                <b>Overnight runs</b>
                <small>Finals you queue for overnight run in this window, one after another, at the heaviest settings your machine allows.</small>
              </div>
              <Switch label="Enable overnight runs" checked={overnight?.enabled ?? true} onChange={(v) => saveOvernight({ enabled: v })} />
            </div>
            <div className="group__row">
              <div className="group__k">
                <b>From</b>
              </div>
              <Input className="settings__time" type="time" aria-label="Overnight start" value={overnight?.startAt ?? "23:00"} onChange={(e) => e.target.value && saveOvernight({ startAt: e.target.value })} />
            </div>
            <div className="group__row">
              <div className="group__k">
                <b>To</b>
              </div>
              <Input className="settings__time" type="time" aria-label="Overnight end" value={overnight?.endAt ?? "07:00"} onChange={(e) => e.target.value && saveOvernight({ endAt: e.target.value })} />
            </div>
          </div>
          <p className="settings__foot">
            {overnight?.enabled ? `Tonight's queue starts at ${clock(overnight.startAt)} and stops by ${clock(overnight.endAt)}. ` : "Overnight runs are paused. Queued finals wait until you turn them on. "}
            Keep the computer awake and plugged in. The desktop app does that for you.
          </p>
        </section>

        <section>
          <div className="group__head">Under the hood</div>
          <div className="group">
            <div className="group__row">
              <div className="group__k">
                <b>Models and workflows</b>
                <small>Nightshift picks the models for your machine so you don't have to. A nerd mode that shows the recipe and lets you swap models is planned. It will live here.</small>
              </div>
            </div>
          </div>
        </section>
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
            toast({ title: "Work now runs on the network", text: `Projects stay on ${here.lower}.`, tone: "ok" });
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
