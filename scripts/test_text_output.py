"""CPU regression at the actual comfy-api-proxy output boundary.

uv run --no-project --python 3.12 --with comfy-api-proxy==0.1.6 python scripts/test_text_output.py
No ComfyUI server, model, or GPU is started.
"""

import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from comfy_api_proxy.app import Proxy


class TextOutputTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        folders = types.ModuleType("folder_paths")
        folders.get_output_directory = lambda: str(self.directory)

        def target(prefix, output):
            path = Path(output) / prefix
            path.parent.mkdir(parents=True, exist_ok=True)
            return (
                str(path.parent),
                path.name,
                1,
                str(path.parent.relative_to(output)),
                prefix,
            )

        folders.get_save_image_path = target
        with patch.dict(sys.modules, {"folder_paths": folders}):
            spec = importlib.util.spec_from_file_location(
                "text_node",
                Path(__file__).resolve().parents[1] / "comfy_nodes/nightshift/text.py",
            )
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        self.node = module.SaveText()
        self.proxy = Proxy.__new__(Proxy)
        # Signing is unrelated to the history-to-asset parser under test.
        self.proxy._asset_id = lambda *_: "test-asset"

    def test_written_file_without_ui_metadata_is_not_an_sdk_output(self):
        path = self.directory / "orphan.json"
        path.write_text('{"shots": []}')
        outputs = self.proxy._outputs(
            "test-job", {"outputs": {"3": {}}}, "http://localhost"
        )
        self.assertTrue(path.exists())
        self.assertEqual(outputs, [])

    def test_saved_json_becomes_a_text_asset_and_preserves_exact_utf8(self):
        text = json.dumps(
            {"shots": [{"prompt": "café", "durationSec": 4}]}, ensure_ascii=False
        )
        saved = self.node.save(text, "nightshift/shot_list")
        outputs = self.proxy._outputs(
            "test-job", {"outputs": {"3": saved["ui"]}}, "http://localhost"
        )
        self.assertEqual(len(outputs), 1)
        asset = outputs[0]
        self.assertEqual(
            (asset["node_id"], asset["type"], asset["content_type"]),
            ("3", "text", "application/json"),
        )
        self.assertEqual(
            (self.directory / "nightshift" / asset["name"]).read_text(), text
        )

    def test_repeated_save_does_not_overwrite_previous_evidence(self):
        first = self.node.save("first output", "nightshift/shot_list")["ui"]["text"][0]
        second = self.node.save("second output", "nightshift/shot_list")["ui"]["text"][
            0
        ]
        self.assertNotEqual(first["filename"], second["filename"])
        for metadata, expected in [(first, "first output"), (second, "second output")]:
            self.assertEqual(
                (
                    self.directory / metadata["subfolder"] / metadata["filename"]
                ).read_text(),
                expected,
            )


if __name__ == "__main__":
    unittest.main()
