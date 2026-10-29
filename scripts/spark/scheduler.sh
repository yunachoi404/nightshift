# Sourced by serve.sh and restart.sh. Sets SCHEDULER and JOB: the shared GPU box's memory scheduler command
# (or "none") and our job's name in it. The environment wins over scripts/spark/local.env (gitignored).
# scheduler.py reads the same settings for the Python lab scripts.
_local_env="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/local.env"
_setting() {
  local value="${!1-}"
  if [ -z "$value" ] && [ -f "$_local_env" ]; then value="$(. "$_local_env" && printf '%s' "${!1-}")"; fi
  printf '%s' "$value"
}
SCHEDULER="$(_setting NIGHTSHIFT_GPU_SCHEDULER)"
JOB="$(_setting NIGHTSHIFT_GPU_JOB)"
JOB="${JOB:-ohf-comfyui}"
