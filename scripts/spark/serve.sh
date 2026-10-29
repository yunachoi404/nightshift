#!/usr/bin/env bash
# Serve this repo's ComfyUI to the network on port 8190, for Nightshift's remote and attach modes.
#
# On a shared GPU box, NIGHTSHIFT_GPU_SCHEDULER names the box's memory scheduler. ComfyUI then runs inside it,
# preemptible, so it always gives way to other work:
#   <scheduler> --name <job> --budget-gb <n> --preemptible --ready-url <url> --ready-timeout <s> -- <command>
# The scheduler exits 75 while there is no room and never restarts a preempted job, so this loop does: every
# minute while there is no room (exit 75), every 5 minutes after a preemption or crash. It stops only on a clean
# exit; stop it by killing this loop first, then the server. Set NIGHTSHIFT_GPU_SCHEDULER (and NIGHTSHIFT_GPU_JOB)
# in the environment or in scripts/spark/local.env (gitignored). On a GPU box of your own, set it to "none".
#
#   NIGHTSHIFT_GPU_SCHEDULER=none scripts/spark/serve.sh   # your own box: ComfyUI runs directly
#   scripts/spark/serve.sh                                  # shared box: 56 GB lab request, no graph cache
#   BUDGET_GB=48 PORT=8190 scripts/spark/serve.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
. "$ROOT/scripts/spark/scheduler.sh"
PORT="${PORT:-8190}"
BUDGET_GB="${BUDGET_GB:-56}"
if [ -z "$SCHEDULER" ]; then
  echo "Set NIGHTSHIFT_GPU_SCHEDULER to the GPU box's memory scheduler, or to none to run ComfyUI directly." >&2
  exit 2
fi
mkdir -p "$ROOT/outputs" "$ROOT/inputs"
if [ -n "${NIGHTSHIFT_COMFY_ARGS+x}" ]; then
  read -ra EXTRA_ARGS <<< "$NIGHTSHIFT_COMFY_ARGS"
else
  EXTRA_ARGS=(--cache-none)
fi
WRAP=()
if [ "$SCHEDULER" != none ]; then
  WRAP=("$SCHEDULER" --name "$JOB" --budget-gb "$BUDGET_GB" --preemptible
    --ready-url "http://127.0.0.1:$PORT/system_stats" --ready-timeout 600 --)
fi

while true; do
  ${WRAP[@]+"${WRAP[@]}"} \
    "$ROOT/comfyui/.venv/bin/python" "$ROOT/comfyui/main.py" \
      --listen 0.0.0.0 --port "$PORT" \
      --output-directory "$ROOT/outputs" --input-directory "$ROOT/inputs" \
      --disable-pinned-memory --disable-cuda-malloc ${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"} &
  child=$!
  trap 'kill "$child" 2>/dev/null; wait "$child"; exit 0' TERM INT
  wait "$child"
  code=$?
  trap - TERM INT
  case "$code" in
    0) exit 0 ;;
    75) echo "$(date '+%F %T') no GPU room yet, retrying in 60s" >&2; sleep 60 ;;
    *) echo "$(date '+%F %T') stopped (exit $code, likely preempted), retrying in 5 min" >&2; sleep 300 ;;
  esac
done
