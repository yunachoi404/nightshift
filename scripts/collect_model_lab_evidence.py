"""Collect small reviewable measurements and latent headers, without copying media into git."""

import hashlib
import json
import struct
from pathlib import Path

from lab_assets import output_path

root = Path("outputs/model_lab")


def repo_relative(path):
    """An absolute path on the machine that ran the job, as a path from the repo root (outputs/...)."""
    marker = "/outputs/"
    return path[path.index(marker) + 1 :] if path.startswith("/") and marker in path else path


cases = []
for measurement in sorted(root.rglob("measurement.json")):
    measured = json.loads(measurement.read_text())
    item = {
        "case": measurement.parent.name,
        "evidenceDirectory": measurement.parent.as_posix(),
        **measured,
        "benchmarkSeconds": measured["seconds"],
    }
    run = measurement.parent / "run.json"
    if run.exists():
        item.update(json.loads(run.read_text()))
        item["sdkSeconds"] = item["seconds"]
        for output in item["outputs"]:
            path = output_path(measurement.parent, output)
            if output["path"] != str(path):
                output["sourcePath"] = repo_relative(output["path"])
                output["path"] = str(path)
            if path.is_file():
                with path.open("rb") as f:
                    output["sha256"] = hashlib.file_digest(f, "sha256").hexdigest()
            if path.exists() and path.suffix == ".latent":
                with path.open("rb") as f:
                    size = struct.unpack("<Q", f.read(8))[0]
                    header = json.loads(f.read(size))
                output["tensors"] = {
                    k: {"dtype": v["dtype"], "shape": v["shape"]}
                    for k, v in header.items()
                    if k != "__metadata__"
                }
                output["format"] = header.get("__metadata__", {}).get("nightshift_av")
    cases.append(item)
Path("research/2026-10-19_model_measurements.json").write_text(
    json.dumps(cases, indent=2) + "\n"
)
print(
    f"Collected {len(cases)} cases, {sum(c.get('exitCode') == 0 for c in cases)} completed"
)
