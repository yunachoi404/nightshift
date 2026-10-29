"""Run the SDK runner and sample our job's scheduler-accounted usage once a second.

Run on the GPU box. Pass all run_workflow.py arguments after the output directory.
The reported peak includes cached models and host anonymous memory, as the box's scheduler counts them
(see scheduler.py).
It is a sampled process peak, not a CUDA allocator peak or a strict VRAM fit proof.
"""

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

import scheduler


def runtime_details():
    details = {}
    try:
        with urllib.request.urlopen(
            "http://127.0.0.1:8190/system_stats", timeout=5
        ) as response:
            system = json.load(response).get("system", {})
        for key in ["comfyui_version", "python_version", "pytorch_version"]:
            if key in system:
                details[key] = system[key]
        # Record cache mode without copying arbitrary server arguments into evidence.
        details["graphCache"] = (
            "none"
            if "--cache-none" in system.get("argv", [])
            else "default or unspecified"
        )
        details["dynamicVramDisabled"] = "--disable-dynamic-vram" in system.get("argv", [])
        details["compilerDisabled"] = "--disable-comfy-compiler" in system.get("argv", [])
        with urllib.request.urlopen(
            "http://127.0.0.1:8190/object_info/NightshiftRuntimeInfo", timeout=5
        ) as response:
            info = json.load(response)
        details["cudaAllocatorCapGb"] = info["NightshiftRuntimeInfo"]["input"][
            "required"
        ]["cuda_limit_gb"][1]["default"]
    except (urllib.error.URLError, TimeoutError, ValueError, KeyError):
        pass
    return details


out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
# This helper owns only the Spark's local proxy, including when called directly.
os.environ.setdefault("COMFY_BASE_URL", "http://127.0.0.1:8191")
# Keep independent lab drivers from queuing into one another's measurements.
with Path("outputs/model_lab/bench.lock").open("a") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    deadline = time.monotonic() + 1800
    while True:
        try:
            with urllib.request.urlopen(
                "http://127.0.0.1:8190/queue", timeout=15
            ) as response:
                queue = json.load(response)
        except (urllib.error.URLError, TimeoutError):
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    "ComfyUI did not become available within 30 minutes"
                ) from None
            time.sleep(2)
            continue
        if not queue["queue_running"] and not queue["queue_pending"]:
            break
        if time.monotonic() >= deadline:
            raise TimeoutError("ComfyUI queue did not become idle within 30 minutes")
        time.sleep(1)
    if os.environ.get("NIGHTSHIFT_WARM") != "1":
        # Release the previous case 's models and graph cache before the next measurement.
        # This is a runtime housekeeping endpoint, never a generation submission.
        request = urllib.request.Request(
            "http://127.0.0.1:8190/free",
            data=json.dumps({"unload_models": True, "free_memory": True}).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=15) as response:
            response.read()
        # The server applies /free on its worker loop. Let that idle housekeeping finish.
        time.sleep(2)
    start = time.monotonic()
    runtime = runtime_details()
    peak = 0.0
    samples = 0
    with (out / "runner.log").open("w") as log:
        proc = subprocess.Popen(
            [
                sys.executable,
                "-u",
                "scripts/run_workflow.py",
                *sys.argv[2:],
                "--out",
                str(out),
            ],
            stdout=log,
            stderr=subprocess.STDOUT,
        )
        while True:
            status = scheduler.status()
            match = re.search(rf"{re.escape(scheduler.JOB)}\s+.*?use\s+([\d.]+) GB", status)
            if match:
                peak = max(peak, float(match.group(1)))
                samples += 1
            if proc.poll() is not None:
                break
            time.sleep(1)
    code = proc.wait()
    result = {
        "seconds": time.monotonic() - start,
        "peakGb": peak if samples else None,
        "measured": bool(samples),
        "method": "scheduler-accounted process GB, 1s samples, includes cache",
        "samples": samples,
        "cachePolicy": "warm"
        if os.environ.get("NIGHTSHIFT_WARM") == "1"
        else "release models before job",
        "exitCode": code,
        "runtime": runtime,
    }
    (out / "measurement.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result), flush=True)
    raise SystemExit(code)
