"""Compare VFX end-frame guidance and prompt-only LTX through the Comfy SDK.

COMFY_BASE_URL=http://127.0.0.1:8191 uv run --no-project --python 3.12 --with comfy-sdk \
  python scripts/vfx_spike.py --photo person=person.png --photo product=product.png \
  --photo statue=statue.png --out outputs/vfx-comparison

One submission at a time. Completed runs are reused; interrupted runs reattach to the
recorded job. Use a new output folder when changing prompts, graphs or source photos.
No runtime restarts, model downloads, or cache changes.
"""
import argparse
import hashlib
import json
import time
from pathlib import Path

from comfy_sdk import Comfy

ROOT = Path(__file__).resolve().parents[1]
FILES = {"image", "lastImage"}


def run(client, directory, workflow, values):
    directory.mkdir(parents=True, exist_ok=True)
    ref = json.loads((ROOT / "workflows" / f"{workflow}.api.ref.json").read_text())
    graph = ROOT / "workflows" / ref["workflow"]
    fingerprint = hashlib.sha256(graph.read_bytes() + json.dumps({
        key: hashlib.sha256(value.read_bytes()).hexdigest() if isinstance(value, Path) else value
        for key, value in values.items()
    }, sort_keys=True).encode()).hexdigest()
    record = directory / "run.json"
    if record.exists():
        result = json.loads(record.read_text())
        if result["fingerprint"] != fingerprint:
            raise ValueError(f"{directory}: changed inputs; choose a new --out folder")
        return result
    pending = directory / "pending.json"
    start = time.monotonic()
    resumed = pending.exists()
    if resumed:
        state = json.loads(pending.read_text())
        if state["fingerprint"] != fingerprint:
            raise ValueError(f"{directory}: changed inputs with a pending job")
        job = client.jobs.get(state["jobId"])
    else:
        wf = client.workflows.from_file(str(graph))
        for key, value in values.items():
            target = ref["inputs"].get(key)
            if target:
                wf.set_input(target["node"], target["field"], client.assets.from_file(str(value)) if key in FILES else value)
        job = client.submit(wf)
        pending.write_text(json.dumps({"jobId": job.id, "fingerprint": fingerprint}))
    print(directory.name, job.id, flush=True)
    job = job.wait(timeout=3600)
    if job.status != "succeeded":
        raise RuntimeError(f"{directory.name}: {job.status}: {job.error}")
    outputs = []
    for node in ref["outputNodes"]:
        assets = job.get_outputs(node)
        if not assets:
            raise RuntimeError(f"{directory.name}: no output from {node}")
        for asset in assets:
            path = directory / node / Path(asset.name).name
            path.parent.mkdir(exist_ok=True)
            asset.to_file(path)
            outputs.append({"node": node, "path": str(path)})
    result = {"jobId": job.id, "fingerprint": fingerprint, "seconds": time.monotonic() - start, "resumed": resumed,
              "workflow": ref["workflow"], "inputs": {k: str(v) for k, v in values.items()}, "outputs": outputs}
    record.write_text(json.dumps(result, indent=2) + "\n")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--photo", action="append", required=True, metavar="NAME=PATH")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--effects", nargs="+")
    args = parser.parse_args()
    photos = {key: Path(value).resolve() for key, value in (p.split("=", 1) for p in args.photo)}
    candidates = json.loads((ROOT / "research/2026-10-21_vfx_candidates.json").read_text())
    effects = args.effects or list(candidates)
    if any(key not in candidates for key in effects):
        parser.error("unknown effect")
    client = Comfy()
    ends = {}
    for name, photo in photos.items():
        for effect in effects:
            end, _ = candidates[effect]
            if end is None:
                continue
            prompt = f"Keep the exact camera, framing, background and lighting of the photo. Transform only the main subject: it is now {end}. Photorealistic VFX end frame, no text."
            result = run(client, args.out / f"{name}-{effect}-end", "effect_end_frame", {
                "image": photo, "prompt": prompt, "seed": 7300 + list(candidates).index(effect),
            })
            ends[name, effect] = Path(result["outputs"][0]["path"])
    for name, photo in photos.items():
        for effect in effects:
            end, action = candidates[effect]
            prompt = ("Locked-off shot. " if effect != "earth_zoom" else "") + action + ". Keep the scene, subject identity and lighting consistent. The first frame is exactly the supplied photo. One continuous physical action, no cuts, no crossfade, no text. Cinematic visual effects."
            values = {"image": photo, "prompt": prompt, "seed": 7350 + list(candidates).index(effect),
                      "width": 384, "height": 640, "frames": 97, "fps": 24}
            if end:
                values["lastImage"] = ends[name, effect]
            run(client, args.out / f"{name}-{effect}-video", "ltx25_effect" if end else "ltx25_draft", values)


if __name__ == "__main__":
    main()
