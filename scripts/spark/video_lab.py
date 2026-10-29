"""Sequential Spark video evidence, all generation via run_workflow.py and Comfy SDK.

Resume completed cases from run.json. Re-run only by selecting a new --out directory.
"""

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--draft", default="outputs/model_lab/ltx_draft_ok")
ap.add_argument("--out", default="outputs/model_lab")
ap.add_argument("--h3", action="store_true")
ap.add_argument("--camera", action="store_true")
ap.add_argument("--camera-seeds", type=int, nargs="+", default=[42])
ap.add_argument("--warm", action="store_true")
a = ap.parse_args()
if a.warm:
    os.environ["NIGHTSHIFT_WARM"] = "1"
os.environ.setdefault("COMFY_BASE_URL", "http://127.0.0.1:8191")
root = Path(a.out)
image = "outputs/smoke/look/look_00001_.png"


def run(name, workflow, *settings):
    out = root / name
    if not (out / "run.json").exists():
        subprocess.run(
            [
                sys.executable,
                "scripts/spark/bench.py",
                str(out),
                "workflows/" + workflow + ".api.json",
                *settings,
            ],
            check=True,
        )
    return json.loads((out / "run.json").read_text())


def asset(run, node):
    return next(v["path"] for v in run["outputs"] if v["node"] == node)


draft = json.loads((Path(a.draft) / "run.json").read_text())
run(
    "ltx_final",
    "ltx25_same_take",
    "--file",
    "30.latent=" + asset(draft, "20"),
    "--file",
    "5.image=" + image,
    "--file",
    "25.reference_video=" + asset(draft, "25"),
)
if a.h3:
    for wf in ["h3_ref2va_4step", "h3_fl2va_4step", "h3_fl2va_8step"]:
        try:
            run(wf, wf, "--file", "6.file=" + asset(draft, "25"))
        except subprocess.CalledProcessError:
            print("failed " + wf, flush=True)
if a.camera:
    moves = {
        "dolly_in": "The camera makes one continuous smooth dolly in, moving physically forward behind the woman, closing the distance. Buildings expand through parallax. No pull back, no cuts.",
        "crash_zoom": "The camera makes a sudden fast optical crash zoom toward the woman in red. The subject rapidly grows from a wide shot to a close shot. Camera position stays fixed. No cuts.",
        "orbit": "The camera orbits left around the woman by ninety degrees, moving from behind to a side view. The buildings slide through the background with clear parallax. No cuts.",
        "crane_up": "The camera cranes steadily upward from street level to a high overhead view, revealing the wet street below. The camera points down as it rises. No cuts.",
        "handheld": "The camera follows behind the woman with unmistakable handheld walking sway, small irregular lateral and vertical camera bumps. One continuous shot, no cuts.",
    }
    for name, move in moves.items():
        for seed in a.camera_seeds:
            run(
                "camera_" + name + ("" if seed == 42 else f"_seed{seed}"),
                "ltx25_draft",
                "--set",
                f"15.noise_seed={seed}",
                "--file",
                "5.image=" + image,
                "--set",
                "7.text=A woman in a red coat walks down a wet city street at dusk. "
                + move
                + " Quiet city ambience.",
            )
