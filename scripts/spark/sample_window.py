"""Sample only our job's scheduler accounting (see scheduler.py) during a real attached-engine project.

Run detached on the GPU box. Touch <output>.stop to finish early. No runtime changes.
The samples include model caches and host memory, not only CUDA allocations.
"""

import argparse
import json
import re
import time
from datetime import UTC, datetime
from pathlib import Path

import scheduler

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output", type=Path)
parser.add_argument("--seconds", type=int, default=7200)
args = parser.parse_args()
args.output.parent.mkdir(parents=True, exist_ok=True)
deadline = time.monotonic() + args.seconds
with args.output.open("a", buffering=1) as output:
    while time.monotonic() < deadline and not Path(str(args.output) + ".stop").exists():
        status = scheduler.status()
        match = re.search(rf"{re.escape(scheduler.JOB)}\s+.*?budget\s+([\d.]+) GB\s+use\s+([\d.]+) GB", status)
        output.write(json.dumps({"at": datetime.now(UTC).isoformat(),
                                 "budgetGb": float(match[1]) if match else None,
                                 "usedGb": float(match[2]) if match else None}) + "\n")
        time.sleep(1)
