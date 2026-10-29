import { X } from "lucide-react";
import { useState } from "react";
import { getMockEngine, type DevSettings } from "@/api/mock/engine";
import { hardwarePresets } from "@/api/mock/data";
import { Button, Select, toast, usePanelFocus } from "@/ui/primitives";
import "./dev.css";

/** Controls for the in-browser mock engine. Only mounted when the client is the mock. */
export function DevPanel({ onClose }: { onClose: () => void }) {
  const panelRef = usePanelFocus<HTMLDivElement>();
  const engine = getMockEngine();
  const [dev, setDev] = useState<DevSettings>(engine.dev);
  const apply = (patch: Partial<DevSettings>) => {
    engine.setDev(patch);
    setDev({ ...engine.dev });
  };
  const faults = (patch: Partial<DevSettings["faults"]>) => apply({ faults: { ...dev.faults, ...patch } });

  return (
    <div ref={panelRef} className="dev" role="dialog" aria-modal="true" aria-label="Mock engine controls">
      <div className="dev__head">
        <span className="dev__title">Mock engine</span>
        <Button variant="quiet" size="s" iconOnly icon={<X />} aria-label="Close" onClick={onClose} />
      </div>
      <div className="dev__body">
        <div className="dev__row">
          <span>Machine</span>
          <Select value={dev.preset} onChange={(e) => apply({ preset: e.target.value })}>
            {Object.entries(hardwarePresets).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="dev__row">
          <span>Speed</span>
          <Select value={dev.speed} onChange={(e) => apply({ speed: e.target.value as DevSettings["speed"] })}>
            <option value="quick">Quick (seconds)</option>
            <option value="realistic">Realistic (tier estimates)</option>
          </Select>
        </div>
        <div className="dev__row">
          <span>Install fails</span>
          <Select value={dev.faults.installFail ?? ""} onChange={(e) => faults({ installFail: (e.target.value || null) as DevSettings["faults"]["installFail"] })}>
            <option value="">No</option>
            <option value="network">Network drops at 40%</option>
            <option value="disk">Disk full at 70%</option>
          </Select>
        </div>
        <div className="dev__row">
          <span>Next job fails</span>
          <Select value={dev.faults.nextJobFail ?? ""} onChange={(e) => faults({ nextJobFail: (e.target.value || null) as DevSettings["faults"]["nextJobFail"] })}>
            <option value="">No</option>
            <option value="oom">Out of memory</option>
            <option value="crash">Engine restarts</option>
          </Select>
        </div>
        <div className="dev__row">
          <span>GPU computer</span>
          <Select value={dev.remote} onChange={(e) => apply({ remote: e.target.value as DevSettings["remote"] })}>
            <option value="reachable">Reachable, ready</option>
            <option value="missing">Reachable, models missing</option>
            <option value="unreachable">Nothing answers</option>
          </Select>
        </div>
        <label className="dev__check">
          <input type="checkbox" checked={dev.faults.detectFails} onChange={(e) => faults({ detectFails: e.target.checked })} /> Hardware detection fails
        </label>
        <label className="dev__check">
          <input type="checkbox" checked={dev.faults.unreachable} onChange={(e) => faults({ unreachable: e.target.checked })} /> Engine unreachable
        </label>
        <label className="dev__check">
          <input type="checkbox" checked={dev.faults.gpuAway} onChange={(e) => faults({ gpuAway: e.target.checked })} /> GPU away (remote or proxy not answering)
        </label>
        <label className="dev__check">
          <input type="checkbox" checked={dev.faults.gpuShared} onChange={(e) => faults({ gpuShared: e.target.checked })} /> Another app holds 3.5 GB of the GPU
        </label>
        <label className="dev__check">
          <input type="checkbox" checked={dev.simulateNight} onChange={(e) => apply({ simulateNight: e.target.checked })} /> It's night (overnight queue runs)
        </label>
        <div className="dev__actions">
          <Button
            size="s"
            onClick={() => {
              engine.finishRunningNow();
              toast({ title: "Skipped ahead", ttl: 1500 });
            }}
          >
            Finish current job
          </Button>
          <Button size="s" variant="danger" onClick={() => engine.resetAll()}>
            Reset everything
          </Button>
        </div>
        <p className="dev__hint">
          Press <code>M</code> to toggle. URL: <code>?mock=hw:rtx4090,speed:quick,fail:oom,fail:gpu,fail:gpu-shared,remote:missing,night,reset</code>. Engine: <code>?api=http://127.0.0.1:7788</code> or <code>?api=mock</code>.
        </p>
      </div>
    </div>
  );
}
