"""One resumable, sequential queue for the remaining Spark SDK evaluations.

Waits for our runtime and enough scheduler budget (see scheduler.py). Never changes any runtime.
Completed cases are immutable. Failed attempts move into outputs/model_lab/attempts.
Preempted cases retry; model errors are recorded and the queue advances.
"""

import argparse
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import scheduler  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "outputs/model_lab"
IMAGE = "outputs/smoke/look/look_00001_.png"


def allocation():
    status = scheduler.status()
    match = re.search(
        rf"^  {re.escape(scheduler.JOB)}\s+running\s+budget\s+([\d.]+) GB.*?pid\s+(\d+)",
        status,
        re.MULTILINE,
    )
    return (float(match[1]), int(match[2])) if match else (0.0, None)


def ready():
    try:
        with urllib.request.urlopen(
            "http://127.0.0.1:8190/queue", timeout=5
        ) as response:
            queue = json.load(response)
        return not queue["queue_running"] and not queue["queue_pending"]
    except (urllib.error.URLError, TimeoutError, ValueError):
        return False


def output(case, node):
    data = json.loads((OUT / case / "run.json").read_text())
    return next(item["path"] for item in data["outputs"] if item["node"] == node)


def cases():
    latent = output("ltx_draft_ok", "20")
    video = output("ltx_draft_ok", "25")
    yield (
        "ltx_final_streamcopy",
        "ltx25_same_take",
        48,
        ["--file", "30.latent=" + latent, "--file", "5.image=" + IMAGE,
         "--file", "25.reference_video=" + video],
    )
    yield "h3_ref2va_final", "h3_ref2va_final", 48, ["--file", "6.file=" + video]
    yield (
        "h3_fl2va_4step_euler",
        "h3_fl2va_4step_euler",
        48,
        ["--file", "6.file=" + video],
    )
    moves = {
        "dolly_in": "The camera makes one continuous smooth dolly in, moving physically forward behind the woman, closing the distance. Buildings expand through parallax. No pull back, no cuts.",
        "crash_zoom": "The camera makes a sudden fast optical crash zoom toward the woman in red. The subject rapidly grows from a wide shot to a close shot. Camera position stays fixed. No cuts.",
        "orbit": "The camera orbits left around the woman by ninety degrees, moving from behind to a side view. The buildings slide through the background with clear parallax. No cuts.",
        "crane_up": "The camera cranes steadily upward from street level to a high overhead view, revealing the wet street below. The camera points down as it rises. No cuts.",
        "handheld": "The camera follows behind the woman with unmistakable handheld walking sway, small irregular lateral and vertical camera bumps. One continuous shot, no cuts.",
    }
    for name, move in moves.items():
        for seed in (43, 44):
            yield (
                f"camera_{name}_seed{seed}",
                "ltx25_draft",
                48,
                [
                    "--file",
                    "5.image=" + IMAGE,
                    "--set",
                    f"15.noise_seed={seed}",
                    "--set",
                    "7.text=A woman in a red coat walks down a wet city street at dusk. "
                    + move
                    + " Quiet city ambience.",
                ],
            )
    for name, budget in [
        ("breeze_tts2", 24),
        ("drama3_optional", 52),
        ("minimax_music3", 32),
        ("ace15_turbo", 16),
    ]:
        yield name, name, budget, []
    for name in (
        "krea2_turbo_bf16",
        "krea2_turbo_int8",
        "krea2_turbo_int8_mix",
        "krea2_turbo_nvfp4",
        "krea2_raw_bf16",
        "moss_image_int8",
        "moss_image_int8_encoder",
        "moss_image_gptq_encoder",
    ):
        yield name, name, 48, []
    yield "runner_text_output", "tests/echo_text", 16, []
    yield "text_shot_list", "text_shot_list", 16, []
    # A CUDA allocator cap is required for this final low-tier fit experiment.
    # It does not cap host RAM. Leave this queued until the lab owner relaunches
    # our runtime with NIGHTSHIFT_TORCH_VRAM_GB=8 and DynamicVRAM disabled.
    yield (
        "kandinsky6_lite_capped8",
        "kandinsky6_lite_draft",
        16,
        ["--file", "8.image=" + IMAGE],
    )


def capped8():
    # Our custom node exposes this read-only diagnostic through INPUT_TYPES.
    try:
        with urllib.request.urlopen(
            "http://127.0.0.1:8190/object_info/NightshiftRuntimeInfo", timeout=5
        ) as response:
            info = json.load(response)
        return (
            info["NightshiftRuntimeInfo"]["input"]["required"]["cuda_limit_gb"][1][
                "default"
            ]
            == 8
        )
    except (urllib.error.URLError, TimeoutError, ValueError, KeyError):
        return False


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--list", action="store_true", help="Print queue without waiting or submitting"
    )
    args = ap.parse_args()
    os.chdir(ROOT)
    os.environ.setdefault("COMFY_BASE_URL", "http://127.0.0.1:8191")
    tasks = list(cases())
    if args.list:
        for case, workflow, budget, _ in tasks:
            print(f"{case}: {workflow}, minimum allocation {budget} GB")
        return
    OUT.mkdir(parents=True, exist_ok=True)
    with (OUT / "remaining_queue.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for case, workflow, minimum, settings in tasks:
            destination = OUT / case
            while not (destination / "run.json").exists():
                budget, pid = allocation()
                if (
                    budget < minimum
                    or not ready()
                    or (case.endswith("capped8") and not capped8())
                ):
                    state = {
                        "case": case,
                        "status": "waiting",
                        "minimumBudgetGb": minimum,
                        "currentBudgetGb": budget,
                        "requiresCudaCap8": case.endswith("capped8"),
                    }
                    (OUT / "remaining_queue.json").write_text(
                        json.dumps(state, indent=2) + "\n"
                    )
                    time.sleep(15)
                    continue
                if destination.exists():
                    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
                    archive = OUT / "attempts" / f"{case}_{stamp}"
                    archive.parent.mkdir(exist_ok=True)
                    shutil.move(str(destination), archive)
                print(f"Running {case} with {budget:g} GB allocation", flush=True)
                (OUT / "remaining_queue.json").write_text(
                    json.dumps(
                        {
                            "case": case,
                            "workflow": workflow,
                            "status": "running",
                            "budgetGb": budget,
                            "runtimePid": pid,
                        },
                        indent=2,
                    )
                    + "\n"
                )
                result = subprocess.run(
                    [
                        sys.executable,
                        "scripts/spark/bench.py",
                        str(destination),
                        "workflows/" + workflow + ".api.json",
                        *settings,
                    ],
                    check=False,
                )
                if result.returncode == 0:
                    break
                _, after_pid = allocation()
                interrupted = pid != after_pid or not ready()
                print(
                    f"{case}: {'interrupted, retrying' if interrupted else 'failed, recorded'}",
                    flush=True,
                )
                if not interrupted:
                    break
                time.sleep(15)
        (OUT / "remaining_queue.json").write_text(
            json.dumps(
                {
                    "status": "finished",
                    "note": "Inspect every case; failures are not passes.",
                },
                indent=2,
            )
            + "\n"
        )


if __name__ == "__main__":
    main()
