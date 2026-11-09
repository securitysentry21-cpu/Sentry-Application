#!/usr/bin/env bash
# Runs the platform operator CLI (apps/api/src/cli/operator.ts, D-19) as a one-off task inside the
# cell, with the API's own configuration and database role, and prints its output.
#   infra/scripts/operator.sh test create-organization --name "Alpha Security" --owner-email owner@alpha.pk
set -euo pipefail
source "$(dirname "$0")/env.sh" "${1:?usage: operator.sh <test|production> <operator command and options>}"
shift

command=$(node -e 'console.log(JSON.stringify(["node","apps/api/src/cli/operator.ts",...process.argv.slice(1)]))' "$@")
cluster=$(tf output -raw cluster)
subnets=$(tf output -json task_subnets | tr -d '[]" \r\n')
group=$(tf output -json task_security_groups | sed -n 's/.*"api": *"\([^"]*\)".*/\1/p')

# The output can hold an invitation link or, from create-canary, the canary phone's private key (it
# can sign an SOS), and logs never keep either (SEC §15): the task's log stream is deleted however
# this script ends (review L-13), after a Ctrl-C, a timeout or a failed AWS call too. A task still
# running is stopped first, so it cannot write them afterwards.
task=""
cleanup() {
  local status=$?
  if [ -n "$task" ]; then
    local last
    last=$("$AWS" ecs describe-tasks --region "$region" --cluster "$cluster" --tasks "$task" \
      --query 'tasks[0].lastStatus' --output text 2>/dev/null || echo unknown)
    if [ "$last" != "STOPPED" ]; then
      "$AWS" ecs stop-task --region "$region" --cluster "$cluster" --task "$task" \
        --reason "operator.sh ended before the task" >/dev/null 2>&1 || true
      wait_task_stopped "$task" 5 || true
    fi
    "$AWS" logs delete-log-stream --region "$region" --log-group-name "/$prefix/api" \
      --log-stream-name "api/api/${task##*/}" 2>/dev/null ||
      echo "could not delete the log stream api/api/${task##*/} in /$prefix/api (it may not exist, or" \
        "the AWS session expired): check it and delete it by hand. It can hold an invitation link or" \
        "the canary's private key (CANARY_DEVICE_KEY): after create-canary, treat that key as exposed" \
        "and make a new canary (review L-34)" >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

task=$("$AWS" ecs run-task --region "$region" --cluster "$cluster" --launch-type FARGATE \
  --task-definition "$(tf output -raw api_task_definition)" \
  --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$group],assignPublicIp=ENABLED}" \
  --overrides "{\"containerOverrides\":[{\"name\":\"api\",\"command\":$command}]}" \
  --query 'tasks[0].taskArn' --output text)
echo "operator task: $task"
wait_task_stopped "$task" 30
# The command's own exit code (quarantine-replay exits 1 when an item is still failing, 2 on bad arguments).
code=$("$AWS" ecs describe-tasks --region "$region" --cluster "$cluster" --tasks "$task" \
  --query 'tasks[0].containers[0].exitCode' --output text)
"$AWS" logs get-log-events --region "$region" --log-group-name "/$prefix/api" \
  --log-stream-name "api/api/${task##*/}" --query 'events[].message' --output text
# A task that never started has no exit code ("None"): that is a failure too.
case "$code" in '' | None | null) code=1 ;; esac
exit "$code"
