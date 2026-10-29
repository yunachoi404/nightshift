"""Build the four-guide, 15-second What-if workflow from the measured LTX effect graph."""

import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def build():
    graph = json.loads((ROOT / "workflows/ltx25_effect.api.json").read_text())
    graph["28"]["inputs"]["value"] = 361
    graph["7"]["inputs"]["text"] = "One uninterrupted shot through an imagined change. Continuous motion, no cuts, no fades, no text. Quiet natural ambience, no speech or music."
    graph["8"]["inputs"]["text"] = "cuts, crossfade, dissolve, montage, frozen frame, static slideshow, camera jump, text, watermark, deformed objects, flicker"
    for output in ("20", "25"):
        graph[output]["inputs"]["filename_prefix"] = "nightshift/what_if"
    previous = "12"
    for index in (1, 2):
        node = 100 + index * 4
        graph[str(node)] = {"class_type": "LoadImage", "inputs": {"image": f"beat_{index}.png"}}
        graph[str(node + 1)] = copy.deepcopy(graph["31"])
        graph[str(node + 1)]["inputs"]["image"] = [str(node), 0]
        graph[str(node + 2)] = copy.deepcopy(graph["32"])
        graph[str(node + 2)]["inputs"]["image"] = [str(node + 1), 0]
        guide = copy.deepcopy(graph["33"])
        guide["inputs"].update(positive=[previous, 0], negative=[previous, 1], latent=[previous, 2],
                               image=[str(node + 2), 0], frame_idx=index * 120)
        graph[str(node + 3)] = guide
        previous = str(node + 3)
    graph["33"]["inputs"].update(positive=[previous, 0], negative=[previous, 1], latent=[previous, 2])
    ref = json.loads((ROOT / "workflows/ltx25_effect.api.ref.json").read_text())
    ref["workflow"] = "ltx25_what_if.api.json"
    ref["inputs"].update(image2={"node": "104", "field": "image"}, image3={"node": "108", "field": "image"})
    ref["params"].update(width=640, height=384, fps=24, maxFrames=361)
    return graph, ref


if __name__ == "__main__":
    graph, ref = build()
    for name, value in [("ltx25_what_if.api.json", graph), ("ltx25_what_if.api.ref.json", ref)]:
        (ROOT / "workflows" / name).write_text(json.dumps(value, indent=2) + "\n")
