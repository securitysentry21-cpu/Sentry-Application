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
task=$("$AWS" ecs run-task --region "$region" --cluster "$cluster" --launch-type FARGATE \
  --task-definition "$(tf output -raw api_task_definition)" \
  --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$group],assignPublicIp=ENABLED}" \
  --overrides "{\"containerOverrides\":[{\"name\":\"api\",\"command\":$command}]}" \
  --query 'tasks[0].taskArn' --output text)
echo "operator task: $task"
"$AWS" ecs wait tasks-stopped --region "$region" --cluster "$cluster" --tasks "$task"
"$AWS" logs get-log-events --region "$region" --log-group-name "/$prefix/api" \
  --log-stream-name "api/api/${task##*/}" --query 'events[].message' --output text
