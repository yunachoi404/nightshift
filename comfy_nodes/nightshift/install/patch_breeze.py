"""Fix buffer placement and discarded-model offloading in the pinned Apache Breeze pack.

Reproduced through the SDK with DynamicVRAM disabled: audio_tokens_offsets
stayed on CPU while token ids were on CUDA. Moving parameters via ModelPatcher
does not move these deterministic nonpersistent buffers. Reapply after checkout.
"""

import argparse
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("node_directory")
a = ap.parse_args()
path = Path(a.node_directory) / "loader.py"
source = path.read_text()
marker = "# Nightshift: static ModelPatcher leaves nonpersistent buffers on CPU."
if marker in source:
    print("Breeze static buffer fix already applied")
else:
    target = "        mm.load_models_gpu(to_load)\n"
    if source.count(target) != 1:
        raise RuntimeError(
            "Pinned Breeze loader changed. Inspect it before applying the buffer fix."
        )
    patch = (
        target
        + """        # Nightshift: static ModelPatcher leaves nonpersistent buffers on CPU.
        for patcher in to_load:
            if not patcher.is_dynamic():
                for child in patcher.model.modules():
                    for name, buffer in child.named_buffers(recurse=False):
                        if buffer is not None and buffer.device != patcher.load_device:
                            child._buffers[name] = buffer.to(patcher.load_device)
"""
    )
    path.write_text(source.replace(target, patch))
    print("Applied Breeze static buffer device fix")

# Hard unload destroys the bundle next. Moving its quantized weights back to CPU
# first can stall the queue for minutes. Unpatch in place before discarding it.
source = path.read_text()
discard_marker = "# Nightshift: discard without a redundant GPU-to-CPU weight copy."
if discard_marker in source:
    print("Breeze discarded-model fix already applied")
else:
    targets = {
        "def _unregister_from_comfy(patcher) -> None:\n":
            "def _unregister_from_comfy(patcher, *, discard=False) -> None:\n",
        "    patcher.detach()\n":
            "    # Nightshift: discard without a redundant GPU-to-CPU weight copy.\n"
            "    if discard:\n"
            "        patcher.unpatch_model(device_to=None)\n"
            "        patcher.detach(unpatch_all=False)\n"
            "    else:\n"
            "        patcher.detach()\n",
        "            _unregister_from_comfy(patcher)\n":
            "            _unregister_from_comfy(patcher, discard=hard)\n",
    }
    for target in targets:
        if source.count(target) != 1:
            raise RuntimeError("Pinned Breeze unload path changed. Inspect before patching.")
    for target, replacement in targets.items():
        source = source.replace(target, replacement)
    path.write_text(source)
    print("Applied Breeze discarded-model offload fix")
