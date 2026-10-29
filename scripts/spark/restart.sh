#!/usr/bin/env bash
# Stop only this repo's serve loop, by exact PID, then start its replacement.
# Current serve.sh forwards TERM and waits for the scheduler. Never targets other services on the box.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
. scripts/spark/scheduler.sh
OLD_PID="${1:?pass the PID of our scripts/spark/serve.sh loop}"
COMMAND="$(ps -p "$OLD_PID" -o args=)"
case "$COMMAND" in
  "bash scripts/spark/serve.sh"|"bash $ROOT/scripts/spark/serve.sh") ;;
  *) echo "Refusing to stop unexpected process: $OLD_PID" >&2; exit 1 ;;
esac
registered() {
  [ -n "$SCHEDULER" ] && [ "$SCHEDULER" != none ] && "$SCHEDULER" status | rg -q "^  $JOB "
}
kill "$OLD_PID"
# Wait for the old ComfyUI socket and its scheduler registration to disappear.
for ((i=0; i<60; i++)); do
  if ! curl -fsS http://127.0.0.1:8190/system_stats >/dev/null 2>&1 && ! registered; then
    setsid nohup scripts/spark/serve.sh >>serve.log 2>&1 </dev/null &
    echo "started serve loop $!"
    exit 0
  fi
  sleep 1
done
echo "Old runtime did not stop cleanly. Inspect its exact PID before proceeding." >&2
exit 1
