"""Test a continuous keyframe chain through the Comfy SDK, one job at a time.

Use --spec for a JSON file containing name, anchor, edits, motions and continuous.
Run --phase stills before videos to inspect the keyframes. Completed jobs are reused;
pending jobs are reattached by ID. No services or models are installed or changed.
"""

import argparse
import copy
import hashlib
import json
import time
from pathlib import Path

from comfy_sdk import Comfy

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    return json.loads((ROOT / "workflows" / name).read_text())


def run(client, folder, graph, files, outputs):
    folder.mkdir(parents=True, exist_ok=True)
    graph_json = json.dumps(graph, sort_keys=True, indent=2)
    fingerprint = hashlib.sha256(json.dumps(graph, sort_keys=True).encode())
    for node, path in files.items():
        fingerprint.update(node.encode())
        fingerprint.update(path.read_bytes())
    fingerprint = fingerprint.hexdigest()
    record = folder / "run.json"
    if record.exists():
        result = json.loads(record.read_text())
        if result["fingerprint"] != fingerprint:
            raise ValueError(f"Changed inputs in {folder}; use a fresh output folder")
        (folder / "graph.json").write_text(graph_json + "\n")
        return result
    pending = folder / "pending.json"
    started = time.monotonic()
    resumed = pending.exists()
    if resumed:
        state = json.loads(pending.read_text())
        if state["fingerprint"] != fingerprint:
            raise ValueError(f"Changed inputs for pending job in {folder}")
        job = client.jobs.get(state["jobId"])
    else:
        workflow = client.workflows.from_json(copy.deepcopy(graph))
        for node, path in files.items():
            node_id, _, field = node.partition(".")
            workflow.set_input(node_id, field or "image", client.assets.from_file(str(path)))
        job = client.submit(workflow)
        pending.write_text(json.dumps({"jobId": job.id, "fingerprint": fingerprint}))
    print(folder.name, job.id, "resumed" if resumed else "submitted", flush=True)
    job = job.wait(timeout=3600)
    if job.status != "succeeded":
        raise RuntimeError(f"{folder.name}: {job.status}: {job.error}")
    saved = []
    for node in outputs:
        assets = job.get_outputs(node)
        if not assets:
            raise RuntimeError(f"No output from {node}")
        for asset in assets:
            path = folder / node / Path(asset.name).name
            path.parent.mkdir(exist_ok=True)
            asset.to_file(path)
            saved.append({"node": node, "path": str(path)})
    result = {"jobId": job.id, "fingerprint": fingerprint,
              "seconds": round(time.monotonic() - started, 2), "resumed": resumed,
              "outputs": saved}
    record.write_text(json.dumps(result, indent=2) + "\n")
    (folder / "graph.json").write_text(graph_json + "\n")
    print(folder.name, "done", result["seconds"], flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", type=Path, required=True)
    parser.add_argument("--case", help="Named case inside a JSON collection of specs")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--phase", choices=["stills", "segments", "multi", "final"], required=True)
    args = parser.parse_args()
    spec = json.loads(args.spec.read_text())
    if args.case:
        spec = spec[args.case]
    interval = spec.get("interval", 96)
    if not isinstance(interval, int) or interval < 24 or interval > 128 or interval % 8:
        parser.error("interval must be a multiple of eight between 24 and 128 frames")
    if len(spec["edits"]) != len(spec["motions"]) or not 2 <= len(spec["edits"]) <= 3:
        parser.error("use two or three edits with one motion per edit")
    out = args.out.resolve() / spec["name"]
    out.mkdir(parents=True, exist_ok=True)
    (out / "spec.json").write_text(json.dumps(spec, indent=2) + "\n")
    client = Comfy()
    if args.phase == "stills":
        graph = load("krea2_turbo_bf16.api.json")
        graph["4"]["inputs"]["text"] = spec["anchor"]
        graph["6"]["inputs"].update(width=768, height=1280)
        graph["7"]["inputs"]["seed"] = spec.get("seed", 28100)
        result = run(client, out / "k0", graph, {}, ["9"])
        previous = Path(result["outputs"][0]["path"])
        anchor = previous
        for i, edit in enumerate(spec["edits"], 1):
            files = {"10": previous}
            if spec.get("anchor_reference"):
                graph = load("references_klein4b.api.json")
                for node in range(300, 305):
                    graph.pop(str(node))
                graph["32"]["inputs"].update(positive=["203", 0], negative=["204", 0])
                graph["50"]["inputs"]["value"] = 768
                graph["51"]["inputs"]["value"] = 1280
                files["200"] = anchor
            else:
                graph = load("look_edit_klein4b.api.json")
            graph["20"]["inputs"]["text"] = (
                ("Image 1 is the current state. Image 2 is the original scene, supplied "
                 "only to preserve the exact camera, objects and setting. " if spec.get("anchor_reference") else "")
                +
                ("Keep the exact camera position, framing, place, lighting, materials and "
                 "all unchanged objects in the supplied image. " if spec.get("fixed_camera", True) else
                 "Continue a single forward camera journey from the supplied image. Keep the "
                 "same visual world, lighting and materials while moving the viewpoint. ") + edit
                + " One coherent photographic scene. No text, no collage, no split screen.")
            graph["34"]["inputs"]["noise_seed"] = spec.get("seed", 28100) + i
            result = run(client, out / f"k{i}", graph, files, ["40"])
            previous = Path(result["outputs"][0]["path"])
        return
    frames = []
    for i in range(len(spec["edits"]) + 1):
        result = json.loads((out / f"k{i}" / "run.json").read_text())
        frames.append(Path(result["outputs"][0]["path"]))
    if args.phase == "final":
        draft = json.loads((out / "multi" / "run.json").read_text())
        original = json.loads((out / "multi" / "graph.json").read_text())
        graph = load("ltx25_same_take.api.json")
        for node, field in [("7", "text"), ("8", "text"), ("15", "noise_seed")]:
            graph[node]["inputs"][field] = original[node]["inputs"][field]
        files = {"5": frames[0]}
        files["30.latent"] = Path(next(o["path"] for o in draft["outputs"] if o["node"] == "20"))
        files["25.reference_video"] = Path(next(o["path"] for o in draft["outputs"] if o["node"] == "25"))
        run(client, out / "final", graph, files, ["25"])
        return
    base = load("ltx25_effect.api.json")
    base["26"]["inputs"]["value"] = 384
    base["27"]["inputs"]["value"] = 640
    base["28"]["inputs"]["value"] = interval + 1
    base["8"]["inputs"]["text"] = (
        "cuts, crossfade, dissolve, montage, frozen frame, static slideshow, "
        "camera jump, text, watermark, deformed objects, flicker")
    if args.phase == "segments":
        for i, motion in enumerate(spec["motions"]):
            graph = copy.deepcopy(base)
            graph["7"]["inputs"]["text"] = motion + (
                (" Locked camera." if spec.get("fixed_camera", True) else " One smooth forward camera move.") +
                " One uninterrupted evolving shot. Smooth continuous motion "
                "through the final frame. Quiet natural ambience, no speech, no music.")
            graph["15"]["inputs"]["noise_seed"] = spec.get("seed", 28100) + 100 + i
            run(client, out / f"segment{i}", graph,
                {"5": frames[i], "30": frames[i + 1]}, ["20", "25"])
        return
    graph = copy.deepcopy(base)
    graph["7"]["inputs"]["text"] = spec["continuous"] + (
        " One uninterrupted shot, continuous motion, same camera and place throughout. "
        "No cuts, no fades, no text. Quiet natural ambience, no speech, no music.")
    graph["15"]["inputs"]["noise_seed"] = spec.get("seed", 28100) + 200
    graph["28"]["inputs"]["value"] = (len(frames) - 1) * interval + 1
    files = {"5": frames[0], "30": frames[-1]}
    previous = "12"
    for i in range(1, len(frames) - 1):
        node = 100 + i * 4
        graph[str(node)] = {"class_type": "LoadImage", "inputs": {"image": "guide.png"}}
        graph[str(node + 1)] = copy.deepcopy(graph["31"])
        graph[str(node + 1)]["inputs"]["image"] = [str(node), 0]
        graph[str(node + 2)] = copy.deepcopy(graph["32"])
        graph[str(node + 2)]["inputs"]["image"] = [str(node + 1), 0]
        guide = copy.deepcopy(graph["33"])
        guide["inputs"].update(positive=[previous, 0], negative=[previous, 1],
                               latent=[previous, 2], image=[str(node + 2), 0],
                               frame_idx=i * interval)
        graph[str(node + 3)] = guide
        files[str(node)] = frames[i]
        previous = str(node + 3)
    graph["33"]["inputs"].update(positive=[previous, 0], negative=[previous, 1],
                                  latent=[previous, 2])
    run(client, out / "multi", graph, files, ["20", "25"])


if __name__ == "__main__":
    main()
