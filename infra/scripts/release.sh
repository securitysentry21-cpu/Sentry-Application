#!/usr/bin/env bash
# Releases the image built for commit <sha> (by CI, ci.yml › image, or by build-image.sh):
#   1. the database task moves to the new image, and the migrations run (deploy-db.ts);
#   2. only if they succeed, the services move too, and the script waits until they are stable.
# The tags are recorded in infra/terraform/env/<environment>.release.tfvars; commit that file
# afterwards, so the repository always says what each environment runs.
#   infra/scripts/release.sh test <sha>
# Each step applies a saved plan, and only if that plan changes nothing but the release (task
# definitions, the services, the database's running state). Other drift stops the release: apply it
# on its own first, after reading its plan (review L-23).
set -euo pipefail
source "$(dirname "$0")/env.sh" "${1:?usage: release.sh <test|production> <commit sha>}"
sha="${2:?usage: release.sh <test|production> <commit sha>}"
release_file="$here/../terraform/env/$env_name.release.tfvars"
cell="$here/../terraform/cell"
plan_name="release-$env_name.tfplan" # git-ignored (*.tfplan)

"$AWS" ecr describe-images --region "$region" --repository-name sentryops --image-ids "imageTag=$sha" >/dev/null ||
  { echo "no image sentryops:$sha yet: run build-image.sh, or wait for CI's image job" >&2; exit 1; }

# Review L-14: a released image also carries release-<sha>, which the repository's lifecycle keeps
# (services.tf), so the image an environment runs is never expired. Tags are immutable: a second
# release of the same commit finds the tag there already.
if ! "$AWS" ecr describe-images --region "$region" --repository-name sentryops \
  --image-ids "imageTag=release-$sha" >/dev/null 2>&1; then
  media_types=(application/vnd.oci.image.index.v1+json application/vnd.oci.image.manifest.v1+json
    application/vnd.docker.distribution.manifest.list.v2+json application/vnd.docker.distribution.manifest.v2+json)
  manifest=$("$AWS" ecr batch-get-image --region "$region" --repository-name sentryops \
    --image-ids "imageTag=$sha" --accepted-media-types "${media_types[@]}" \
    --query 'images[0].imageManifest' --output text)
  media=$("$AWS" ecr batch-get-image --region "$region" --repository-name sentryops \
    --image-ids "imageTag=$sha" --accepted-media-types "${media_types[@]}" \
    --query 'images[0].imageManifestMediaType' --output text)
  "$AWS" ecr put-image --region "$region" --repository-name sentryops --image-tag "release-$sha" \
    --image-manifest "$manifest" --image-manifest-media-type "$media" >/dev/null
  echo "tagged sentryops:$sha as release-$sha"
fi

current=$(sed -n 's/^image_tag *= *"\(.*\)"/\1/p' "$release_file" 2>/dev/null || true)
write_release() { printf 'image_tag           = "%s"\nmigration_image_tag = "%s"\n' "$1" "$2" >"$release_file"; }

# Plans, refuses a plan that changes more than the release, and applies exactly that plan.
release_apply() {
  tf plan -out="$plan_name" >/dev/null
  local changes unexpected
  changes=$(TF_DATA_DIR=".terraform-$env_name" "$TERRAFORM" -chdir="$cell" show -json "$plan_name" |
    node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        for (const c of JSON.parse(s).resource_changes ?? [])
          if (!c.change.actions.every((a) => a === "no-op" || a === "read"))
            console.log(`${c.address} ${c.change.actions.join("+")}`);
      });')
  echo "${changes:-  (nothing to change)}" | sed 's/^/  /'
  unexpected=$(echo "$changes" | grep -v -E '^(aws_ecs_task_definition\.|aws_ecs_service\.|aws_rds_instance_state\.)' |
    grep -v '^$' || true)
  if [ -n "$unexpected" ]; then
    rm -f "$cell/$plan_name"
    echo "the plan changes more than the release; apply that on its own first (tf.sh $env_name plan):" >&2
    echo "$unexpected" | sed 's/^/  /' >&2
    exit 1
  fi
  TF_DATA_DIR=".terraform-$env_name" "$TERRAFORM" -chdir="$cell" apply -input=false "$plan_name"
  rm -f "$cell/$plan_name"
}

# A paused environment's database is stopped. Terraform's aws_rds_instance_state can check the
# state before its own start request registers, see 'stopped' and fail; so start it here first.
db_status=$("$AWS" rds describe-db-instances --region "$region" --db-instance-identifier "$prefix" \
  --query 'DBInstances[0].DBInstanceStatus' --output text)
if [ "$db_status" = "stopped" ]; then
  echo "starting the database (it was stopped)"
  "$AWS" rds start-db-instance --region "$region" --db-instance-identifier "$prefix" >/dev/null
  "$AWS" rds wait db-instance-available --region "$region" --db-instance-identifier "$prefix"
fi

echo "== 1/2: migrations with $sha (services stay on ${current:-nothing yet})"
write_release "$current" "$sha"
release_apply

cluster=$(tf output -raw cluster)
subnets=$(tf output -json task_subnets | tr -d '[]" \r\n')
group=$(tf output -json task_security_groups | sed -n 's/.*"dbadmin": *"\([^"]*\)".*/\1/p')
task=$("$AWS" ecs run-task --region "$region" --cluster "$cluster" --launch-type FARGATE \
  --task-definition "$(tf output -raw dbadmin_task_definition)" \
  --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$group],assignPublicIp=ENABLED}" \
  --query 'tasks[0].taskArn' --output text)
echo "migration task: $task"
wait_task_stopped "$task" 60
code=$("$AWS" ecs describe-tasks --region "$region" --cluster "$cluster" --tasks "$task" \
  --query 'tasks[0].containers[0].exitCode' --output text)
"$AWS" logs tail "/$prefix/dbadmin" --region "$region" --since 30m --format short | tail -20 || true
if [ "$code" != "0" ]; then
  echo "migrations failed (exit $code); the services were not changed" >&2
  exit 1
fi

echo "== 2/2: services to $sha"
write_release "$sha" "$sha"
release_apply
"$AWS" ecs wait services-stable --region "$region" --cluster "$cluster" --services api web worker
echo "released $sha to $env_name: $(tf output -raw dashboard_url)"
echo "Commit infra/terraform/env/$env_name.release.tfvars."
