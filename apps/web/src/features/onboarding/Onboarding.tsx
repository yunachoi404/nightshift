import type { HardwareProfile, InstallPlan, Job, Project, TierSummary } from "@nightshift/contract";
import { Check, ChevronDown, ChevronRight, Cpu, Film, FolderOpen, HardDrive, Image, MemoryStick, Mic, Monitor, Music, PenLine, Search, Sparkles, Wand2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { isBrowserDemo, isDevMock } from "@/api/config";
import { getMockEngine } from "@/api/mock/engine";
import { ApiError } from "@/api/client";
import { useEngine, useEngineState, useJobs, useProject } from "@/store/engine";
import { Button, Field, Input, Notice, Segmented, Select, Slider, Tag, cx, toast } from "@/ui/primitives";
import { Mark } from "@/ui/Mark";
import { gb, roughDuration, shortDuration } from "@/lib/format";
import { Media } from "@/media/Media";
import { demoSwitch, enterDemo, leaveDemo, useDemoMode, useDemoSwitch } from "@/store/demo";
import { isMac, machineName, tierFor, tierName, upscaleOnly, useInstalledTier, useTiers } from "@/store/tier";
import { RemoteSetup } from "@/features/compute/RemoteSetup";
import { WelcomeTour } from "./WelcomeTour";
import { bestAssetFor, failureText, frameClass, jobElapsed, jobStatusLine } from "@/features/project/helpers";
import { draftStepFor } from "@/features/project/draftSteps";
import { useNow } from "@/lib/useNow";
import { SAMPLE_STEPS, sampleEstimates, sampleTimeLine, type SampleStep } from "./firstShot";
import "./onboarding.css";
import { publicUrl } from "@/lib/publicUrl";

type Step = "welcome" | "detect" | "tier" | "install" | "starting" | "first";

/** A setup and its memory limit, as the user chose them. A null limit is the setup's default. */
interface Choice {
  tier: string;
  memoryLimitGb: number | null;
}

/** The dots under each step. Welcome is before the first dot; starting shares install's. */
const dotSteps: Step[] = ["detect", "tier", "install", "first"];

export function Onboarding({ onDev }: { onDev: () => void }) {
  const { status, onboarding } = useEngineState();
  const { install } = useEngine();
  // Someone who has been through setup before (say, after leaving a GPU computer) skips the welcome, and so does someone
  // who just chose to look around first: they come back to it with Back.
  const [local, setLocal] = useState<Step>(() => (onboarding?.done || demoSwitch(status?.mode).canLeave ? "detect" : "welcome"));
  const [hardware, setHardware] = useState<HardwareProfile | null>(null);
  // What the user chose: the setup card shows it, Download installs it, and after an install stops, Try again installs it
  // again and Back comes back to it. Until they choose in this window (say, after a reload), it is the setup the engine
  // was last asked for, at its default limit.
  const [chosen, setChosen] = useState<Choice | null>(null);
  const choice: Choice | null = chosen ?? (status?.tier ? { tier: status.tier, memoryLimitGb: null } : null);
  // A failed install stays an error in the engine until the next one. Going back from it shows the setup steps.
  const [repick, setRepick] = useState(false);

  const phase = status?.phase ?? "not_installed";
  useEffect(() => {
    if (phase !== "error") setRepick(false);
  }, [phase]);
  const step: Step = phase === "installing" || (phase === "error" && !repick) ? "install" : phase === "starting" ? "starting" : phase === "ready" ? "first" : local;
  const startInstall = async (c: Choice) => {
    setChosen(c);
    await install(c.tier, c.memoryLimitGb);
  };

  return (
    <div className="ob">
      <div className="ob__strip drag">
        {isDevMock() && (
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
        {step === "tier" && hardware && <Tier key="tier" hardware={hardware} choice={choice} onChoose={setChosen} onInstall={startInstall} onBack={() => setLocal("detect")} />}
        {step === "install" && (
          <Install
            key="install"
            choice={choice}
            onInstall={startInstall}
            onBack={() => {
              setRepick(true);
              // Back to the setup card, on what the user chose. A window opened on the failure has not read the hardware.
              setLocal(hardware ? "tier" : "detect");
            }}
          />
        )}
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
      <img src={publicUrl(`welcome/chip-${img}.jpg`)} alt="" />
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
          <span className="ob__fine">{demo ? "Sample renders. Nothing is downloaded." : "Setup is mostly one large download."}</span>
          <DemoChoice />
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

/**
 * "Look around first": the demo, with sample renders and its own data, never mixed with a real setup. In the demo the
 * user chose, the way back to a real setup. Quiet, under the step's main action. See store/demo.ts.
 */
function DemoChoice() {
  const sw = useDemoSwitch();
  const [busy, setBusy] = useState(false);
  if (!sw.canEnter && !sw.canLeave) return null;
  const go = async () => {
    setBusy(true);
    try {
      // The Mac app opens again in the other mode, and a browser reloads: either way this page goes away.
      await (sw.canEnter ? enterDemo() : leaveDemo());
    } catch (e) {
      setBusy(false);
      toast({ title: sw.canEnter ? "Couldn't open the demo" : "Couldn't leave the demo", text: e instanceof Error ? e.message : String(e), tone: "bad" });
    }
  };
  return (
    <button type="button" className="ob__linkbtn" disabled={busy} onClick={() => void go()}>
      {busy ? (sw.canEnter ? "Opening the demo" : "Opening setup") : sw.canEnter ? "Look around first, with sample renders" : "Set up for real instead"}
    </button>
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
  // A browser can't read the machine it runs on: the browser demo shows sample machines, the tested ones first.
  const sample = isBrowserDemo();
  const [machine, setMachine] = useState(() => (sample ? getMockEngine().dev.preset : ""));

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
        <h1 className="ob__title">{where === "remote" ? "A GPU computer on your network" : error || manual ? "Tell Nightshift about this machine" : sample ? "Here's a sample machine" : done ? "Here's what you've got" : "Looking at your machine"}</h1>
        <p className="ob__lead">{where === "remote" ? "Renders go there. Projects stay here." : error ? "It couldn't read the hardware. Fill in the basics." : manual ? "Models and settings are picked for this exact hardware." : sample ? "A browser can't read your machine. Each of these gets its own setup." : "Models and settings picked for this exact hardware."}</p>
      </Rise>
      {where === "local" && <SetupAgain />}

      {where === "local" && sample && !manual && (
        <Rise i={2} className="ob__machines">
          <Segmented
            label="Sample machine"
            value={machine}
            onChange={(v) => {
              setMachine(v);
              getMockEngine().setDev({ preset: v });
              void detect();
            }}
            options={sampleMachines.map(([value, label]) => ({ value, label }))}
          />
        </Rise>
      )}
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
                {sample ? "Enter your own machine" : "Not right? Enter it yourself"}
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

/** The browser demo's machines: the two tested ones, then two Macs whose setups are estimates. */
const sampleMachines: Array<[preset: string, label: string]> = [
  ["spark", "DGX Spark"],
  ["rtx2080", "RTX 2080 Super PC"],
  ["m4max", "MacBook Pro, M4 Max"],
  ["air16", "MacBook Air, 16 GB"],
];

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

/**
 * Why setup is back on screen, in the engine's words: an install that stopped (the user went Back from it, say), or a
 * machine with a setup that now has something missing or out of date (after an update, say).
 */
function SetupAgain() {
  const { status, onboarding, settings } = useEngineState();
  if ((status?.phase !== "not_installed" && status?.phase !== "error") || !status.error) return null;
  return (
    <div className="ob__notice">
      {status.phase === "not_installed" && (onboarding?.done || settings?.tier) ? (
        <Notice title="Setup needs to run again">{status.error}</Notice>
      ) : (
        <Notice tone="bad" title="Setup stopped">
          {status.error}
        </Notice>
      )}
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

function Tier({ hardware, choice, onChoose, onInstall, onBack }: { hardware: HardwareProfile; choice: Choice | null; onChoose: (c: Choice) => void; onInstall: (c: Choice) => Promise<void>; onBack: () => void }) {
  const runtimeDemo = useDemoMode();
  const sw = useDemoSwitch();
  const { client } = useEngine();
  const { settings } = useEngineState();
  const savedLimit = settings?.memoryLimitGb ?? null;
  const [tiers, setTiers] = useState<TierSummary[] | null>(null);
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAlts, setShowAlts] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const loadTiers = useCallback(async () => {
    setTiers(null);
    setLoadError(false);
    try {
      const t = await client.tiers();
      setTiers(t);
    } catch {
      setLoadError(true);
    }
  }, [client]);

  useEffect(() => {
    void loadTiers();
  }, [loadTiers]);

  const demo = runtimeDemo || plan?.simulated === true;
  const fitting = useMemo(() => (tiers ?? []).filter((t) => runsHere(t, hardware)), [tiers, hardware]);
  const recommended = tiers?.find((t) => t.recommended) ?? fitting[0] ?? null;
  // The setup the user chose, then the one installed here, then the recommended one: setting up again after an update or
  // a failed install must not switch them to another setup.
  const tier = [choice?.tier, settings?.tier].map((id) => fitting.find((t) => t.tier === id)).find(Boolean) ?? recommended;
  const gpu = hardware.gpus[0];
  // The pool other apps compete for: shared memory on unified machines, system memory next to a discrete card.
  const total = hardware.ramGb;
  const peakMax = Math.max(...Object.values(tier?.estimates ?? {}).map((e) => e?.peakGb ?? 0), 4);
  const minMem = Math.min(total, gpu?.unifiedMemory ? Math.ceil(peakMax) : Math.max(8, tier?.match.minRamGb ?? 8));
  // The limit the user chose for this setup stays, then the one set up before; the setup's default is for a first setup.
  const limit = (choice?.tier === tier?.tier ? choice?.memoryLimitGb : null) ?? savedLimit ?? tier?.defaultMemoryLimitGb ?? Math.round(total * 0.8);
  const memory = tier ? Math.min(total, Math.max(minMem, limit)) : null;

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
    return () => {
      active = false;
    };
  }, [tier, client]);

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
    // The demo renders nothing, so it goes on with the lightest setup for this kind of machine.
    const stand = [...tiers].sort((a, b) => Number(b.match.vendor === gpu?.vendor) - Number(a.match.vendor === gpu?.vendor) || a.downloadGb - b.downloadGb)[0];
    return (
      <div className="ob__step">
        <Rise i={0} className="ob__head">
          <h1 className="ob__title">This machine can't run Nightshift yet</h1>
          <p className="ob__lead">It needs a graphics chip with 8 GB, or an Apple Silicon Mac with 16 GB. {gpu && gpu.vramGb > 0 ? `This one has ${gb(gpu.vramGb)}.` : "This one doesn't have one it can use."}</p>
          <p className="ob__fine">
            {demo && stand
              ? `The demo can still show you around, with sample renders and the ${tierName(stand, stand)} setup.`
              : sw.canEnter
                ? "Look around with sample renders, use a GPU computer on your network, or go back to enter your hardware by hand."
                : "Go back to enter your hardware by hand, or use a GPU computer on your network."}
          </p>
        </Rise>
        <Actions
          step="tier"
          quiet={
            demo || sw.canEnter ? (
              <button type="button" className="ob__quiet" onClick={onBack}>
                Back
              </button>
            ) : null
          }
        >
          {demo && stand ? (
            <Button
              variant="primary"
              size="l"
              className="ob__cta"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onInstall({ tier: stand.tier, memoryLimitGb: null });
                } catch (e) {
                  toast({ title: "Couldn't start the demo", text: e instanceof Error ? e.message : String(e), tone: "bad" });
                  setBusy(false);
                }
              }}
            >
              Continue with sample renders
            </Button>
          ) : sw.canEnter ? (
            <Button
              variant="primary"
              size="l"
              className="ob__cta"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await enterDemo();
                } catch (e) {
                  toast({ title: "Couldn't open the demo", text: e instanceof Error ? e.message : String(e), tone: "bad" });
                  setBusy(false);
                }
              }}
            >
              Look around with sample renders
            </Button>
          ) : (
            <Button variant="primary" size="l" className="ob__cta" onClick={onBack}>
              Back
            </Button>
          )}
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
                <span>{demo ? "Nothing is downloaded" : plan ? (plan.totalDownloadGb > 0 ? `${gb(plan.totalDownloadGb)} of ${gb(plan.freeDiskGb)} free` : `Nothing to download, ${gb(plan.freeDiskGb)} free`) : "Checking"}</span>
              </div>
              {demo && <p className="t-small t-muted">A real setup on this machine downloads {gb(Math.max(0, tier.downloadGb - reusedGb(plan)))}.</p>}
              {plan && !demo && plan.totalDownloadGb > 0 && <DiskBar plan={plan} />}
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
            {plan && client.scanModels && hasModels(plan) && <FoundModels plan={plan} onPlan={setPlan} />}
            <div className="ob__card-body">
              <div className="ob__row-head">
                <b>Leave room for other apps</b>
                <span>
                  {gb(memory ?? 0)} of {gb(total)}
                </span>
              </div>
              {/* As in Settings: without it, "24 GB of 30 GB" reads as the room left for other apps. */}
              <p className="t-small t-muted">{gpu?.unifiedMemory ? "The most memory Nightshift may use. Lower is safer with other apps open, higher is faster." : "System memory Nightshift may use next to the graphics card. The card itself is used in full."}</p>
              <Slider value={memory ?? minMem} min={minMem} max={total} step={1} onChange={(v) => tier && onChoose({ tier: tier.tier, memoryLimitGb: v })} label="Memory limit" />
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
                        <button key={t.tier} type="button" role="radio" className="alt" aria-checked={t.tier === tier?.tier} disabled={!ok} onClick={() => t.tier !== tier?.tier && onChoose({ tier: t.tier, memoryLimitGb: null })}>
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
          <>
            <DemoChoice />
            <button type="button" className="ob__quiet" onClick={onBack}>
              Back
            </button>
          </>
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
              await onInstall({ tier: tier.tier, memoryLimitGb: memory });
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

/** Requirements match within 5%, as the engine matches them (MATCH_TOLERANCE in its recipes.ts). */
const MATCH_TOLERANCE = 0.95;

/**
 * Whether a setup runs on this machine. A recipe's upper bound only steers the engine's recommendation to the strongest
 * setup: a lighter setup still runs on a bigger machine, and is the way out when the recommended one is too big for the
 * disk.
 */
function runsHere(t: TierSummary, hw: HardwareProfile): boolean {
  const gpu = hw.gpus[0];
  if (!gpu) return false;
  if (gpu.vendor !== t.match.vendor) return false;
  if (t.match.unifiedMemory !== undefined && gpu.unifiedMemory !== t.match.unifiedMemory) return false;
  if (gpu.vramGb < t.match.minVramGb * MATCH_TOLERANCE) return false;
  return hw.ramGb >= t.match.minRamGb * MATCH_TOLERANCE;
}

function whyNot(t: TierSummary, hw: HardwareProfile): string {
  const gpu = hw.gpus[0];
  if (!gpu || gpu.vendor !== t.match.vendor) return "For a different kind of graphics chip";
  if (gpu.vramGb < t.match.minVramGb * MATCH_TOLERANCE) return `Needs ${gb(t.match.minVramGb)} of graphics memory`;
  if (hw.ramGb < t.match.minRamGb * MATCH_TOLERANCE) return `Needs ${gb(t.match.minRamGb)} of memory`;
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
        {/* Files found in other folders are counted under "Models you already have". */}
        {plan.alreadyPresent.length > (plan.reused?.length ?? 0) && <span>{plan.alreadyPresent.length - (plan.reused?.length ?? 0)} files already here</span>}
      </div>
    </>
  );
}

/** The GB a setup does not download because the files are already on this computer. */
function reusedGb(plan: InstallPlan | null): number {
  return (plan?.reused ?? []).reduce((sum, r) => sum + r.sizeGb, 0);
}

const isModel = (id: string) => !id.startsWith("editor-");

/** The setup downloads models to this machine (not attach or remote mode, where they are on the GPU computer). */
function hasModels(plan: InstallPlan): boolean {
  return plan.downloads.some((d) => isModel(d.id)) || !!plan.reused?.length || !!plan.scan;
}

/** "/Users/me/ComfyUI/…/split_files/text_encoders": a long folder keeps its first and last folders, cut between them. */
export function shortPath(path: string, max = 64): string {
  if (path.length <= max) return path;
  const sep = path.includes("/") ? "/" : "\\";
  const parts = path.split(sep);
  let tail = parts.pop()!;
  while (parts.length > 1 && tail.length + parts.at(-1)!.length + 1 <= max * 0.6) tail = `${parts.pop()}${sep}${tail}`;
  let head = parts.shift()!;
  while (parts.length && head.length + parts[0]!.length + tail.length + 3 <= max) head = `${head}${sep}${parts.shift()}`;
  if (!parts.length) return `${head}${sep}${tail}`;
  // One folder name longer than the room: cut inside it.
  return tail.length > max ? `…${tail.slice(-(max - 1))}` : `${head}${sep}…${sep}${tail}`;
}

const folderOf = (path: string) => path.replace(/[/\\][^/\\]*$/, "");

/**
 * Models this computer already has. A scan looks where ComfyUI keeps them (ComfyUI Desktop, ComfyUI in the home folder
 * or a portable folder, the folders an extra_model_paths.yaml names), in the Hugging Face cache and in folders the user
 * adds. A file matches by name and exact size. Setup checks each one before it uses it, and leaves it where it is.
 */
function FoundModels({ plan, onPlan }: { plan: InstallPlan; onPlan: (p: InstallPlan) => void }) {
  const { client } = useEngine();
  const [busy, setBusy] = useState<"scan" | "folder" | null>(null);
  const [typing, setTyping] = useState(false);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const pick = window.nightshiftDesktop?.pickFolder;
  const scan = plan.scan;
  const reused = plan.reused ?? [];
  const skipped = plan.reuseSkipped ?? [];
  const gone = skipped.filter((s) => s.reason === "missing");
  const failed = skipped.filter((s) => s.reason !== "missing");
  const files = plan.downloads.filter((d) => isModel(d.id)).length + plan.alreadyPresent.filter(isModel).length;
  const saved = reusedGb(plan);

  const run = async (kind: "scan" | "folder", folders?: string[]): Promise<boolean> => {
    setBusy(kind);
    setError(null);
    try {
      onPlan(await client.scanModels!({ tier: plan.tier, ...(folders ? { folders } : {}) }));
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(null);
    }
  };
  const addFolder = async (folder: string) => {
    if (await run("folder", [...(scan?.folders ?? []), folder])) {
      setTyping(false);
      setPath("");
    }
  };

  return (
    <div className="ob__card-body reuse">
      <div className="ob__row-head">
        <b>Models you already have</b>
        {scan && <span>{scan.searched.length === 1 ? "Looked in 1 folder" : `Looked in ${scan.searched.length} folders`}</span>}
      </div>
      {!scan ? (
        <p className="t-small t-muted">Already use ComfyUI? Nightshift can look for this setup's models on this computer and use them where they are, instead of downloading them again.</p>
      ) : reused.length > 0 ? (
        <p className="reuse__found">
          <Check aria-hidden />
          <span>
            <b>
              Found {reused.length} of {files} model files on this computer.
            </b>{" "}
            {gb(saved, saved < 10 ? 1 : 0)} less to download.
          </span>
        </p>
      ) : (
        <p className="t-small t-muted">None of this setup's model files are on this computer{scan.searched.length ? " in the usual places" : ""}. Add the folder where you keep your models if it is somewhere else.</p>
      )}
      {reused.length > 0 && <p className="t-small t-muted">Setup checks each file against its checksum before it uses it. Your files stay where they are and are never changed.</p>}
      {gone.length > 0 && (
        <Notice tone="bad" title={gone.length === 1 ? "A model found in another folder is gone" : `${gone.length} models found in other folders are gone`}>
          {gone.map((g) => g.name ?? g.id).join(", ")} {gone.length === 1 ? "is" : "are"} on the download list again. Scan again if you moved {gone.length === 1 ? "it" : "them"}.
        </Notice>
      )}
      {failed.map((f) => (
        <p className="t-small reuse__skip" key={f.id} title={f.path}>
          {f.name ?? f.id}: {f.reason === "mismatch" ? "the file on this computer did not match its checksum, so it is downloaded." : "this computer could not link to it, so it is downloaded."}
        </p>
      ))}
      {reused.length > 0 && (
        <>
          <button type="button" className="ob__row-head ob__toggle reuse__toggle" onClick={() => setShowFiles((v) => !v)} aria-expanded={showFiles}>
            <span>{showFiles ? "Hide the files" : reused.length === 1 ? "Show the file" : `Show the ${reused.length} files`}</span>
            <span>{showFiles ? <ChevronDown /> : <ChevronRight />}</span>
          </button>
          {showFiles && (
            <ul className="reuse__list">
              {reused.map((r) => (
                <li key={r.id}>
                  <span className="reuse__name">{r.name ?? r.path.split(/[/\\]/).pop()}</span>
                  <span className="reuse__size">{fileSize(r.sizeGb)}</span>
                  <small title={r.path}>{shortPath(folderOf(r.path))}</small>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {scan && scan.unreadable.length > 0 && (
        <p className="t-small t-muted" title={scan.unreadable.join("\n")}>
          Couldn't read {scan.unreadable.length === 1 ? `1 folder, ${shortPath(scan.unreadable[0]!, 48)}` : `${scan.unreadable.length} folders`}. Nightshift may need permission to open it.
        </p>
      )}
      {typing && (
        <form
          className="reuse__path"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) void addFolder(path.trim());
          }}
        >
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setTyping(false);
            }}
            placeholder="The folder with your models, like ~/ComfyUI"
            aria-label="Folder with models"
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
          <Button type="submit" busy={busy === "folder"} disabled={!path.trim() || busy !== null}>
            Scan
          </Button>
          <Button variant="quiet" onClick={() => (setTyping(false), setError(null))}>
            Cancel
          </Button>
        </form>
      )}
      {error && <p className="t-small reuse__skip">{error}</p>}
      {!typing && (
        <div className="reuse__actions">
          <Button size="s" icon={<Search />} busy={busy === "scan"} disabled={busy !== null} onClick={() => void run("scan")}>
            {busy === "scan" ? "Looking" : scan ? "Scan again" : "Scan for models"}
          </Button>
          <Button
            size="s"
            variant="quiet"
            icon={<FolderOpen />}
            disabled={busy !== null}
            onClick={async () => {
              if (!pick) return setTyping(true);
              const folder = await pick().catch(() => null);
              if (folder) await addFolder(folder);
            }}
          >
            {pick ? "Choose a folder" : "Add a folder"}
          </Button>
          {scan && scan.folders.length > 0 && (
            <span className="reuse__folders" title={scan.folders.join("\n")}>
              Also looks in {scan.folders.length === 1 ? shortPath(scan.folders[0]!, 40) : `${scan.folders.length} folders you added`}
            </span>
          )}
        </div>
      )}
    </div>
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

/**
 * The download, and where a failed one stops. The engine saves the tier only once it is installed, so during a first
 * install (and after one fails) the tier comes from the runtime's status.
 */
function Install({ choice, onInstall, onBack }: { choice: Choice | null; onInstall: (c: Choice) => Promise<void>; onBack: () => void }) {
  const demo = useDemoMode();
  const { status, settings, tiers, install: progress } = useEngineState();
  const startRef = useRef<{ t: number; gb: number } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const error = status?.phase === "error" ? status.error : null;
  const remote = !!settings?.remote;
  const remoteName = settings?.remote?.name ?? settings?.remote?.url ?? "";
  const tier = status?.tier ?? settings?.tier ?? null;
  // Again with the limit the user chose; after a reload, the saved one or the tier's default, as the setup card shows.
  const memoryLimitGb = (choice?.tier === tier ? choice.memoryLimitGb : null) ?? settings?.memoryLimitGb ?? tiers?.find((t) => t.tier === tier)?.defaultMemoryLimitGb ?? null;

  useEffect(() => {
    if (!progress) return;
    if (!startRef.current || progress.doneGb < startRef.current.gb) startRef.current = { t: progress.updatedAt, gb: progress.doneGb };
  }, [progress]);

  const done = progress?.doneGb ?? 0;
  const total = progress?.totalGb ?? 0;
  const frac = total > 0 ? Math.min(1, done / total) : 0;
  const [plan, setPlan] = useState<InstallPlan | null>(null);
  const { client } = useEngine();
  // The plan says which files are on disk. Asked again as each file starts, it counts them however late this window
  // opened in the install.
  const fileId = progress?.modelId ?? null;
  useEffect(() => {
    if (!tier) return;
    let active = true;
    void client
      .installPlan(tier)
      .then((p) => active && setPlan(p))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [tier, fileId, client]);
  // The models found on this computer are checked before anything is downloaded.
  const checking = !progress?.modelId && !!progress?.message.includes("already on this computer");
  const fileCount = plan ? plan.downloads.length + plan.alreadyPresent.length : 0;
  const filesDone = plan?.alreadyPresent.length ?? 0;
  let eta = "";
  if (progress && startRef.current && done > startRef.current.gb + 0.2) {
    const elapsed = (progress.updatedAt - startRef.current.t) / 1000;
    const rate = (done - startRef.current.gb) / Math.max(1, elapsed);
    const left = (total - done) / Math.max(rate, 0.001);
    eta = `${roughDuration(left)} left`;
  }
  const known = demo || total > 0;
  // On a line of their own under what is happening, so a long file name never splits them.
  const numbers = demo ? "" : [known ? `${gb(done)} of ${gb(total)}` : "", eta, fileCount > 0 ? `${Math.min(filesDone, fileCount)} of ${fileCount} files` : ""].filter(Boolean).join(", ");
  // The file coming down, by the plain name its recipe gives it and its size. Its file name is only the tooltip.
  const file = fileId ? plan?.downloads.find((d) => d.id === fileId) : undefined;
  const fileLabel = file?.name ? [file.name, fileSize(file.sizeGb)].filter(Boolean).join(", ") : null;

  return (
    <div className="ob__step">
      <Rise i={0}>
        <Meter frac={known ? frac : null} bad={!!error} />
      </Rise>
      <Rise i={1} className="ob__head">
        <h1 className="ob__title">{demo ? (error ? "Demo setup stopped" : "Setting up the demo") : remote ? (error ? "Connecting stopped" : `Connecting to ${remoteName}`) : error ? "The download stopped" : checking ? "Checking the models you have" : "Downloading your setup"}</h1>
        <p className="ob__lead">{demo ? "Nothing is downloaded." : remote ? "Setting up the link. No models are downloaded here." : error ? "Finished files stay on disk. Trying again picks up where it stopped." : checking ? "Each file is read once to make sure it is the right one. Your files are not changed." : "Minimize this window and come back. Finished files stay if you quit."}</p>
      </Rise>
      {error ? (
        <div className="ob__notice"><Notice tone="bad" title="Stopped">
          {error}
        </Notice></div>
      ) : (
        <Rise i={2} className="ob__progress">
          <StepBar frac={known ? frac : null} />
          <div className="ob__status ob__status--stack">
            <span className="ob__status-line">
              <span className="pulse" />
              {fileLabel ? (
                <span title={file!.filename}>{`${demo ? "Simulating" : "Downloading"} ${fileLabel}`}</span>
              ) : (
                <span>{demo ? "Simulating setup" : (progress?.message ?? "Connecting")}</span>
              )}
            </span>
            {numbers && <span className="t-muted">{numbers}</span>}
            {plan?.reused?.length ? <span className="t-muted">{`${demo ? "A real setup would use" : "Using"} ${plan.reused.length === 1 ? "1 model file" : `${plan.reused.length} model files`} already on this computer, ${gb(reusedGb(plan), reusedGb(plan) < 10 ? 1 : 0)} less to download.`}</span> : null}
          </div>
        </Rise>
      )}
      <Actions
        step="install"
        quiet={
          error ? (
            <button type="button" className="ob__quiet" onClick={onBack}>
              Back
            </button>
          ) : null
        }
      >
        {error && (
          <Button
            variant="primary"
            size="l"
            className="ob__cta"
            busy={retrying}
            disabled={!tier}
            onClick={async () => {
              if (!tier) return;
              setRetrying(true);
              try {
                await onInstall({ tier, memoryLimitGb });
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

/** "6.4 GB", "17 GB", "490 MB"; nothing for a settings file of a few kilobytes. */
function fileSize(sizeGb: number): string {
  if (sizeGb < 0.001) return "";
  return gb(sizeGb, sizeGb >= 1 && sizeGb < 10 ? 1 : 0);
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
  const tier = useInstalledTier();
  // Where the final only upscales the draft, the copy says that, not "sharpens".
  const upscale = upscaleOnly(tier);

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
  // The three steps, each done once what it makes is there. The first one not done is the one under way. A film starts
  // with its template's shot list, so the shot list is written once its job is done or a later step has started.
  const written = !!shot?.stillAssetId || shotJobs.some((j) => j.step !== "text" || j.status === "done");
  const doneSteps = SAMPLE_STEPS.filter((s) => (s === "text" ? written : s === "still" ? !!shot?.stillAssetId : best?.rung === "draft" || best?.rung === "final"));
  const current = SAMPLE_STEPS.find((s) => !doneSteps.includes(s));
  const elapsedSec = active?.status === "running" && active.startedAt && current === sampleStepOf(active.step) ? Math.max(0, (now - Date.parse(active.startedAt)) / 1000) : 0;
  // From the recipe's times: about how long it all takes, then what is left once a step is done.
  // The recipe's times are for real renders. The demo's take seconds, so it promises none.
  const timeLine = demo ? null : sampleTimeLine({ estimates: sampleEstimates(tier, project ? draftStepFor(project) : "video_draft"), done: doneSteps, elapsedSec, where: remoteName ?? "this machine" });
  // Until the still is there, the frame shows the steps, not an empty box. A failure says why under it instead.
  const showSteps = !best && !deleted && !(answer === "failed" && !project) && !(failed && !active);

  return (
    <div className="ob__step ob__step--wide">
      <Rise i={0} className="ob__head">
        <h1 className="ob__title">{stage === "done" ? (demo ? "Your demo shot" : remoteName ? `${remoteName} made this` : "Your machine made this") : "Your first shot"}</h1>
        <p className="ob__lead">{stage === "done" ? `${isBrowserDemo() ? "A real still and motion draft, made on an RTX 2080 Super and replayed here." : demo ? `A placeholder still and motion draft, in ${elapsed ? shortDuration(elapsed) : "a few seconds"}.` : `A still, then a motion draft, in ${elapsed ? shortDuration(elapsed) : "under a minute"}.`} ${upscale ? `A final upscales the take you like${upscale.to}` : "A final sharpens the take you like"}, now or overnight.` : `A lighthouse in a storm, camera pushing in. ${isBrowserDemo() ? "Real renders, replayed while you watch." : demo ? "Placeholder renders, made here while you watch." : `Made ${remoteName ? `on ${remoteName}` : "on your machine"} while you watch.`}`}</p>
      </Rise>
      <Rise i={1} className={cx("frame ob__shot", frameClass("16:9"), !best && "frame--empty", showSteps && "shimmer", active && best?.rung !== "draft" && "frame--working", stage === "done" && "ob__shot--done")}>
        {showSteps && <SampleSteps current={current} done={doneSteps} />}
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
      <Rise i={2} className={cx("ob__status", timeLine && !deleted && !failed && "ob__status--stack")}>
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
            <span className="ob__status-line">
              <span className="pulse" />
              <span>
                {/* The text step's stage is "Writing" too, so only its time follows. */}
                {active.step === "text"
                  ? ["Writing the shot", jobElapsed(active, now)].filter(Boolean).join(", ")
                  : `${active.step === "still" ? "Making the still" : "Making the motion draft"}, ${jobStatusLine(active, now).toLowerCase()}`}
              </span>
            </span>
            {timeLine && <span className="t-muted">{timeLine}</span>}
          </>
        ) : stage === "done" ? (
          // A dot on this line means something is running; a finished draft and a wait before it have none.
          <span>
            <b>Draft ready.</b> {upscale ? `The final upscales it${upscale.to}.` : "Soft on purpose. The final sharpens it."}
          </span>
        ) : (
          <>
            <span>Getting ready</span>
            {timeLine && <span className="t-muted">{timeLine}</span>}
          </>
        )}
      </Rise>
      <Actions
        step="first"
        quiet={
          stage === "done" && project ? (
            <button type="button" className="ob__quiet" disabled={leaving} onClick={() => void finish(`/p/${project.id}/media`)}>
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

/** Which of the sample's steps a job is. */
function sampleStepOf(step: Job["step"]): SampleStep {
  return step === "text" ? "text" : step === "still" ? "still" : "draft";
}

const sampleStepNames: Record<SampleStep, { label: string; icon: ReactNode }> = {
  text: { label: "Shot list", icon: <PenLine /> },
  still: { label: "Still", icon: <Image /> },
  draft: { label: "Draft", icon: <Film /> },
};

/** The sample's steps in the empty frame: what is done, what is under way, what comes next. */
function SampleSteps({ current, done }: { current: SampleStep | undefined; done: SampleStep[] }) {
  return (
    <ol className="ob__steps">
      {SAMPLE_STEPS.map((s) => {
        const state = done.includes(s) ? "done" : s === current ? "now" : "next";
        return (
          <li key={s} className={cx("ob__stp", `ob__stp--${state}`)} aria-current={state === "now" ? "step" : undefined}>
            <span className="ob__stp-mark" aria-hidden>
              {state === "done" ? <Check /> : sampleStepNames[s].icon}
            </span>
            <span className="ob__stp-label">
              {sampleStepNames[s].label}
              {state === "done" && <span className="visually-hidden">, done</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export type { Project };

function editorDownloadLabel(id: string): string {
  if (/vad|voice/.test(id)) return "Voice detection";
  if (/whisper|caption/.test(id)) return "Captions model";
  if (/browser|chrome/.test(id)) return "Render browser";
  return "Video export tools";
}
