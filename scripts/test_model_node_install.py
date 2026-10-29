"""Filesystem integration checks for the packaged, git-free install hook."""

import importlib.util
import io
import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

HOOK = Path(__file__).resolve().parents[1] / "comfy_nodes/nightshift/install_upstream.py"
spec = importlib.util.spec_from_file_location("node_install", HOOK)
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)


def archive(pack):
    content = io.BytesIO()
    files = {"upstream/requirements.txt": b"training-only\n",
             f"upstream/{pack['subdir']}/__init__.py": b"NODE_CLASS_MAPPINGS = {}\n"}
    if pack["name"] != "MOSS-Image":
        files[f"upstream/{pack['subdir']}/requirements.txt"] = b"node-only\n"
    with tarfile.open(fileobj=content, mode="w:gz") as bundle:
        for name, data in files.items():
            item = tarfile.TarInfo(name); item.size = len(data)
            bundle.addfile(item, io.BytesIO(data))
    return content.getvalue()


class NodeInstallTest(unittest.TestCase):
    def test_fresh_install_uses_nested_plugins_and_reuses_pinned_sources(self):
        with tempfile.TemporaryDirectory() as temporary:
            comfy = Path(temporary) / "comfyui"
            python = comfy / ".venv/bin/python"
            python.parent.mkdir(parents=True); python.touch()
            calls = []
            def download(request, **kwargs):
                pack = next(pack for pack in hook.PACKS if pack["ref"] in request.full_url)
                return io.BytesIO(archive(pack))
            argv = [str(HOOK), "--comfy-dir", str(comfy), "--uv", "fake-uv", "--workflows",
                    "moss_image_int8.api.json", "kandinsky6_lite_draft.api.json"]
            with patch.object(sys, "argv", argv), patch.object(hook.urllib.request, "urlopen", side_effect=download) as network, patch.object(hook.subprocess, "run", side_effect=lambda command, **kw: calls.append(command)):
                hook.main()
                self.assertEqual(network.call_count, 3)
                for name in ["ComfyUI-Breeze-TTS-2", "moss-image", "kandinsky6"]:
                    node = comfy / "custom_nodes" / name
                    self.assertTrue((node / "__init__.py").is_file())
                    self.assertTrue(node.resolve().is_relative_to(comfy.resolve()))
                requirements = [Path(call[-1]) for call in calls if call[0] == "fake-uv"]
                self.assertEqual(len(requirements), 2)
                self.assertTrue(all(path.read_text() == "node-only\n" for path in requirements))
                calls.clear(); network.reset_mock()
                hook.main()
                self.assertEqual(network.call_count, 0)
                self.assertFalse(any(call[0] == "fake-uv" for call in calls))
                self.assertEqual(len(calls), 2)  # Reapply our idempotent compatibility patches.
                installed = json.loads((comfy / ".nightshift-model-nodes.json").read_text())
                self.assertEqual(set(installed), {pack["name"] for pack in hook.PACKS})

    def test_other_comfyui_path_is_refused_before_network_or_mutation(self):
        argv = [str(HOOK), "--comfy-dir", str(Path.home() / "Dev/ComfyUI"), "--uv", "fake-uv"]
        with patch.object(sys, "argv", argv), patch.object(hook.urllib.request, "urlopen") as network:
            with self.assertRaisesRegex(RuntimeError, "ComfyUI of Nightshift's own"):
                hook.main()
            network.assert_not_called()

    def test_external_node_directory_is_not_modified(self):
        with tempfile.TemporaryDirectory() as temporary:
            comfy = Path(temporary) / "comfyui"
            python = comfy / ".venv/bin/python"
            python.parent.mkdir(parents=True); python.touch()
            external = Path(temporary) / "shared"
            external.mkdir()
            sentinel = external / "keep.txt"
            sentinel.write_text("untouched")
            (comfy / "custom_nodes").symlink_to(external, target_is_directory=True)
            argv = [str(HOOK), "--comfy-dir", str(comfy), "--uv", "fake-uv"]
            with patch.object(sys, "argv", argv), patch.object(hook.urllib.request, "urlopen") as network:
                with self.assertRaisesRegex(RuntimeError, "outside this ComfyUI"):
                    hook.main()
                network.assert_not_called()
            self.assertEqual(list(external.iterdir()), [sentinel])
            self.assertEqual(sentinel.read_text(), "untouched")


if __name__ == "__main__":
    unittest.main()
