"""Nightshift nodes. AV checkpoints are safetensors, never pickle."""

import hashlib
import json
from pathlib import Path

import folder_paths
import torch
from comfy.nested_tensor import NestedTensor
from safetensors import safe_open
from safetensors.torch import save_file

from .diagnostics import configure_diagnostics
from .memory import configure_cap
from .text import SaveText
from .video import SaveVideoPreserveAudio

configure_cap()
configure_diagnostics()


def save_av(latent, path):
    tensors, layout = {}, {}
    for key, value in latent.items():
        if value is None:
            layout[key] = None
        elif isinstance(value, (torch.Tensor, NestedTensor)):
            parts = list(value.unbind()) if value.is_nested else [value]
            names = [f"{key}.{i}" for i in range(len(parts))]
            layout[key] = {"nested": value.is_nested, "tensors": names}
            tensors.update(
                {
                    name: part.detach().cpu().contiguous().clone()
                    for name, part in zip(names, parts)
                }
            )
        else:
            try:
                json.dumps(value, allow_nan=False)
            except (TypeError, ValueError) as error:
                raise ValueError(
                    f"Unsupported latent metadata {key}: {type(value).__name__}"
                ) from error
            layout[key] = {"value": value}
    save_file(
        tensors,
        str(path),
        metadata={"nightshift_av": "1", "layout": json.dumps(layout)},
    )


def load_av(path):
    result = {}
    with safe_open(str(path), framework="pt", device="cpu") as f:
        meta = f.metadata() or {}
        if meta.get("nightshift_av") != "1":
            raise ValueError("Expected a Nightshift AV checkpoint")
        for key, spec in json.loads(meta["layout"]).items():
            if spec is None:
                result[key] = None
            elif "value" in spec:
                result[key] = spec["value"]
            else:
                parts = [f.get_tensor(name) for name in spec["tensors"]]
                result[key] = NestedTensor(parts) if spec["nested"] else parts[0]
    return result


class SaveAVLatent:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "samples": ("LATENT",),
                "filename_prefix": ("STRING", {"default": "nightshift/draft"}),
            },
            "optional": {"fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 120.0})},
        }

    RETURN_TYPES = ("LATENT",)
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "Nightshift"

    def save(self, samples, filename_prefix, fps=24.0):
        directory, name, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, folder_paths.get_output_directory()
        )
        filename = f"{name}_{counter:05}_.latent"
        save_av(dict(samples, nightshift_fps=fps), Path(directory) / filename)
        return {
            "ui": {
                "latents": [
                    {"filename": filename, "subfolder": subfolder, "type": "output"}
                ]
            },
            "result": (samples,),
        }


class LoadAVLatent:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"latent": ("STRING", {"default": "draft.latent"})},
            "optional": {
                "spatial_factor": ("INT", {"default": 32, "min": 1, "max": 128})
            },
        }

    RETURN_TYPES = ("LATENT", "INT", "INT", "FLOAT")
    RETURN_NAMES = ("latent", "width", "height", "fps")
    FUNCTION = "load"
    CATEGORY = "Nightshift"

    @classmethod
    def VALIDATE_INPUTS(cls, latent, spatial_factor=32):
        return (
            True
            if folder_paths.exists_annotated_filepath(latent)
            else "AV checkpoint does not exist"
        )

    @classmethod
    def IS_CHANGED(cls, latent, spatial_factor=32):
        return hashlib.sha256(
            Path(folder_paths.get_annotated_filepath(latent)).read_bytes()
        ).hexdigest()

    def load(self, latent, spatial_factor=32):
        result = load_av(folder_paths.get_annotated_filepath(latent))
        samples = result["samples"]
        video = samples.unbind()[0] if samples.is_nested else samples
        fps = float(result.pop("nightshift_fps", 24.0))
        return (
            result,
            video.shape[-1] * spatial_factor,
            video.shape[-2] * spatial_factor,
            fps,
        )


NODE_CLASS_MAPPINGS = {
    "NightshiftSaveAVLatent": SaveAVLatent,
    "NightshiftLoadAVLatent": LoadAVLatent,
}

from .memory import RuntimeInfo

NODE_CLASS_MAPPINGS["NightshiftRuntimeInfo"] = RuntimeInfo
NODE_CLASS_MAPPINGS["NightshiftSaveText"] = SaveText
NODE_CLASS_MAPPINGS["NightshiftSaveVideoPreserveAudio"] = SaveVideoPreserveAudio
