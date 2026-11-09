#!/usr/bin/env bash
# Shared by the scripts in this folder: the environment's region, from infra/terraform/env/<env>.tfvars.
#   source "$(dirname "$0")/env.sh" <test|production>
env_name="${1:?an environment name: test or production}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Git Bash on Windows rewrites arguments that start with "/" (log group names) into Windows paths.
# Use Windows-style paths ourselves and switch that rewriting off.
if command -v cygpath >/dev/null 2>&1; then
  here="$(cygpath -m "$here")"
  export MSYS_NO_PATHCONV=1
fi
tfvars="$here/../terraform/env/$env_name.tfvars"
[ -f "$tfvars" ] || { echo "no such environment: $env_name" >&2; exit 2; }
region=$(sed -n 's/^region *= *"\([^"]*\)".*/\1/p' "$tfvars")
region="${region:-eu-central-1}"
AWS="${AWS:-aws}"
TERRAFORM="${TERRAFORM:-terraform}"
prefix="sentryops-$env_name"
tf() { "$here/tf.sh" "$env_name" "$@"; }

# Waits for a one-off task to stop, for up to $2 minutes (default 60). `aws ecs wait tasks-stopped`
# gives up after 10 minutes, while a long migration is still running (review L-23).
wait_task_stopped() {
  local task="$1" minutes="${2:-60}" status=""
  for _ in $(seq 1 $((minutes * 4))); do
    status=$("$AWS" ecs describe-tasks --region "$region" --cluster "$cluster" --tasks "$task" \
      --query 'tasks[0].lastStatus' --output text)
    [ "$status" = "STOPPED" ] && return 0
    sleep 15
  done
  echo "task $task still $status after $minutes minutes" >&2
  return 1
}
