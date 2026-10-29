"""CPU regression using real AAC packets and the actual proxy output parser.

uv run --python 3.12 --with comfy-api-proxy==0.1.6 python scripts/test_preserve_video_audio.py
"""

import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from comfy_api_proxy.app import Proxy


class PreserveAudioTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        for name, frequency in [("draft", 440), ("rendered", 880)]:
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64:r=24:d=2",
                            "-f", "lavfi", "-i", f"sine=frequency={frequency}:sample_rate=48000:duration=2",
                            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
                            str(self.root / (name + ".mp4"))], check=True)
        folders = types.ModuleType("folder_paths")
        folders.get_annotated_filepath = lambda value: str(self.root / value)
        folders.get_output_directory = lambda: str(self.root)
        folders.get_save_image_path = lambda *args: (str(self.root), "final", 1, "", "final")
        api = types.ModuleType("comfy_api.latest")
        api.Types = types.SimpleNamespace(VideoContainer=lambda value: value, VideoCodec=lambda value: value)
        with patch.dict(sys.modules, {"folder_paths": folders, "comfy_api.latest": api}):
            spec = importlib.util.spec_from_file_location("video_node", Path(__file__).resolve().parents[1] / "comfy_nodes/nightshift/video.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
        self.node = module.SaveVideoPreserveAudio()
        self.module_api = api
        source = self.root / "rendered.mp4"
        self.video = types.SimpleNamespace(get_dimensions=lambda: (64, 64), save_to=lambda path, **kwargs: shutil.copyfile(source, path))

    def packets(self, file, selector):
        value = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", selector,
                                                   "-show_packets", "-show_data_hash", "sha256", "-of", "json", str(file)]))
        return [packet["data_hash"] for packet in value["packets"]]

    def test_copies_both_packet_streams_and_publishes_sdk_output(self):
        with patch.dict(sys.modules, {"comfy_api.latest": self.module_api}):
            saved = self.node.save(self.video, "draft.mp4", "final")
        output = self.root / saved["ui"]["images"][0]["filename"]
        self.assertEqual(self.packets(output, "a"), self.packets(self.root / "draft.mp4", "a"))
        self.assertEqual(self.packets(output, "v"), self.packets(self.root / "rendered.mp4", "v"))
        def pcm(path):
            return subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-f", "f32le", "-"])
        self.assertEqual(pcm(output), pcm(self.root / "draft.mp4"))
        proxy = Proxy.__new__(Proxy)
        proxy._asset_id = lambda *_: "test-asset"
        assets = proxy._outputs("job", {"outputs": {"25": saved["ui"]}}, "http://localhost")
        self.assertEqual(len(assets), 1)
        self.assertEqual(assets[0]["node_id"], "25")
        self.assertEqual(assets[0]["content_type"], "video/mp4")

    def test_missing_reference_does_not_publish_a_partial_final(self):
        with patch.dict(sys.modules, {"comfy_api.latest": self.module_api}):
            with self.assertRaisesRegex(ValueError, "draft video is missing"):
                self.node.save(self.video, "missing.mp4", "final")
        self.assertFalse((self.root / "final_00001_.mp4").exists())


if __name__ == "__main__":
    unittest.main()
