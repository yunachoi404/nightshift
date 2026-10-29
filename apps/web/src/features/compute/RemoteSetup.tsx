import type { RemoteCheck, TierSummary } from "@nightshift/contract";
import { AlertCircle, Check, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useEngine, useEngineState } from "@/store/engine";
import { Button, Input, Notice, cx } from "@/ui/primitives";
import { gb } from "@/lib/format";
import { tierFor, tierName } from "@/store/tier";
import "./compute.css";

/**
 * Point Nightshift at a GPU computer on the network. Type a name or address, check it, read what it has,
 * use it. Nothing is installed there: what is missing is listed so the user can fix it on that computer.
 * The demo engine can't connect anywhere; there Check still reads the computer, and `demoAction` is the way on.
 */
export function RemoteSetup({ initialUrl, tiers, onUsed, onCancel, compact, demoAction }: { initialUrl?: string; tiers: TierSummary[] | null; onUsed: () => void; onCancel?: () => void; compact?: boolean; demoAction?: { label: string; onAction: () => void } }) {
  const { remoteCheck, remoteUse, client } = useEngine();
  const { status } = useEngineState();
  const fixedMode = client.kind !== "mock" && (status?.mode === "mock" || status?.mode === "attach");
  const demo = fixedMode && status?.mode === "mock";
  const [url, setUrl] = useState(initialUrl ?? "");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<RemoteCheck | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [failureAction, setFailureAction] = useState<"check" | "connect">("check");
  const [using, setUsing] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const checkVersion = useRef(0);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const check = async () => {
    if (!url.trim()) return;
    const version = ++checkVersion.current;
    setChecking(true);
    setFailureAction("check");
    setFailed(null);
    setResult(null);
    try {
      const checked = await remoteCheck(url.trim());
      if (version === checkVersion.current) setResult(checked);
    } catch (e) {
      if (version === checkVersion.current) setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      if (version === checkVersion.current) setChecking(false);
    }
  };

  const tier = result?.recommendedTier ? tiers?.find((t) => t.tier === result.recommendedTier) ?? null : null;
  const missing = !!result && (result.missingNodes.length > 0 || result.missingModels.length > 0);
  const ready = !!result?.reachable && !result.error && !!result.recommendedTier;
  const gpu = result?.hardware?.gpus[0];

  const use = async () => {
    if (!result?.recommendedTier || fixedMode) return;
    setUsing(true);
    setFailureAction("connect");
    try {
      await remoteUse(result.url, result.recommendedTier);
      onUsed();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
      setUsing(false);
    }
  };

  return (
    <div className={cx("remote", compact && "remote--compact")}>
      <form
        className="remote__form"
        onSubmit={(e) => {
          e.preventDefault();
          void check();
        }}
      >
        <Input ref={input} value={url} disabled={using} onChange={(e) => {
          setUrl(e.target.value);
          checkVersion.current++;
          setChecking(false);
          setResult(null);
          setFailed(null);
        }} placeholder="spark, or spark:8190" aria-label="Computer name or address" spellCheck={false} autoCapitalize="off" autoCorrect="off" />
        <Button type="submit" icon={<Search />} busy={checking} disabled={!url.trim()}>
          Check
        </Button>
      </form>
      <p className="t-small t-muted">The computer runs ComfyUI prepared by Nightshift, on port 8190 unless you say otherwise. Nothing is installed on it from here.</p>
      {demo ? (
        <Notice>The demo can't connect to a GPU computer. Check still shows its hardware.</Notice>
      ) : (
        fixedMode && <Notice title="This GPU connection was set when the app opened">Quit Nightshift and open it normally to change GPU computers. You can still check an address here.</Notice>
      )}

      {failed && (
        <Notice tone="bad" title={failureAction === "connect" ? "Couldn't connect to that computer" : "Couldn't check that computer"}>
          {failed}
        </Notice>
      )}

      {result && !result.reachable && (
        <Notice tone="bad" title="Nothing answered">
          {result.error ?? `Nothing answered at ${result.url}.`}
          <div className="notice__actions">
            <Button size="s" onClick={() => void check()}>
              Check again
            </Button>
          </div>
        </Notice>
      )}

      {result?.reachable && (
        <div className="group remote__result">
          <div className="group__row">
            <span className={cx("remote__dot", ready && !missing ? "remote__dot--ok" : "remote__dot--warn")} />
            <div className="group__k">
              <b>{result.name ?? result.url}</b>
              <small>
                {result.url}
                {result.comfyuiVersion ? `, ComfyUI ${result.comfyuiVersion}` : ""}
              </small>
            </div>
            {ready && !missing ? <Check className="remote__ok" aria-label="Ready" /> : <AlertCircle className="remote__warn" aria-label="Needs attention" />}
          </div>
          {result.hardware && (
            <div className="group__row">
              <div className="group__k">
                <b>Graphics</b>
              </div>
              <span className="group__v">
                {gpu ? gpu.name : "Unknown"}
                {gpu && gpu.vramGb > 0 ? `, ${gb(gpu.vramGb)}${gpu.unifiedMemory ? " shared" : ""}` : ""}
              </span>
            </div>
          )}
          <div className="group__row">
            <div className="group__k">
              <b>Setup</b>
              <small>{tier ? tierFor(tier) : result.recommendedTier ? result.recommendedTier : "No setup fits this computer"}</small>
            </div>
            <span className="group__v">{tier ? tierName(tier, null) : ""}</span>
          </div>
          {(result.missingNodes.length > 0 || result.missingModels.length > 0) && (
            <div className="group__row group__row--stack remote__missing">
              <div>
                <b>Missing on {result.name ?? "that computer"}</b>
                <small>Renders that need these fail until they are added there. Nightshift does not install on other computers.</small>
              </div>
              <ul>
                {result.missingNodes.map((n) => (
                  <li key={n}>
                    <span className="remote__kind">Node</span>
                    {n}
                  </li>
                ))}
                {result.missingModels.map((m) => (
                  <li key={m}>
                    <span className="remote__kind">Model</span>
                    {m}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {result?.reachable && result.error && (
        <Notice tone="bad" title="That computer can't be used yet">
          {result.error}
        </Notice>
      )}

      <div className="remote__actions">
        {onCancel && !(demo && demoAction) && (
          <Button variant="quiet" onClick={onCancel} disabled={using}>
            Cancel
          </Button>
        )}
        {demo && demoAction ? (
          <Button variant="primary" onClick={demoAction.onAction}>
            {demoAction.label}
          </Button>
        ) : (
          <Button variant="primary" disabled={!ready || fixedMode} busy={using} onClick={() => void use()}>
            {result?.name ? `Use ${result.name}` : "Use this computer"}
          </Button>
        )}
      </div>
    </div>
  );
}
