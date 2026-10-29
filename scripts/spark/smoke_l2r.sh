#!/usr/bin/env bash
# One-off smoke test: wait for GPU room, render outputs/smoke through Layout-To-Render, drop back to a small budget.
# Run on the Spark from the repo root with setsid; logs to smoke_l2r.log.
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT="$PWD"

stop_serve() {
  for p in $(pgrep -f "bash scripts/spark/[s]erve.sh"); do kill "$p"; done
  for p in $(pgrep -f -- "--name [o]hf-comfyui"); do kill "$p"; done
  sleep 5
  for p in $(pgrep -f "$ROOT/comfyui/[m]ain.py"); do kill "$p"; done
  sleep 3
}

start_serve() {
  (BUDGET_GB="$1" setsid nohup scripts/spark/serve.sh >>serve.log 2>&1 </dev/null &)
}

stop_serve
start_serve 46
echo "$(date '+%F %T') waiting for a 46 GB slot"
until curl -sf http://127.0.0.1:8190/system_stats >/dev/null; do sleep 20; done
echo "$(date '+%F %T') ComfyUI up, rendering"

COMFY_BASE_URL=http://127.0.0.1:8191 .venv-proxy/bin/python scripts/run_workflow.py workflows/layout_to_render.api.json \
  --file 5001.file=outputs/smoke/layout.mp4 \
  --file 9009.image=outputs/smoke/look/look_00001_.png \
  --set "5508.value=A woman in a long red wool coat walks away down the middle of a city street at dusk after rain. Wet asphalt reflects warm shop lights, tall glass and concrete office towers on both sides, soft haze. The camera dollies forward low behind her. Shot on 35mm film." \
  --out outputs/smoke/render
echo "$(date '+%F %T') render exit $?"

stop_serve
start_serve 18
