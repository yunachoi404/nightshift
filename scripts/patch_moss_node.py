"""Apply the packaged Nightshift compatibility patch."""

import runpy
from pathlib import Path

runpy.run_path(str(Path(__file__).resolve().parents[1] / "comfy_nodes/nightshift/install/patch_moss.py"), run_name="__main__")
