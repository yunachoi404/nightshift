import type { HardwareProfile, InstallPlan, Project, TierSummary } from "@nightshift/contract";
import { ChevronDown, ChevronRight, Cpu, Film, HardDrive, Image, MemoryStick, Mic, Monitor, Music, Sparkles, Wand2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { isMock } from "@/api/config";
import { ApiError } from "@/api/client";
import { useEngine, useEngineState, useJobs, useProject } from "@/store/engine";
import { Button, Field, Input, Notice, Segmented, Select, Slider, Tag, cx, toast } from "@/ui/primitives";
import { Mark } from "@/ui/Mark";
import { gb, roughDuration, shortDuration } from "@/lib/format";
import { Media } from "@/media/Media";
import { useDemoMode } from "@/store/demo";
import { isMac, machineName, tierFor, tierName, upscaleOnly, useInstalledTier, useTiers } from "@/store/tier";
import { RemoteSetup } from "@/features/compute/RemoteSetup";
import { WelcomeTour } from "./WelcomeTour";
import { bestAssetFor, failureText, frameClass, jobElapsed, jobStatusLine } from "@/features/project/helpers";
import { useNow } from "@/lib/useNow";
import "./onboarding.css";

type Step = "welcome" | "detect" | "tier" | "install" | "starting" | "first";

/** The dots under each step. Welcome is before the first dot; starting shares install's. */
const dotSteps: Step[] = ["detect", "tier", "install", "first"];

export function Onboarding({ onDev }: { onDev: () => void }) {
  const { status, onboarding } = useEngineState();
  // Someone who has been through setup before (say, after leaving a GPU computer) skips the welcome.
  const [local, setLocal] = useState<Step>(() => (onboarding?.done ? "detect" : "welcome"));
  const [hardware, setHardware] = useState<HardwareProfile | null>(null);

  const phase = status?.phase ?? "not_installed";
  const step: Step = phase === "installing" || phase === "error" ? "install" : phase === "starting" ? "starting" : phase === "ready" ? "first" : local;

  return (
    <div className="ob">
      <div className="ob__strip drag">
        {isMock() && (
          <Button variant="toolbar" size="s" onClick={onDev}>
            Mock
          </Button>
        )}
      </div>
      <div className="ob__stage">
        {step === "welcome" && <Welcome key="welcome" onNext={() => setLocal("detect")} />}
        {step === "detect" && (
          <Detect
            key="detect"
            onBack={() => setLocal("welcome")}
            onNext={(hw) => {
              setHardware(hw);
              setLocal("tier");
            }}
          />
        )}
        {step === "tier" && hardware && <Tier key="tier" hardware={hardware} onBack={() => setLocal("detect")} />}
        {step === "install" && <Install key="install" />}
        {step === "starting" && <Starting key="starting" />}
        {step === "first" && <FirstShot key="first" />}
      </div>
    </div>
  );
}

/** The big action under a step, a quiet one below it, and the dots. */
function Actions({ step, children, quiet }: { step: Step; children?: ReactNode; quiet?: ReactNode }) {
  const at = dotSteps.indexOf(step === "starting" ? "install" : step);
  return (
    <div className="ob__actions ob__rise" style={{ "--i": 3 } as React.CSSProperties}>
      {children}
      {quiet}
      <div className="ob__dots" aria-hidden>
        {dotSteps.map((s, i) => (
          <span key={s} className={cx("ob__dot", i === at && "ob__dot--on", i < at && "ob__dot--done")} />
        ))}
      </div>
    </div>
  );
}

function Rise({ i, children, className }: { i: number; children: ReactNode; className?: string }) {
  return (
    <div className={cx("ob__rise", className)} style={{ "--i": i } as React.CSSProperties}>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- welcome

/**
 * A word in the welcome sentence, with a real frame made in Nightshift beside it. See public/welcome/README.md.
 * `after` is the punctuation that follows, kept on the same line as the chip.
 */
function Chip({ img, after, children }: { img: string; after?: string; children: ReactNode }) {
  const chip = (
    <span className="ob__chip">
      <img src={`/welcome/chip-${img}.jpg`} alt="" />
      {children}
    </span>
  );
  return after ? (
    <span className="ob__glue">
      {chip}
      {after}
    </span>
  ) : (
    chip
  );
}

function Welcome({ onNext }: { onNext: () => void }) {
  const demo = useDemoMode();
  return (
    <div className="ob__step ob__step--hero">
      <div className="ob__hero-top">
        <Rise i={0} className="ob__brand">
          <Mark size={28} />
          <span>Nightshift</span>
        </Rise>
        <Rise i={1} className="ob__head">
          <h1 className="ob__hero">A night shift for your videos.</h1>
          <p className="ob__sentence">
            Make <Chip img="whatif" after=",">What if? films</Chip> <Chip img="film" after=",">cinematic shots</Chip> <Chip img="music" after=",">music videos</Chip>
            <br className="ob__break" /> <Chip img="ad">product ads</Chip> and <Chip img="intro">talking intros</Chip> on hardware you own.
          </p>
          <p className="ob__promise">Drafts by day. Finals overnight. Nothing leaves your machines.</p>
        </Rise>
        <Rise i={2} className="ob__actions ob__actions--hero">
          <Button variant="primary" size="l" className="ob__cta ob__go" onClick={onNext}>
            Get started
          </Button>
          <span className="ob__fine">{demo ? "Sample renders. Nothing is downloaded." : "A few minutes, mostly downloading."}</span>
        </Rise>
      </div>
      <div className="ob__stagefloor">
        <Rise i={3} className="ob__floor-rise">
          <WelcomeTour />
        </Rise>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- detect

type Where = "local" | "remote";

function Detect({ onNext, onBack }: { onNext: (hw: HardwareProfile) => void; onBack: () => void }) {
  const { client } = useEngine();
  const tiers = useTiers();
  const [hw, setHw] = useState<HardwareProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [revealed, setRevealed] = useState(0);
  const [where, setWhere] = useState<Where>("local");

  const detect = useCallback(async () => {
    setError(null);
    setHw(null);
    setRevealed(0);
    try {
      const result = await client.hardware();
      setHw(result);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not read your hardware.");
    }
  }, [client]);

  useEffect(() => {
    void detect();
  }, [detect]);

  // Reveal tiles one at a time so detection reads as the app looking at the machine.
  useEffect(() => {
    if (!hw) return;
    const timers = [1, 2, 3, 4].map((n) => window.setTimeout(() => setRevealed(n), 260 * n));
    return () => timers.forEach(clearTimeout);
  }, [hw]);

  const gpu = hw?.gpus[0];
  const discrete = !!gpu && gpu.vramGb > 0 && !gpu.unifiedMemory;
  const noGpu = !gpu || gpu.vendor === "none" || gpu.vramGb === 0;
  const done = !!hw && revealed >= 4;
  const scanning = where === "local" && !error && !manual && !done;
  /** One fact in the sentence. Until it is read it holds its place with a shimmer. */
  const fact = (n: number, icon: ReactNode, text: string, width: number) =>
    hw && revealed >= n ? (
      <span className="ob__chip ob__chip--fact ob__chip--in">
        {icon}
        {text}
      </span>
    ) : (
      <span className="ob__chip ob__chip--fact ob__chip--wait shimmer" style={{ width }} aria-hidden>
        &nbsp;
      </span>
    );

  return (
    <div className="ob__step">
      <Rise i={0} className="ob__where">
        <Segmented
          label="Where renders run"
          value={where}
          onChange={setWhere}
          options={[
            { value: "local", label: machineName(isMac(hw?.os)) },
            { value: "remote", label: "A GPU computer on my network" },
          ]}
        />
      </Rise>
      <Rise i={1} className="ob__head">
        <h1 className="ob__title">{where === "remote" ? "A GPU computer on your network" : error || manual ? "Tell Nightshift about this machine" : done ? "Here's what you've got" : "Looking at your machine"}</h1>
        <p className="ob__lead">{where === "remote" ? "Renders go there. Projects stay here." : error ? "It couldn't read the hardware. Fill in the basics." : manual ? "Models and settings are picked for this exact hardware." : "Models and settings picked for this exact hardware."}</p>
      </Rise>
      {where === "local" && <SetupAgain />}

      {where === "local" && (
        <>
          {error && (
            <div className="ob__notice"><Notice tone="bad" title="Couldn't read your hardware">
              {error}
              <div className="notice__actions">
                <Button size="s" onClick={() => void detect()}>
                  Try again
                </Button>
              </div>
            </Notice></div>
          )}
          {!manual && !error && (
            <Rise i={2} className="ob__facts">
              <p className="ob__sentence ob__sentence--facts" aria-busy={scanning || undefined}>
                {noGpu ? <span className="ob__glue">{fact(1, <Monitor />, "No usable graphics chip", 168)},</span> : fact(1, <Monitor />, gpu!.name, 168)}
                {noGpu ? " " : " graphics with "}
                {discrete ? (
                  <>
                    {fact(2, <MemoryStick />, `${gb(gpu!.vramGb)} of its own`, 120)} memory, {fact(2, <MemoryStick />, gb(hw!.ramGb), 76)} of system memory,{" "}
                  </>
                ) : (
                  <>
                    {fact(2, <MemoryStick />, gb(hw?.ramGb ?? 0), 76)} of {gpu?.unifiedMemory ? "shared memory" : "memory"},{" "}
                  </>
                )}
                {fact(3, <HardDrive />, `${gb(hw?.freeDiskGb ?? 0)} free`, 104)} on disk, running{" "}
                <span className="ob__glue">
                  {fact(4, <Cpu />, hw ? `${osName(hw.os)} on ${archName(hw.arch, hw.os)}` : "", 176)}.
                </span>
              </p>
            </Rise>
          )}
          {(manual || error) && (
            <div className="ob__card">
              <ManualForm
                initial={hw}
                onSave={async (p) => {
                  const saved = await client.setHardwareManual(p);
                  onNext(saved);
                }}
                onCancel={error ? undefined : () => setManual(false)}
              />
            </div>
          )}
        </>
      )}

      {where === "remote" && (
        <Rise i={2} className="ob__remote">
          <RemoteSetup
            compact
            tiers={tiers}
            onUsed={() => {
              // The engine is ready now; the step follows the runtime phase to the first shot.
            }}
            demoAction={{
              label: "Continue with sample renders",
              // The demo renders on this machine: go on with what was read about it, or ask for it if that failed.
              onAction: () => (hw ? onNext(hw) : setWhere("local")),
            }}
          />
        </Rise>
      )}

      <Actions
        step="detect"
        quiet={
          <>
            {where === "local" && !error && !manual && done && hw?.source !== "manual" && (
              <button type="button" className="ob__linkbtn" onClick={() => setManual(true)}>
                Not right? Enter it yourself
              </button>
            )}
            <button type="button" className="ob__quiet" onClick={onBack}>
              Back
            </button>
          </>
        }
      >
        {where === "local" && !error && !manual && (
          <Button variant="primary" size="l" className="ob__cta" disabled={!done} onClick={() => hw && onNext(hw)}>
            {done ? "Continue" : "Looking"}
          </Button>
        )}
      </Actions>
    </div>
  );
}

function ManualForm({ initial, onSave, onCancel }: { initial: HardwareProfile | null; onSave: (p: HardwareProfile) => Promise<void>; onCancel?: () => void }) {
  const g = initial?.gpus[0];
  const [vendor, setVendor] = useState<"nvidia" | "apple" | "amd" | "intel" | "none">(g?.vendor ?? "nvidia");
  const [name, setName] = useState(g?.name ?? "");
  const [vram, setVram] = useState(g ? String(g.vramGb) : "");
  const [ram, setRam] = useState(initial ? String(initial.ramGb) : "");
  const [disk, setDisk] = useState(initial ? String(initial.freeDiskGb) : "");
  const [os, setOs] = useState<"macos" | "windows" | "linux">(initial?.os ?? (vendor === "apple" ? "macos" : "windows"));
  const [busy, setBusy] = useState(false);
  const [sharedMemory, setSharedMemory] = useState(g?.vendor === "nvidia" && g.unifiedMemory === true);
  const unified = vendor === "apple" || (vendor === "nvidia" && sharedMemory);
  const valid = Number(ram) > 0 && Number(disk) >= 0 && (vendor === "none" || unified || Number(vram) > 0);

  return (
    <form
      className="manual"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid) return;
        setBusy(true);
        try {
          await onSave({
            os,
            arch: vendor === "apple" ? "arm64" : "x64",
            cpu: "Entered by hand",
            ramGb: Number(ram),
            freeDiskGb: Number(disk),
            gpus: [{ vendor, name: name || (vendor === "apple" ? "Apple Silicon" : vendor === "none" ? "None" : "Graphics card"), vramGb: unified ? Number(ram) : Number(vram || 0), unifiedMemory: unified }],
            source: "manual",
          });
        } catch (err) {
          toast({ title: "Couldn't save", text: err instanceof Error ? err.message : String(err), tone: "bad" });
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Graphics">
        {(id) => (
          <Select
            id={id}
            value={vendor}
            onChange={(e) => {
              const v = e.target.value as typeof vendor;
              setVendor(v);
              if (v === "apple") setOs("macos");
            }}
          >
            <option value="nvidia">NVIDIA card</option>
            <option value="apple">Apple Silicon</option>
            <option value="amd">AMD card</option>
            <option value="intel">Intel graphics</option>
            <option value="none">No graphics card</option>
          </Select>
        )}
      </Field>
      <Field label="System">
        {(id) => (
          <Select id={id} value={os} onChange={(e) => setOs(e.target.value as typeof os)}>
            <option value="macos">macOS</option>
            <option value="windows">Windows</option>
            <option value="linux">Linux</option>
          </Select>
        )}
      </Field>
      <Field label="Model name" hint="Optional. For example RTX 4090 or M3 Pro." className="field--wide">
        {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder={vendor === "apple" ? "M3 Pro" : "RTX 4090"} />}
      </Field>
      {vendor === "nvidia" && (
        <label className="field--wide manual__check">
          <input type="checkbox" className="check" checked={sharedMemory} onChange={(e) => setSharedMemory(e.target.checked)} />
          <span>
            Graphics shares the system's memory
            <small>Like a DGX Spark. Leave it off for a graphics card with its own memory.</small>
          </span>
        </label>
      )}
      {!unified && vendor !== "none" && (
        <Field label="Graphics memory, GB" hint="Printed on the box, or in your system info.">
          {(id) => <Input id={id} inputMode="numeric" value={vram} onChange={(e) => setVram(e.target.value)} placeholder="24" />}
        </Field>
      )}
      <Field label={unified ? "Memory, GB" : "System memory, GB"}>{(id) => <Input id={id} inputMode="numeric" value={ram} onChange={(e) => setRam(e.target.value)} placeholder="64" />}</Field>
      <Field label="Free disk space, GB">{(id) => <Input id={id} inputMode="numeric" value={disk} onChange={(e) => setDisk(e.target.value)} placeholder="200" />}</Field>
      <div className="field--wide" style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        {onCancel && <Button onClick={onCancel}>Cancel</Button>}
        <Button type="submit" variant="primary" disabled={!valid} busy={busy}>
          Use these numbers
        </Button>
      </div>
    </form>
  );
}

/** Why a machine that was set up is back in setup: the engine says what is missing or out of date. */
function SetupAgain() {
  const { status, onboarding } = useEngineState();
  if (!onboarding?.done || status?.phase !== "not_installed" || !status.error) return null;
  return (
    <div className="ob__notice">
      <Notice title="Setup needs to run again">{status.error}</Notice>
    </div>
  );
}

function osName(os: HardwareProfile["os"]): string {
  return os === "macos" ? "macOS" : os === "windows" ? "Windows" : "Linux";
}
function archName(arch: string, os: HardwareProfile["os"]): string {
  if (/arm|aarch/i.test(arch)) return os === "macos" ? "Apple Silicon" : "ARM";
  return "Intel or AMD";
}

// ---------------------------------------------------------------- tier

function Tier({ hardware, onBack }: { hardware: HardwareProfile; onBack: () => void }) {
  const runtimeDemo = useDemoMode();
  const { client, install } = useEngine();
  const { settings } = useEngineState();
  const savedLimit = settings?.memoryLimitGb ?? null;
  const [tiers, setTiers] = useState<TierSummary[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const [memory, setMemory] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAlts, setShowAlts] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const loadTiers = useCallback(async () => {
    setTiers(null);
    setLoadError(false);
    try {
      const t = await client.tiers();
      setTiers(t);
      const rec = t.find((x) => x.recommended) ?? t.find((x) => fits(x, hardware));
      setChosen(rec?.tier ?? null);
    } catch {
      setLoadError(true);
    }
  }, [client, hardware]);

  useEffect(() => {
    void loadTiers();
  }, [loadTiers]);

  const demo = runtimeDemo || plan?.simulated === true;
  const tier = tiers?.find((t) => t.tier === chosen) ?? null;
  const gpu = hardware.gpus[0];
  // The pool other apps compete for: shared memory on unified machines, system memory next to a discrete card.
  const total = hardware.ramGb;
  const peakMax = Math.max(...Object.values(tier?.estimates ?? {}).map((e) => e?.peakGb ?? 0), 4);
  const minMem = Math.min(total, gpu?.unifiedMemory ? Math.ceil(peakMax) : Math.max(8, tier?.match.minRamGb ?? 8));

  useEffect(() => {
    if (!tier) return;
    setPlan(null);
    let active = true;
    void client
      .installPlan(tier.tier)
      .then((p) => {
        if (active) setPlan(p);
      })
      .catch((e) => {
        if (active) toast({ title: "Couldn't check setup", text: String(e), tone: "bad" });
      });
    // A limit the user chose before stays when they set up again; the tier's default is for a first setup.
    const def = savedLimit ?? tier.defaultMemoryLimitGb ?? Math.round(total * 0.8);
    setMemory(Math.min(total, Math.max(minMem, def)));
    return () => {
      active = false;
    };
  }, [tier, client, total, minMem, savedLimit]);

  const fitting = useMemo(() => (tiers ?? []).filter((t) => fits(t, hardware)), [tiers, hardware]);
  const recommended = tiers?.find((t) => t.recommended) ?? fitting[0] ?? null;

  if (loadError || tiers?.length === 0) {
    return (
      <div className="ob__step">
        <Rise i={0} className="ob__head">
          <h1 className="ob__title">Couldn't load the setups</h1>
          <p className="ob__lead">Nightshift couldn't find its setups.</p>
        </Rise>
        <Actions
          step="tier"
          quiet={
            <button type="button" className="ob__quiet" onClick={onBack}>
              Back
            </button>
          }
        >
          <Button variant="primary" size="l" className="ob__cta" onClick={() => void loadTiers()}>
            Retry
          </Button>
        </Actions>
      </div>
    );
  }

  if (!tiers)
    return (
      <div className="ob__step" aria-busy="true">
        <Rise i={0} className="ob__head ob__head--wait">
          <span className="spin" aria-hidden />
          <p className="ob__lead">Picking your setup</p>
        </Rise>
      </div>
    );

  if (!recommended) {
    return (
      <div className="ob__step">
        <Rise i={0} className="ob__head">
          <h1 className="ob__title">This machine can't run Nightshift yet</h1>
          <p className="ob__lead">It needs a graphics chip with 8 GB, or an Apple Silicon Mac with 16 GB. {gpu && gpu.vramGb > 0 ? `This one has ${gb(gpu.vramGb)}.` : "This one doesn't have one it can use."}</p>
          <p className="ob__fine">Go back to enter your hardware by hand, or use a GPU computer on your network.</p>
        </Rise>
        <Actions step="tier">
          <Button variant="primary" size="l" className="ob__cta" onClick={onBack}>
            Back
          </Button>
        </Actions>
      </div>
    );
  }

  const canRemaster = tier?.steps ? tier.steps.includes("video_final_remaster") : true;
  const timedSteps = (["still", "video_draft", "video_final_same_take", "video_final_remaster", "voice", "music"] as const).filter((step) => !tier?.steps || tier.steps.includes(step));
  const measured = timedSteps.length > 0 && timedSteps.every((step) => validSeconds(tier?.estimates?.[step]?.seconds) && tier?.estimates?.[step]?.measured);

  return (
    <div className="ob__step">
      <Rise i={0} className="ob__head">
        <h1 className="ob__title">{tier ? headlineFor(tier, recommended) : ""}</h1>
        <p className="ob__lead">{tier && tier.tier !== recommended.tier ? "Downloads less, renders a bit softer." : "Nightshift picks the models. You never have to."}</p>
      </Rise>
      <SetupAgain />
      {tier && (
        <>
          <Rise i={1} className="ob__card">
            <div className="ob__card-head">
              <div>
                <b>{tierName(tier, recommended)}</b>
                <small>{tierFor(tier)}</small>
              </div>
              <Tag tone={measured ? "ok" : undefined} outline={!measured}>
                {measured ? "Tested" : "Estimated"}
              </Tag>
            </div>
            <div className="ob__card-body">
              <div className="ob__times">
                <Time icon={<Image />} label="Still" v={est(tier, "still")} />
                <Time icon={<Film />} label="Draft" v={est(tier, "video_draft")} />
                <Time icon={<Sparkles />} label="Final" v={est(tier, "video_final_same_take")} />
                <Time icon={<Wand2 />} label="Remaster" v={canRemaster ? est(tier, "video_final_remaster") : ""} off={!canRemaster} />
                <Time icon={<Mic />} label="Voice" v={est(tier, "voice")} />
                <Time icon={<Music />} label="Song" v={est(tier, "music")} />
              </div>
            </div>
            <div className="ob__card-body">
              <div className="ob__row-head">
                <b>{demo ? "Demo setup" : "Download"}</b>
                <span>{demo ? "Nothing is downloaded" : plan ? `${gb(plan.totalDownloadGb)} of ${gb(plan.freeDiskGb)} free` : "Checking"}</span>
              </div>
              {plan && !demo && <DiskBar plan={plan} />}
              {!demo && plan?.downloads
                .filter((d) => d.id.startsWith("editor-"))
                .map((d) => (
                  <div key={d.id} className="insp__kv">
                    <span>{editorDownloadLabel(d.id)}</span>
                    <b>{gb(d.sizeGb)}</b>
                  </div>
                ))}
              {plan?.notes?.map((note, i) => (
                <p className="t-small t-muted" key={i}>
                  {note}
                </p>
              ))}
            </div>
            <div className="ob__card-body">
              <div className="ob__row-head">
                <b>Leave room for other apps</b>
                <span>
                  {gb(memory ?? 0)} of {gb(total)}
                </span>
              </div>
              <Slider value={memory ?? minMem} min={minMem} max={total} step={1} onChange={setMemory} label="Memory limit" />
              <div className="mem__scale">
                <span>{gb(minMem)}, slower</span>
                <span>{gb(total)}, everything</span>
              </div>
            </div>
            <div className="ob__card-body">
              <button type="button" className="ob__row-head ob__toggle" onClick={() => setShowAlts((v) => !v)} aria-expanded={showAlts}>
                <b>Other setups</b>
                <span>{showAlts ? <ChevronDown /> : <ChevronRight />}</span>
              </button>
              {showAlts && (
                <div className="alts" role="radiogroup" aria-label="Other setups">
                  {tiers
                    .filter((t) => t.match.vendor === gpu?.vendor)
                    .map((t) => {
                      const ok = fitting.some((f) => f.tier === t.tier);
                      return (
                        <button key={t.tier} type="button" role="radio" className="alt" aria-checked={t.tier === chosen} disabled={!ok} onClick={() => setChosen(t.tier)}>
                          <span>
                            <div className="alt__name">
                              {tierName(t, recommended)}
                              {t.recommended ? ", recommended" : ""}
                            </div>
                            <div className="alt__why">{ok ? (t.tier === recommended.tier ? "Best fit for this machine" : "Fewer gigabytes, softer renders") : whyNot(t, hardware)}</div>
                          </span>
                          <span className="alt__size">{gb(t.downloadGb)}</span>
                        </button>
                      );
                    })}
                </div>
              )}
            </div>
          </Rise>
          {plan && !plan.fits && (
            <div className="ob__notice"><Notice tone="bad" title="Not enough free disk space">
              This setup needs {gb(plan.totalDownloadGb)} plus a little room to work. You have {gb(plan.freeDiskGb)} free. Free about {gb(Math.ceil(plan.totalDownloadGb + 8 - plan.freeDiskGb))}, or pick a lighter setup.
            </Notice></div>
          )}
        </>
      )}
      <Actions
        step="tier"
        quiet={
          <button type="button" className="ob__quiet" onClick={onBack}>
            Back
          </button>
        }
      >
        <Button
          variant="primary"
          size="l"
          className="ob__cta"
          disabled={!plan || !plan.fits}
          busy={busy}
          onClick={async () => {
            if (!tier) return;
            setBusy(true);
            try {
              await install(tier.tier, memory);
            } catch (e) {
              toast({ title: "Couldn't start setup", text: e instanceof Error ? e.message : String(e), tone: "bad" });
              setBusy(false);
            }
          }}
        >
          {demo ? "Try the demo" : plan ? (plan.totalDownloadGb > 0 ? `Download ${gb(plan.totalDownloadGb)}` : "Set up") : "Checking your disk"}
        </Button>
      </Actions>
    </div>
  );
}

function Time({ icon, label, v, off }: { icon: ReactNode; label: string; v: string; off?: boolean }) {
  return (
    <div className={cx("ob__time", off && "ob__time--off")}>
      {icon}
      {off ? (
        <b className="ob__time-na" title="Not on this machine">
          None
        </b>
      ) : (
        <b>{v || "Not measured"}</b>
      )}
      <span>{label}</span>
    </div>
  );
}

function est(t: TierSummary, step: keyof NonNullable<TierSummary["estimates"]>): string {
  const e = t.estimates?.[step];
  return validSeconds(e?.seconds) ? `~${shortDuration(e.seconds)}` : "";
}

function validSeconds(seconds: number | undefined): seconds is number {
  return seconds !== undefined && Number.isFinite(seconds) && seconds > 0;
}

function fits(t: TierSummary, hw: HardwareProfile): boolean {
  const gpu = hw.gpus[0];
  if (!gpu) return false;
  if (gpu.vendor !== t.match.vendor) return false;
  if (t.match.unifiedMemory !== undefined && gpu.unifiedMemory !== t.match.unifiedMemory) return false;
  if (gpu.vramGb < t.match.minVramGb) return false;
  if (t.match.maxVramGb !== undefined && gpu.vramGb > t.match.maxVramGb) return false;
  return hw.ramGb >= t.match.minRamGb;
}

function whyNot(t: TierSummary, hw: HardwareProfile): string {
  const gpu = hw.gpus[0];
  if (!gpu || gpu.vendor !== t.match.vendor) return "For a different kind of graphics chip";
  if (gpu.vramGb < t.match.minVramGb) return `Needs ${gb(t.match.minVramGb)} of graphics memory`;
  if (hw.ramGb < t.match.minRamGb) return `Needs ${gb(t.match.minRamGb)} of memory`;
  return "For a different kind of machine";
}

function headlineFor(t: TierSummary, rec: TierSummary): string {
  const remaster = t.steps ? t.steps.includes("video_final_remaster") : true;
  if (t.tier !== rec.tier) return "A lighter setup";
  if (remaster && t.downloadGb >= 80) return "This machine can do all of it";
  if (remaster) return "This machine can do all of it";
  return "This machine can draft and finish";
}

function DiskBar({ plan }: { plan: InstallPlan }) {
  const free = Math.max(plan.freeDiskGb, 1);
  const newPct = Math.min(100, (plan.totalDownloadGb / free) * 100);
  return (
    <>
      <div className="disk" aria-hidden>
        <div className={cx("disk__new", !plan.fits && "disk__new--over")} style={{ width: `${newPct}%` }} />
      </div>
      <div className="disk__legend">
        <span>
          <i style={{ background: plan.fits ? "var(--accent)" : "var(--bad)" }} />
          Download, {gb(plan.totalDownloadGb)}
        </span>
        <span>
          <i style={{ background: "var(--track)" }} />
          Free after, {gb(Math.max(0, plan.freeDiskGb - plan.totalDownloadGb))}
        </span>
        {plan.alreadyPresent.length > 0 && <span>{plan.alreadyPresent.length} files already here</span>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- install

/** The big number over a step's progress: a percentage, or the mark while there is nothing to count. */
function Meter({ frac, bad }: { frac: number | null; bad?: boolean }) {
  return (
    <div className={cx("ob__meter", bad && "ob__meter--bad")}>
      {frac === null || bad ? <Mark size={56} className="ob__mark" /> : <span className="ob__meter-num">{Math.round(Math.max(0, Math.min(1, frac)) * 100)}%</span>}
    </div>
  );
}

/** A thin bar under a step. `frac` null slides; `bad` stops it. */
function StepBar({ frac, bad, night }: { frac: number | null; bad?: boolean; night?: boolean }) {
  const f = frac === null ? 0 : Math.max(0, Math.min(1, frac));
  return (
    <div className={cx("bar ob__bar", frac === null && !bad && "bar--indeterminate", bad && "ob__bar--bad", night && "bar--night")} role="progressbar" aria-valuenow={frac === null ? undefined : Math.round(f * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className="bar__fill" style={frac === null || bad ? undefined : { width: `${f * 100}%` }} />
    </div>
  );
}

function Install() {
  const demo = useDemoMode();
  const { status, settings, install: progress } = useEngineState();
  const { install } = useEngine();
  const startRef = useRef<{ t: number; gb: number } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const error = status?.phase === "error" ? status.error : null;
  const remote = !!settings?.remote;
  const remoteName = settings?.remote?.name ?? settings?.remote?.url ?? "";

  useEffect(() => {
    if (!progress) return;
    if (!startRef.current || progress.doneGb < startRef.current.gb) startRef.current = { t: progress.updatedAt, gb: progress.doneGb };
  }, [progress]);

  const done = progress?.doneGb ?? 0;
  const total = progress?.totalGb ?? 0;
  const frac = total > 0 ? Math.min(1, done / total) : 0;
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const { client } = useEngine();
  useEffect(() => {
    if (settings?.tier && !plan) void client.installPlan(settings.tier).then(setPlan).catch(() => undefined);
  }, [settings?.tier, plan, client]);
  const fileCount = plan ? plan.downloads.length + plan.alreadyPresent.length : 0;
  const filesDone = plan && progress ? plan.alreadyPresent.length + plan.downloads.filter((d) => d.id !== progress.modelId && cumulative(plan, d.id) <= progress.doneGb + 0.05).length : 0;
  let eta = "";
  if (progress && startRef.current && done > startRef.current.gb + 0.2) {
    const elapsed = (progress.updatedAt - startRef.current.t) / 1000;
    const rate = (done - startRef.current.gb) / Math.max(1, elapsed);
    const left = (total - done) / Math.max(rate, 0.001);
    eta = `${roughDuration(left)} left`;
  }
  const known = demo || total > 0;

  return (
    <div className="ob__step">
      <Rise i={0}>
        <Meter frac={known ? frac : null} bad={!!error} />
      </Rise>
      <Rise i={1} className="ob__head">
        <h1 className="ob__title">{demo ? (error ? "Demo setup stopped" : "Setting up the demo") : remote ? (error ? "Connecting stopped" : `Connecting to ${remoteName}`) : error ? "The download stopped" : "Downloading your setup"}</h1>
        <p className="ob__lead">{demo ? "Nothing is downloaded." : remote ? "Setting up the link. No models are downloaded here." : error ? "Finished files stay on disk. Trying again picks up where it stopped." : "Minimize this window and come back. Finished files stay if you quit."}</p>
      </Rise>
      {error ? (
        <div className="ob__notice"><Notice tone="bad" title="Stopped">
          {error}
        </Notice></div>
      ) : (
        <Rise i={2} className="ob__progress">
          <StepBar frac={known ? frac : null} />
          <div className="ob__status">
            <span className="pulse" />
            <span>{demo ? "Simulating setup" : (progress?.message ?? "Connecting")}</span>
            {known && !demo && <span className="t-muted">, {gb(done)} of {gb(total)}</span>}
            {!demo && eta && <span className="t-muted">, {eta}</span>}
            {!demo && fileCount > 0 && (
              <span className="t-muted">
                , {Math.min(filesDone, fileCount)} of {fileCount} files
              </span>
            )}
          </div>
        </Rise>
      )}
      <Actions step="install">
        {error && (
          <Button
            variant="primary"
            size="l"
            className="ob__cta"
            busy={retrying}
            onClick={async () => {
              if (!settings?.tier) return;
              setRetrying(true);
              try {
                await install(settings.tier, settings.memoryLimitGb);
              } catch (e) {
                toast({ title: "Still can't download", text: e instanceof Error ? e.message : String(e), tone: "bad" });
              } finally {
                setRetrying(false);
              }
            }}
          >
            Try again
          </Button>
        )}
      </Actions>
    </div>
  );
}

/** Gigabytes downloaded once this file is complete, assuming the plan's order. */
function cumulative(plan: InstallPlan, modelId: string): number {
  let sum = 0;
  for (const d of plan.downloads) {
    sum += d.sizeGb;
    if (d.id === modelId) return sum;
  }
  return sum;
}

function Starting() {
  const demo = useDemoMode();
  const { settings } = useEngineState();
  const remote = !!settings?.remote;
  const remoteName = settings?.remote?.name ?? settings?.remote?.url ?? "";
  return (
    <div className="ob__step">
      <Rise i={0}>
        <Meter frac={null} />
      </Rise>
      <Rise i={1} className="ob__head">
        <h1 className="ob__title">Starting the engine</h1>
        <p className="ob__lead">{demo ? "Preparing your sample shot." : remote ? `Opening the link to ${remoteName}.` : "The first start takes a little longer."}</p>
      </Rise>
      <Rise i={2} className="ob__progress">
        <StepBar frac={null} />
        <div className="ob__status">
          <span className="pulse" />
          <span>Warming up</span>
        </div>
      </Rise>
      <Actions step="starting" />
    </div>
  );
}

// ---------------------------------------------------------------- first shot

function FirstShot() {
  const demo = useDemoMode();
  const nav = useNavigate();
  const { startSample, finishOnboarding, storyboard, draft, client } = useEngine();
  const { onboarding, status, settings } = useEngineState();
  const [answer, setAnswer] = useState<"waiting" | "ok" | "failed">("waiting");
  const [leaving, setLeaving] = useState(false);
  const pid = onboarding?.sampleProjectId ?? null;
  const project = useProject(pid ?? undefined);
  const jobs = useJobs();
  // Where the final only upscales the draft, the copy says that, not "sharpens".
  const upscale = upscaleOnly(useInstalledTier());

  const ask = useCallback(
    async (again = false) => {
      try {
        await startSample(again);
        setAnswer("ok");
      } catch (e) {
        setAnswer("failed");
        toast({ title: "Couldn't start the first shot", text: e instanceof Error ? e.message : String(e), tone: "bad" });
      }
    },
    [startSample],
  );

  // The engine makes the sample once per data dir and runs it: shot list, still, then a motion draft. Asking again
  // after a remount, a reconnect or from a second window gets the same project back and starts nothing new.
  useEffect(() => {
    void ask();
  }, [ask]);

  const shot = project?.shots[0];
  const best = project && shot ? bestAssetFor(project, shot) : undefined;
  const shotJobs = jobs.filter((j) => j.projectId === pid);
  const active = shotJobs.find((j) => j.status === "running") ?? shotJobs.find((j) => j.status === "queued");
  const latest = shotJobs.filter((j) => j.status !== "cancelled").at(-1);
  const failed = latest?.status === "failed" ? latest : undefined;
  const now = useNow(1000, !!active);
  const deleted = answer === "ok" && pid !== null && !project;
  // From the project's start to its draft, so the time holds however often this screen was opened in between.
  const drafted = shotJobs.find((j) => j.step === "video_draft" && j.status === "done")?.finishedAt;
  const elapsed = project && drafted ? Math.max(1, Math.round((Date.parse(drafted) - Date.parse(project.createdAt)) / 1000)) : null;

  const finish = async (to: string) => {
    setLeaving(true);
    try {
      await finishOnboarding();
      nav(to, { replace: to === "/" });
    } catch (e) {
      setLeaving(false);
      toast({ title: "Couldn't finish setup", text: e instanceof Error ? e.message : String(e), tone: "bad" });
    }
  };

  const stage = best?.rung === "draft" ? "done" : best?.rung === "still" ? "draft" : "still";
  const remoteName = status?.mode === "remote" && settings?.remote ? (settings.remote.name ?? settings.remote.url) : null;

  return (
    <div className="ob__step ob__step--wide">
      <Rise i={0} className="ob__head">
        <h1 className="ob__title">{stage === "done" ? (demo ? "Your demo shot" : remoteName ? `${remoteName} made this` : "Your machine made this") : "Your first shot"}</h1>
        <p className="ob__lead">{stage === "done" ? `A still, then a motion draft, in ${elapsed ? shortDuration(elapsed) : "under a minute"}. ${upscale ? `A final upscales the take you like${upscale.to}` : "A final sharpens the take you like"}, now or overnight.` : `A lighthouse in a storm, camera pushing in. Made ${remoteName ? `on ${remoteName}` : "on your machine"} while you watch.`}</p>
      </Rise>
      <Rise i={1} className={cx("frame ob__shot", frameClass("16:9"), !best && "frame--empty", active && best?.rung !== "draft" && "frame--working", stage === "done" && "ob__shot--done")}>
        {best && <Media src={client.assetUrl(project!.id, best.asset.id)} kind={best.rung === "still" ? "image" : "video"} playing durationSec={shot?.durationSec} />}
        {best && best.rung === "draft" && (
          <div className="frame__corner">
            <Tag onMedia>Draft</Tag>
          </div>
        )}
        {active && (
          <div className="frame__progress">
            <div style={{ width: `${active.progress * 100}%` }} />
          </div>
        )}
      </Rise>
      <Rise i={2} className="ob__status">
        {deleted ? (
          <div className="ob__notice">
            <Notice
              title="The sample shot was deleted"
              actions={
                <Button size="s" onClick={() => void ask(true)}>
                  Make it again
                </Button>
              }
            >
              Make it again, or start a project of your own.
            </Notice>
          </div>
        ) : answer === "failed" && !project ? (
          <div className="ob__notice">
            <Notice
              tone="bad"
              title="That didn't work"
              actions={
                <Button size="s" onClick={() => void ask()}>
                  Try again
                </Button>
              }
            >
              Nightshift couldn't start the first shot.
            </Notice>
          </div>
        ) : failed && !active ? (
          <div className="ob__notice"><Notice tone="bad" title="That didn't work">
            {failureText(failed)}
            <div className="notice__actions">
              <Button size="s" onClick={() => project && (shot?.stillAssetId ? void draft(project.id, shot.id) : void storyboard(project.id))}>
                Try again
              </Button>
            </div>
          </Notice></div>
        ) : active ? (
          <>
            <span className="pulse" />
            <span>
              {/* The text step's stage is "Writing" too, so only its time follows. */}
              {active.step === "text"
                ? ["Writing the shot", jobElapsed(active, now)].filter(Boolean).join(", ")
                : `${active.step === "still" ? "Making the still" : "Making the motion draft"}, ${jobStatusLine(active, now).toLowerCase()}`}
            </span>
          </>
        ) : stage === "done" ? (
          // A dot on this line means something is running; a finished draft and a wait before it have none.
          <span>
            <b>Draft ready.</b> {upscale ? `The final upscales it${upscale.to}.` : "Soft on purpose. The final sharpens it."}
          </span>
        ) : (
          <span>Getting ready</span>
        )}
      </Rise>
      <Actions
        step="first"
        quiet={
          stage === "done" && project ? (
            <button type="button" className="ob__quiet" disabled={leaving} onClick={() => void finish(`/p/${project.id}/takes`)}>
              Open this shot
            </button>
          ) : null
        }
      >
        <Button variant="primary" size="l" className="ob__cta" onClick={() => void finish("/")} disabled={answer === "waiting" && !project} busy={leaving}>
          {stage === "done" ? "Start creating" : "Skip ahead"}
        </Button>
      </Actions>
    </div>
  );
}

export type { Project };

function editorDownloadLabel(id: string): string {
  if (/vad|voice/.test(id)) return "Voice detection";
  if (/whisper|caption/.test(id)) return "Captions model";
  if (/browser|chrome/.test(id)) return "Render browser";
  return "Video export tools";
}
