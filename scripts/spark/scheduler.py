"""Our job's budget and use, from the shared GPU box's memory scheduler.

The lab measured process memory through the scheduler that shares the box between jobs. Its `status` lists
each job on a line like "  <job>  running  budget <n> GB  use <n> GB ... pid <n>". NIGHTSHIFT_GPU_SCHEDULER is
its command and NIGHTSHIFT_GPU_JOB our job's name (default ohf-comfyui), from the environment or else
scripts/spark/local.env (gitignored), as in scheduler.sh.
"""

import os
import shlex
import subprocess
from pathlib import Path

LOCAL_ENV = Path(__file__).with_name("local.env")


def _local_env():
    values = {}
    if LOCAL_ENV.exists():
        for line in LOCAL_ENV.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                words = shlex.split(value)
                values[key.strip()] = os.path.expandvars(words[0]) if words else ""
    return values


def setting(name, default=""):
    return os.environ.get(name) or _local_env().get(name) or default


JOB = setting("NIGHTSHIFT_GPU_JOB", "ohf-comfyui")


def status():
    command = setting("NIGHTSHIFT_GPU_SCHEDULER")
    if not command or command == "none":
        raise SystemExit(
            "Set NIGHTSHIFT_GPU_SCHEDULER (or scripts/spark/local.env) to the GPU box's memory scheduler"
        )
    return subprocess.run(
        [os.path.expanduser(command), "status"], capture_output=True, text=True, check=True
    ).stdout
