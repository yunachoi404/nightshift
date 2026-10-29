"""Keep named copies of reviewed real outputs with source hashes and pipelines."""

import hashlib
import json
import shutil
from pathlib import Path

from lab_assets import output_path

directory = Path("outputs/demo")
directory.mkdir(parents=True, exist_ok=True)
manifest = []


def keep(name, source, pipeline, use, **provenance):
    target = directory / name
    shutil.copyfile(source, target)
    with target.open("rb") as file:
        digest = hashlib.file_digest(file, "sha256").hexdigest()
    manifest.append({"path": str(target), "source": str(source), "sha256": digest,
                     "pipeline": pipeline, "use": use, **provenance})


project = json.loads(Path("outputs/real_project/project.json").read_text())
for aspect, width in [("16x9", 1920), ("9x16", 1080)]:
    asset = next(asset for asset in reversed(project["assets"]) if asset.get("role") == "export" and asset["width"] == width)
    source = Path("outputs/real_project/assets") / (asset["id"] + ".mp4")
    keep(f"after_the_rain_{aspect}.mp4", source,
         "Engine attach: Qwen storyboard -> Krea Turbo bf16 -> LTX draft -> LTX same-take / H3 Ref2VA -> Breeze + Music3 -> editor export",
         "Real three-shot app proof, reviewed crop and captions. One independent-still color correction; cup identity differs across shots.",
         projectId=project["id"], assetId=asset["id"],
         licenseNote="Restricted community models and Breeze research/non-commercial weights. See recipe licenses. Not a fully open stack.")

cases = [
    ("ltx_draft_ok", "ltx_street_draft.mp4", "LTX 2.5 INT8, stage 1", "Pair with its continued final"),
    ("ltx_final_streamcopy", "ltx_street_same_take.mp4", "LTX 2.5, saved AV latent -> 2x + 3 steps; original audio packet copy", "Strongest same-take ladder proof"),
    ("camera_crane_up", "ltx_crane_up.mp4", "LTX 2.5 draft, named crane-up prompt", "Clear camera rise; one scene, not broad reliability"),
    ("camera_crash_zoom", "ltx_crash_zoom.mp4", "LTX 2.5 draft, named crash-zoom prompt", "Clear zoom at seed 42"),
    ("h3_ref2va_bf16_final", "h3_bf16_street_remaster.mp4", "H3 full bf16 Ref2VA + four-step turbo, LTX reference", "Large-window comparison; 89 GB process peak, motion drift disclosed"),
]
for case, name, pipeline, use in cases:
    case_dir = Path("outputs/model_lab") / case
    run = json.loads((case_dir / "run.json").read_text())
    entry = next(item for item in run["outputs"] if item["path"].endswith(".mp4"))
    keep(name, output_path(case_dir, entry), pipeline, use, comfyJobId=run["jobId"],
         workflow=run["workflow"], licenseNote="LTX or MiniMax H3 community terms, restricted; see recipe and adapter records.")

Path("research/2026-10-19_demo_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(f"Kept {len(manifest)} reviewed demo outputs under {directory}")
