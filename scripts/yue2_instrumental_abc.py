"""Lab: turn the planner's scores into instrumental render requests with the node pack's own code.

Reads ROOT/plan_<prompt>[_seed<n>]/15/*.json (scripts/spark/music_lab.py plan) and writes ROOT/abc/ under the same
name, which `music_lab.py render` submits. NightshiftYuE2Instrumental runs the same `arrange` inside the shipped graph.

    python3 scripts/yue2_instrumental_abc.py outputs/model_lab/music_ab
"""

import json
import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
# Import the pack's modules without its __init__, which needs ComfyUI.
package = types.ModuleType("nightshift")
package.__path__ = [str(ROOT / "comfy_nodes/nightshift")]
sys.modules["nightshift"] = package
from nightshift.music import PLAN_LYRICS, arrange  # noqa: E402
from nightshift.yue2_score.instrumentalize import convert_score  # noqa: E402
from spark.music_lab import PLAN_LYRICS as LAB_PLAN_LYRICS, PROMPTS  # noqa: E402

assert PLAN_LYRICS == LAB_PLAN_LYRICS
root = Path(sys.argv[1])
(root / "abc").mkdir(exist_ok=True)
for folder in sorted(root.glob("plan_*")):
    name = folder.name.removeprefix("plan_")
    prompt, style = name.split("_")[0], PROMPTS[name.split("_")[0]]
    plan = next((folder / "15").glob("*.json")).read_text()
    abc, render_style, lyrics = arrange(plan, style, PLAN_LYRICS)
    _, check = convert_score(plan)
    request = {"abc": abc, "style": render_style, "lyrics": lyrics, "mode": "full", "plan": plan, "transfer": check}
    (root / "abc" / f"{name}.json").write_text(json.dumps(request, indent=2, default=str) + "\n")
    print(name, render_style, repr(lyrics), {k: check[k] for k in ["vocal_notes_before", "original_ins_notes", "output_ins_notes", "nominal_seconds"]})
