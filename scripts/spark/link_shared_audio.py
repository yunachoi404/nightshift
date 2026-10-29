"""Point Kandinsky's fixed audio lookup at read-only weights in configured shared roots.

The plugin resolves BigVGAN under models/audio_vae, outside its registered VAE lookup.
Only our own YAML and symlinks change. Nothing in the shared trees is written.
"""

from pathlib import Path

import yaml

root = Path(__file__).resolve().parents[2]
yaml_path = root / "comfyui/extra_model_paths.yaml"
config = yaml.safe_load(yaml_path.read_text()) if yaml_path.exists() else {}
for entry in config.values():
    base = Path(entry["base_path"]).expanduser()
    audio = base / "models/audio_vae"
    if not (audio / "v1-44.pth").exists():
        continue
    entry["kandinsky6_audio_vae"] = "models/audio_vae/"
    destination = root / "comfyui/models/audio_vae"
    destination.mkdir(parents=True, exist_ok=True)
    for name in ["v1-44.pth", "bigvgan_vocoder"]:
        target = destination / name
        if not target.exists():
            target.symlink_to(audio / name, target_is_directory=(audio / name).is_dir())
    print("Read-only audio links from configured shared model root")
yaml_path.write_text(yaml.safe_dump(config, sort_keys=False))
