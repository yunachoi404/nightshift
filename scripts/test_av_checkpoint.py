"""CPU regression for joint AV persistence. Run in the ComfyUI environment."""

import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "comfyui"))
from comfy.nested_tensor import NestedTensor

# The serialization code has no server dependency.
sys.modules.setdefault("folder_paths", types.ModuleType("folder_paths"))
spec = importlib.util.spec_from_file_location(
    "nightshift",
    Path(__file__).resolve().parents[1] / "comfy_nodes/nightshift/__init__.py",
)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


class CheckpointTest(unittest.TestCase):
    def test_both_modalities_and_masks_round_trip_exactly(self):
        streams = [
            torch.randn(1, 128, 3, 4, 6, dtype=torch.bfloat16),
            torch.randn(1, 8, 10, 16),
        ]
        masks = [torch.zeros(1, 1, 3, 4, 6), torch.ones(1, 1, 10, 16)]
        source = {
            "samples": NestedTensor(streams),
            "noise_mask": NestedTensor(masks),
            "batch_index": torch.tensor([42]),
            "type": "audio",
            "indices": [0, 1],
        }
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "draft.latent"
            module.save_av(source, path)
            restored = module.load_av(path)
        for key, a in source.items():
            b = restored[key]
            if not isinstance(a, (torch.Tensor, NestedTensor)):
                self.assertEqual(a, b)
                continue
            self.assertEqual(a.dtype, b.dtype)
            self.assertEqual(a.is_nested, b.is_nested)
            if a.is_nested:
                for x, y in zip(a.unbind(), b.unbind()):
                    self.assertTrue(torch.equal(x, y))
            else:
                self.assertTrue(torch.equal(a, b))

    def test_loader_restores_portrait_dimensions_and_fps(self):
        source = {
            "samples": NestedTensor(
                [torch.zeros(1, 128, 3, 20, 12), torch.zeros(1, 8, 10, 16)]
            ),
            "nightshift_fps": 30.0,
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "portrait.latent"
            module.save_av(source, path)
            with patch.object(
                module.folder_paths,
                "get_annotated_filepath",
                return_value=str(path),
                create=True,
            ):
                latent, width, height, fps = module.LoadAVLatent().load(str(path))
        self.assertEqual((width, height, fps), (384, 640, 30.0))
        self.assertNotIn("nightshift_fps", latent)
        self.assertTrue(
            torch.equal(latent["samples"].unbind()[0], source["samples"].unbind()[0])
        )

    def test_unknown_metadata_fails_instead_of_silently_losing_it(self):
        with (
            tempfile.TemporaryDirectory() as d,
            self.assertRaisesRegex(ValueError, "Unsupported latent metadata"),
        ):
            module.save_av(
                {"samples": torch.zeros(1), "future_field": object()},
                Path(d) / "bad.latent",
            )


if __name__ == "__main__":
    unittest.main()
