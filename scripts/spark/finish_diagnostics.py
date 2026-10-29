"""Lab phase queue: finish active work, test MOSS, cap Kandinsky, restore.

Run detached on the GPU box. Requires the exact current serve.sh PID. Uses restart.sh's
process checks and bench.lock; never targets another runtime on the box. remaining_lab.py
must already be waiting for its final capped8 case. Results stay in case folders.
"""

import argparse
import fcntl
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "outputs/model_lab"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("serve_pid", type=int)
parser.add_argument("--budget-gb", type=float, default=52)
parser.add_argument("--restore-budget-gb", type=float)
parser.add_argument("--gptq-only", action="store_true")
args = parser.parse_args()
os.chdir(ROOT)
pid = args.serve_pid
static_args = "--disable-dynamic-vram --disable-comfy-compiler --cache-none --reserve-vram 1"


def state(phase, **details):
    data = {"phase": phase, "servePid": pid, **details}
    (OUT / "diagnostic_phases.json").write_text(json.dumps(data, indent=2) + "\n")
    print(json.dumps(data), flush=True)


def idle_or_unavailable():
    try:
        with urllib.request.urlopen("http://127.0.0.1:8190/queue", timeout=5) as response:
            queue = json.load(response)
        return not queue["queue_running"] and not queue["queue_pending"]
    except (urllib.error.URLError, TimeoutError):
        # The verified serve loop may be waiting after a preemption.
        return True


def wait_for_runtime():
    while True:
        try:
            with urllib.request.urlopen("http://127.0.0.1:8190/system_stats", timeout=5) as response:
                json.load(response)
            return
        except (urllib.error.URLError, TimeoutError):
            time.sleep(15)


def switch(cap, *, budget=None):
    global pid
    if cap not in (None, "static", "dynamic-no-compiler", 8):
        raise ValueError("Unknown diagnostic runtime profile")
    # Existing SDK work finishes before any runtime change.
    with (OUT / "bench.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        deadline = time.monotonic() + 3600
        while not idle_or_unavailable():
            if time.monotonic() > deadline:
                raise TimeoutError("Runtime did not become idle for the phase change")
            time.sleep(5)
        env = dict(os.environ, BUDGET_GB=str(args.budget_gb if budget is None else budget), NIGHTSHIFT_STACK_DIAGNOSTICS="1")
        env.pop("NIGHTSHIFT_TORCH_VRAM_GB", None)
        env.pop("FISH_DRAMA3_CUDA_GRAPH", None)
        env["NIGHTSHIFT_COMFY_ARGS"] = static_args if cap is not None else "--cache-none"
        if cap == "dynamic-no-compiler":
            env["NIGHTSHIFT_COMFY_ARGS"] = "--disable-comfy-compiler --cache-none"
        if cap == 8:
            env["NIGHTSHIFT_TORCH_VRAM_GB"] = str(cap)
        result = subprocess.run(["scripts/spark/restart.sh", str(pid)], env=env,
                                text=True, capture_output=True, check=True)
        print(result.stdout, end="", flush=True)
        match = re.search(r"started serve loop (\d+)", result.stdout)
        if not match:
            raise RuntimeError("Replacement serve PID was not returned")
        pid = int(match[1])


with (OUT / "diagnostic_phases.lock").open("a") as phase_lock:
    fcntl.flock(phase_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    state("waiting_for_active_case")
    changed = False
    try:
        with (OUT / "bench.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            subprocess.run([sys.executable, "scripts/patch_moss_node.py",
                            "comfyui/custom_nodes/moss-image"], check=True)
        # Normal loading avoids the reproduced static VAE transfer stall.
        # The projection fix works independently of the VRAM loading policy.
        switch("dynamic-no-compiler" if args.gptq_only else None)
        changed = True
        state("waiting_for_runtime")
        wait_for_runtime()
        state("moss_gptq_compiler_test" if args.gptq_only else "moss_fused_projection_tests")
        subprocess.run([sys.executable, "scripts/spark/audio_image_lab.py",
                        "moss-gptq-no-compiler" if args.gptq_only else "moss-fused"], check=True)
        if args.gptq_only:
            sys.exit(0)
        state("starting_capped_kandinsky")
        switch(8)
        while True:
            try:
                queue = json.loads((OUT / "remaining_queue.json").read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                queue = {}
            if queue.get("status") == "finished":
                break
            time.sleep(10)
        state("capped_queue_finished")
    finally:
        if changed:
            switch(None, budget=args.restore_budget_gb)
            state("restored_normal_profile")
