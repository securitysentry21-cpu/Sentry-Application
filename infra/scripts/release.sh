#!/usr/bin/env bash
# Releases the image built for commit <sha> (by CI, ci.yml › image, or by build-image.sh):
#   1. the database task moves to the new image, and the migrations run (deploy-db.ts);
#   2. only if they succeed, the services move too, and the script waits until they are stable.
# The tags are recorded in infra/terraform/env/<environment>.release.tfvars; commit that file
# afterwards, so the repository always says what each environment runs.
#   infra/scripts/release.sh test <sha>
set -euo pipefail
source "$(dirname "$0")/env.sh" "${1:?usage: release.sh <test|production> <commit sha>}"
sha="${2:?usage: release.sh <test|production> <commit sha>}"
release_file="$here/../terraform/env/$env_name.release.tfvars"

"$AWS" ecr describe-images --region "$region" --repository-name sentryops --image-ids "imageTag=$sha" >/dev/null ||
  { echo "no image sentryops:$sha yet: run build-image.sh, or wait for CI's image job" >&2; exit 1; }

current=$(sed -n 's/^image_tag *= *"\(.*\)"/\1/p' "$release_file" 2>/dev/null || true)
write_release() { printf 'image_tag           = "%s"\nmigration_image_tag = "%s"\n' "$1" "$2" >"$release_file"; }

echo "== 1/2: migrations with $sha (services stay on ${current:-nothing yet})"
write_release "$current" "$sha"
tf apply -auto-approve

cluster=$(tf output -raw cluster)
subnets=$(tf output -json task_subnets | tr -d '[]" \r\n')
group=$(tf output -json task_security_groups | sed -n 's/.*"dbadmin": *"\([^"]*\)".*/\1/p')
task=$("$AWS" ecs run-task --region "$region" --cluster "$cluster" --launch-type FARGATE \
  --task-definition "$(tf output -raw dbadmin_task_definition)" \
  --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$group],assignPublicIp=ENABLED}" \
  --query 'tasks[0].taskArn' --output text)
echo "migration task: $task"
"$AWS" ecs wait tasks-stopped --region "$region" --cluster "$cluster" --tasks "$task"
code=$("$AWS" ecs describe-tasks --region "$region" --cluster "$cluster" --tasks "$task" \
  --query 'tasks[0].containers[0].exitCode' --output text)
"$AWS" logs tail "/$prefix/dbadmin" --region "$region" --since 30m --format short | tail -20 || true
if [ "$code" != "0" ]; then
  echo "migrations failed (exit $code); the services were not changed" >&2
  exit 1
fi

echo "== 2/2: services to $sha"
write_release "$sha" "$sha"
tf apply -auto-approve
"$AWS" ecs wait services-stable --region "$region" --cluster "$cluster" --services api web worker
echo "released $sha to $env_name: $(tf output -raw dashboard_url)"
echo "Commit infra/terraform/env/$env_name.release.tfvars."
