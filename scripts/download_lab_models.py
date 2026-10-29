"""Download selected lab files into our ComfyUI only. Refuse files over 20 GB.

The HF tree supplies exact sizes and LFS SHA256. Existing shared weights are never changed.
"""

import argparse
import hashlib
import json
import urllib.request
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("group", choices=["ace", "moss", "moss-encoders", "krea"])
a = ap.parse_args()
root = Path(__file__).resolve().parents[1]
repo, files = {
    "ace": (
        "Comfy-Org/ace_step_1.5_ComfyUI_files",
        [
            "split_files/diffusion_models/acestep_v1.5_turbo.safetensors",
            "split_files/text_encoders/qwen_0.6b_ace15.safetensors",
            "split_files/text_encoders/qwen_1.7b_ace15.safetensors",
            "split_files/vae/ace_1.5_vae.safetensors",
        ],
    ),
    "krea": (
        "Comfy-Org/Krea-2",
        ["diffusion_models/krea2_turbo_int8_convrot.safetensors"],
    ),
    "moss": (
        "Comfy-Org/MOSS-Image",
        ["diffusion_models/moss_image_base_int8_convrot.safetensors"],
    ),
    "moss-encoders": (
        "Comfy-Org/MOSS-Image",
        ["text_encoders/qwen3.5_9b_int8_convrot.safetensors",
         "text_encoders/qwen3.5_9b_w4a8_gptq.safetensors"],
    ),
}[a.group]
source = json.loads((root / "research/2026-10-19_model_sources.json").read_text())[repo]
tree = {entry["path"]: entry for entry in source["files"]}
for name in files:
    meta = tree[name]
    if meta["size"] > 20_000_000_000:
        raise SystemExit(f"Report and obtain approval before downloading {name}")
    relative = name.removeprefix("split_files/")
    dest = root / "comfyui/models" / relative
    digest = meta.get("lfs", {}).get("oid")
    if dest.exists() and dest.stat().st_size == meta["size"]:
        print(f"present {relative}", flush=True)
        continue
    dest.parent.mkdir(parents=True, exist_ok=True)
    temp = dest.with_suffix(dest.suffix + ".part")
    sha = hashlib.sha256()
    print(f"downloading {relative} ({meta['size']} bytes)", flush=True)
    with (
        urllib.request.urlopen(
            f"https://huggingface.co/{repo}/resolve/{source['revision']}/{name}"
        ) as response,
        temp.open("wb") as out,
    ):
        while data := response.read(8 * 1024 * 1024):
            out.write(data)
            sha.update(data)
    if temp.stat().st_size != meta["size"] or digest and sha.hexdigest() != digest:
        raise RuntimeError(f"Size/checksum mismatch: {name}")
    temp.replace(dest)
    print(f"verified {relative} sha256={sha.hexdigest()}", flush=True)
