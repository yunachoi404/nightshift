"""NightshiftYuE2Instrumental: YuE2's instrumental recipe, on a real plan from the lab, and the graph that runs it.

uv run --no-project --python 3.12 python -m unittest scripts/test_yue2_instrumental.py
No ComfyUI, model or GPU. The fixture is the planner's score for "Slow piano, warm, a little hopeful", seed 42
(research/2026-10-31_yue2_music.md).
"""

import json
import sys
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# The pack's modules without its __init__, which needs ComfyUI.
package = types.ModuleType("nightshift")
package.__path__ = [str(ROOT / "comfy_nodes/nightshift")]
sys.modules.setdefault("nightshift", package)
from nightshift.music import PLAN_LYRICS, YuE2Instrumental, arrange, has_words  # noqa: E402
from nightshift.yue2_score.abc_tools import parse_abc  # noqa: E402

PLAN = (ROOT / "scripts/fixtures/yue2_plan_piano.abc").read_text()
STYLE = "Slow piano, warm, a little hopeful"


class ArrangeTest(unittest.TestCase):
    def test_without_words_the_vocal_melody_moves_to_the_instrument(self):
        abc, style, lyrics = arrange(PLAN, STYLE, PLAN_LYRICS)
        before, after = parse_abc(PLAN).voices, parse_abc(abc).voices
        self.assertGreater(len(before["Vocal"].notes), 0)
        self.assertEqual(after["Vocal"].notes, [])
        self.assertEqual(len(after["Ins"].notes), len(before["Vocal"].notes) + len(before["Ins"].notes))
        self.assertEqual(style, "Instrumental, Slow piano, warm, a little hopeful, no vocals, no singing, no choir, no spoken words.")
        self.assertEqual(lyrics, "[Intro]\n\n[Verse]\n\n[Chorus]\n\n[Interlude]\n\n[Verse]\n\n[Chorus]\n\n[Outro]\n")

    def test_a_style_that_says_instrumental_keeps_its_words(self):
        _, style, _ = arrange(PLAN, "Instrumental cinematic curiosity. No vocals.", PLAN_LYRICS)
        self.assertEqual(style, "Instrumental cinematic curiosity. No vocals, no singing, no choir, no spoken words.")

    def test_words_are_sung_over_the_plan_as_it_is(self):
        words = "[Verse]\nStreetlights hum a quiet tune\n"
        self.assertEqual(arrange(PLAN, STYLE, words), (PLAN, STYLE, words))

    def test_a_plan_the_converter_refuses_renders_without_a_plan(self):
        with self.assertLogs(level="WARNING"):
            self.assertEqual(arrange("not a score", STYLE, PLAN_LYRICS), ("", STYLE, ""))

    def test_only_section_tags_are_not_words(self):
        self.assertFalse(has_words(PLAN_LYRICS))
        self.assertFalse(has_words(""))
        self.assertTrue(has_words("[Chorus]\nHold the city in our light"))


class GraphTest(unittest.TestCase):
    def test_the_shipped_graph_plans_a_song_form_and_renders_what_the_node_returns(self):
        graph = json.loads((ROOT / "workflows/yue2_music.api.json").read_text())
        ref = json.loads((ROOT / "workflows/yue2_music.api.ref.json").read_text())
        node = next(k for k, v in graph.items() if v["class_type"] == "NightshiftYuE2Instrumental")
        music = next(v for v in graph.values() if v["class_type"] == "YuE2GenerateMusic")["inputs"]
        for name in ["abc", "style", "lyrics"]:
            self.assertEqual(music[name], [node, YuE2Instrumental.RETURN_NAMES.index(name)])
        lyrics = ref["inputs"]["lyrics"]
        self.assertEqual(graph[lyrics["node"]]["inputs"][lyrics["field"]], PLAN_LYRICS)
        self.assertEqual(len(YuE2Instrumental.RETURN_TYPES), len(YuE2Instrumental.RETURN_NAMES))


if __name__ == "__main__":
    unittest.main()
