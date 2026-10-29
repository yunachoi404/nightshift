#!/usr/bin/env bash
# Pinned model node packs, without a ComfyUI upgrade or model downloads.
# WITH_IMAGE_VIDEO_NODES=1 adds MOSS and Kandinsky. The Spark can opt into
# read-only shared audio links with NIGHTSHIFT_LINK_SHARED_AUDIO=1.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMFY="${NIGHTSHIFT_COMFY_DIR:-$ROOT/comfyui}"
TASK_UV="$(command -v uv)"
WORKFLOWS=(breeze_tts2.api.json)
if [ "${WITH_IMAGE_VIDEO_NODES:-0}" = "1" ]; then
  WORKFLOWS+=(moss_image_int8.api.json kandinsky6_lite_draft.api.json)
fi
"$COMFY/.venv/bin/python" "$ROOT/comfy_nodes/nightshift/install_upstream.py" \
  --comfy-dir "$COMFY" --uv "$TASK_UV" --workflows "${WORKFLOWS[@]}"
ln -sfn "$ROOT/comfy_nodes/nightshift" "$COMFY/custom_nodes/nightshift"
if [ "${NIGHTSHIFT_LINK_SHARED_AUDIO:-0}" = "1" ]; then
  "$COMFY/.venv/bin/python" "$ROOT/scripts/spark/link_shared_audio.py"
fi
