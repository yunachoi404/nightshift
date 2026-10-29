#!/usr/bin/env bash
# Install ComfyUI and the custom nodes this app needs into ./comfyui (gitignored).
# Works on Linux + NVIDIA (the DGX Spark, CUDA 13) and on Apple Silicon (MPS) for development.
#
#   scripts/setup_comfyui.sh                 # install or update
#   MODELS_BASE=/path/to/models scripts/setup_comfyui.sh   # also point ComfyUI at an existing model folder
#   WITH_LAB_NODES=1 scripts/setup_comfyui.sh               # also the lab-only packs below
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMFY="$ROOT/comfyui"
COMFY_REF="${COMFY_REF:-v0.41.3}"

# Lab packs, name|url|ref. No recipe uses them, so the engine does not install them and neither does this
# script unless WITH_LAB_NODES=1; the lab's layout_to_render graph uses LTXVideo. ComfyUI-LTXVideo's master
# is under the LTX-2 Community License; VideoHelperSuite and KJNodes are GPL-3.0.
# Recipe packs come from setup_model_lab_nodes.sh.
NODES=(
  "ComfyUI-LTXVideo|https://github.com/Lightricks/ComfyUI-LTXVideo|master"
  "ComfyUI-VideoHelperSuite|https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite|main"
  "ComfyUI-KJNodes|https://github.com/kijai/ComfyUI-KJNodes|main"
)

command -v uv >/dev/null || { echo "uv is required: https://docs.astral.sh/uv/" >&2; exit 1; }

if [ ! -d "$COMFY/.git" ]; then
  git clone --filter=blob:none https://github.com/comfyanonymous/ComfyUI "$COMFY"
fi
git -C "$COMFY" fetch --tags --quiet
git -C "$COMFY" checkout --quiet "$COMFY_REF"

if [ ! -x "$COMFY/.venv/bin/python" ]; then
  uv venv --python 3.12 "$COMFY/.venv"
fi
PY="$COMFY/.venv/bin/python"

if [ "$(uname -s)" = "Linux" ]; then
  uv pip install --python "$PY" torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu130
else
  uv pip install --python "$PY" torch torchvision torchaudio
fi
# transformers 5.21 changed the MimiModel that the pinned Breeze codec builds on (PYTHON_HOLDS in the engine).
uv pip install --python "$PY" -r "$COMFY/requirements.txt" "transformers<5.21"

if [ "${WITH_LAB_NODES:-0}" = "1" ]; then
  for entry in "${NODES[@]}"; do
    IFS='|' read -r name url ref <<<"$entry"
    dir="$COMFY/custom_nodes/$name"
    [ -d "$dir/.git" ] || git clone --filter=blob:none "$url" "$dir"
    git -C "$dir" fetch --quiet origin "$ref"
    git -C "$dir" checkout --quiet FETCH_HEAD
    [ -f "$dir/requirements.txt" ] && uv pip install --python "$PY" -r "$dir/requirements.txt"
  done
fi

# Our nodes stay in the repository; the runtime imports that exact checkout.
ln -sfn "$ROOT/comfy_nodes/nightshift" "$COMFY/custom_nodes/nightshift"

# Every normal recipe needs the patched Breeze node. Lower tiers also select
# MOSS/Kandinsky with WITH_IMAGE_VIDEO_NODES=1. This never installs Fish code.
if [ "${WITH_MODEL_NODES:-1}" = "1" ]; then
  NIGHTSHIFT_COMFY_DIR="$COMFY" "$ROOT/scripts/setup_model_lab_nodes.sh"
fi

if [ -n "${MODELS_BASE:-}" ]; then
  : >"$COMFY/extra_model_paths.yaml"
  i=0
  IFS=':' read -ra bases <<<"$MODELS_BASE"
  for base in "${bases[@]}"; do
    i=$((i + 1))
    cat >>"$COMFY/extra_model_paths.yaml" <<EOF
shared_$i:
  base_path: $base
  checkpoints: models/checkpoints/
  diffusion_models: models/diffusion_models/
  text_encoders: models/text_encoders/
  loras: models/loras/
  vae: models/vae/
  latent_upscale_models: models/latent_upscale_models/
  upscale_models: models/upscale_models/
  kandinsky6_audio_vae: models/audio_vae/
EOF
  done
  echo "Model paths -> $MODELS_BASE"
fi

echo "ComfyUI $(git -C "$COMFY" describe --tags) ready at $COMFY"
