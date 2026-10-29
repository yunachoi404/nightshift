"""Optional allocator cap and matching ComfyUI memory accounting for fit tests.

ComfyUI's reserve-vram is subtracted from currently free memory. On a shared
unified-memory machine it cannot represent a fixed per-process cap. With dynamic
VRAM disabled, this adapter makes its loader see the same limit as PyTorch.
Normal runs leave this code inactive.
"""

import os

import torch

CONFIGURED_LIMIT_GB = 0.0


def configure_cap():
    global CONFIGURED_LIMIT_GB
    value = os.environ.get("NIGHTSHIFT_TORCH_VRAM_GB")
    if value is None:
        return
    import comfy.memory_management
    import comfy.model_management as mm

    if comfy.memory_management.aimdo_enabled:
        raise RuntimeError("Use --disable-dynamic-vram with NIGHTSHIFT_TORCH_VRAM_GB")

    limit = float(value) * 1_000_000_000
    if not torch.cuda.is_available():
        raise RuntimeError("NIGHTSHIFT_TORCH_VRAM_GB requires CUDA")
    total = torch.cuda.get_device_properties(0).total_memory
    if not 0 < limit <= total:
        raise ValueError(
            "Allocator cap must be positive and no larger than device memory"
        )
    torch.cuda.set_per_process_memory_fraction(limit / total, 0)
    original = mm.get_free_memory

    def capped_free_memory(dev=None, torch_free_too=False):
        device = mm.get_torch_device() if dev is None else dev
        result = original(device, torch_free_too=torch_free_too)
        if device.type != "cuda" or device.index not in (None, 0):
            return result
        available = max(0, limit - torch.cuda.memory_allocated(device))
        if torch_free_too:
            return min(result[0], available), min(result[1], available)
        return min(result, available)

    mm.get_free_memory = capped_free_memory
    CONFIGURED_LIMIT_GB = limit / 1e9
    print(
        f"[Nightshift] PyTorch and Comfy loader cap {limit / 1e9:.1f} GB. Dynamic VRAM must be disabled.",
        flush=True,
    )


class RuntimeInfo:
    """Read-only cap diagnostic. The input default reports the applied loader cap."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"cuda_limit_gb": ("FLOAT", {"default": CONFIGURED_LIMIT_GB})}
        }

    RETURN_TYPES = ("FLOAT",)
    FUNCTION = "report"
    CATEGORY = "Nightshift/lab"

    def report(self, cuda_limit_gb):
        return (CONFIGURED_LIMIT_GB,)
