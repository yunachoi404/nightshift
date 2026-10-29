"""Run an API-format ComfyUI workflow through the Comfy SDK and save its outputs.

The SDK targets Comfy Cloud by default. Point it at a self-hosted ComfyUI behind comfy-api-proxy with
COMFY_BASE_URL, for example a GPU box's proxy through an ssh tunnel:

    ssh -fNL 8191:127.0.0.1:8191 gpu-box
    COMFY_BASE_URL=http://127.0.0.1:8191 .venv/bin/python scripts/run_workflow.py \
        workflows/layout_to_render.api.json \
        --file 5001.file=outputs/smoke/layout.mp4 --file 9009.image=outputs/smoke/first_frame.png \
        --set 5508.value="A rainy city street at dusk..." --out outputs/smoke
"""

import argparse
import json
import time
from pathlib import Path

from comfy_sdk import Comfy


def parse_pairs(pairs):
    for pair in pairs:
        target, value = pair.split("=", 1)
        node, field = target.split(".", 1)
        yield node, field, value


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workflow")
    ap.add_argument(
        "--set",
        action="append",
        default=[],
        help="node.field=value (JSON or plain string)",
    )
    ap.add_argument(
        "--file",
        action="append",
        default=[],
        help="node.field=local path, uploaded as an asset",
    )
    ap.add_argument("--out", required=True)
    ap.add_argument("--timeout", type=float, default=3600)
    ap.add_argument(
        "--output-node",
        action="append",
        default=[],
        help="declared output node; repeat for multiple outputs",
    )
    args = ap.parse_args()
    ref_path = Path(args.workflow).with_suffix(".ref.json")
    declared = args.output_node or (
        json.loads(ref_path.read_text())["outputNodes"] if ref_path.exists() else []
    )
    if not declared:
        ap.error(
            "declare outputs with --output-node or a sibling .ref.json WorkflowRef"
        )

    client = Comfy()
    wf = client.workflows.from_file(args.workflow)
    unknown = set(declared) - set(wf.json)
    if unknown:
        ap.error(f"unknown output nodes: {sorted(unknown)}")
    for node, field, value in parse_pairs(args.set):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            pass
        wf.set_input(node, field, value)
    for node, field, path in parse_pairs(args.file):
        wf.set_input(node, field, client.assets.from_file(path))

    start = time.monotonic()
    job = client.submit(wf)
    print(f"job {job.id} submitted", flush=True)
    job = job.wait(timeout=args.timeout)
    seconds = time.monotonic() - start
    print(f"job {job.id} {job.status} in {seconds:.1f}s", flush=True)
    if job.error or job.status != "succeeded":
        raise SystemExit(f"error: {job.error}")

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    saved = []
    for node in declared:
        outputs = job.get_outputs(node)
        if not outputs:
            raise SystemExit(f"declared output node {node} returned no assets")
        for o in outputs:
            node_out = out / node.replace(":", "_")
            node_out.mkdir(parents=True, exist_ok=True)
            path = o.to_file(node_out / Path(o.name).name)
            saved.append(
                {"node": node, "path": str(path), "bytes": path.stat().st_size}
            )
            print(f"saved {path} ({path.stat().st_size} bytes)", flush=True)
    (out / "run.json").write_text(
        json.dumps(
            {
                "jobId": job.id,
                "workflow": args.workflow,
                "seconds": seconds,
                "outputs": saved,
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
