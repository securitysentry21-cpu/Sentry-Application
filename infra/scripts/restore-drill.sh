#!/usr/bin/env bash
# The backup restore drill (ARCH §19.6: before launch, then every quarter):
#   infra/scripts/restore-drill.sh test
# 1. Restores the environment's database, as it was at its latest restorable time, into a new private
#    instance beside it: same network, security group, parameters, certificate authority and key.
# 2. Checks the copy with packages/db/scripts/restore-check.ts, as a one-off task like the migrations:
#    every migration, the schema linter, the runtime roles, the rows in every table.
# 3. Deletes the copy, whatever happened, and prints the restore point and the times against the
#    targets (RPO ≤ 15 min, RTO ≤ 4 h).
# The live database isn't touched, but it must be running (the environment not paused). The copy costs
# what the database does, for the hour or less the drill takes.
# For an image built before the check existed (before Phase 10), RESTORE_CHECK_FROM_CHECKOUT=1 sends
# this checkout's copy of the check with the task.
set -euo pipefail
source "$(dirname "$0")/env.sh" "${1:?usage: restore-drill.sh <test|production>}"

db() { "$AWS" rds "$@" --region "$region" | tr -d '\r'; }
started=$(date -u +%s)
since() {
  local s=$(($(date -u +%s) - started))
  printf '%dh %02dm %02ds' $((s / 3600)) $((s % 3600 / 60)) $((s % 60))
}

read -r status class subnet_group parameter_group ca_cert groups restore_point < <(
  db describe-db-instances --db-instance-identifier "$prefix" --output text --query \
    'DBInstances[0].[DBInstanceStatus, DBInstanceClass, DBSubnetGroup.DBSubnetGroupName, DBParameterGroups[0].DBParameterGroupName, CACertificateIdentifier, join(`,`, VpcSecurityGroups[].VpcSecurityGroupId), LatestRestorableTime]'
)
[ "$status" = "available" ] || { echo "the database is ${status:-missing}: switch the environment on first (paused = false)" >&2; exit 1; }
IFS=, read -r -a group_ids <<<"$groups"

copy="$prefix-drill-$(date -u +%Y%m%d%H%M)"
restoring=""
cleanup() {
  [ -n "$restoring" ] || return 0
  case "$copy" in "$prefix"-drill-*) ;; *) return 0 ;; esac # never anything but the copy
  echo "deleting the copy $copy"
  db wait db-instance-available --db-instance-identifier "$copy" >/dev/null 2>&1 || true
  if db delete-db-instance --db-instance-identifier "$copy" --skip-final-snapshot --delete-automated-backups >/dev/null; then
    db wait db-instance-deleted --db-instance-identifier "$copy" && echo "copy deleted ($(since) in all)"
  else
    echo "could not delete $copy: delete it in the RDS console (no final snapshot)" >&2
  fi
}
trap cleanup EXIT

echo "restoring $prefix as it was at $restore_point (its latest restorable time) into $copy"
db restore-db-instance-to-point-in-time --source-db-instance-identifier "$prefix" \
  --target-db-instance-identifier "$copy" --use-latest-restorable-time \
  --db-instance-class "$class" --db-subnet-group-name "$subnet_group" \
  --vpc-security-group-ids "${group_ids[@]}" --db-parameter-group-name "$parameter_group" \
  --ca-certificate-identifier "$ca_cert" --no-publicly-accessible --no-multi-az \
  --no-deletion-protection --tags Key=purpose,Value=restore-drill >/dev/null
restoring=1
until db wait db-instance-available --db-instance-identifier "$copy" 2>/dev/null; do
  state=$(db describe-db-instances --db-instance-identifier "$copy" --query 'DBInstances[0].DBInstanceStatus' --output text)
  case "$state" in
    creating | backing-up | modifying | configuring-*) echo "still restoring ($state, $(since))" ;;
    *) echo "the restore ended in state $state" >&2; exit 1 ;;
  esac
done
available=$(since)
echo "copy available after $available"

host=$(db describe-db-instances --db-instance-identifier "$copy" --query 'DBInstances[0].Endpoint.Address' --output text)
cluster=$(tf output -raw cluster)
subnets=$(tf output -json task_subnets | tr -d '[]" \r\n')
group=$(tf output -json task_security_groups | sed -n 's/.*"dbadmin": *"\([^"]*\)".*/\1/p')
# The database task's definition, pointed at the copy and running the check instead of the migrations.
overrides=$(DB_HOST="$host" FROM_CHECKOUT="${RESTORE_CHECK_FROM_CHECKOUT:-}" REPO="$here/../.." node --input-type=module -e '
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
const environment = [{ name: "DB_HOST", value: process.env.DB_HOST }];
let command = ["node", "packages/db/scripts/restore-check.ts"];
if (process.env.FROM_CHECKOUT === "1") {
  // The image lacks the check: write it under /tmp, beside links to the modules in the image.
  const packed = (path) => gzipSync(readFileSync(`${process.env.REPO}/packages/db/${path}`)).toString("base64");
  environment.push(
    { name: "CHECK_LIB", value: packed("src/restore-check.ts") },
    { name: "CHECK_MAIN", value: packed("scripts/restore-check.ts") },
  );
  command = ["sh", "-c", [
    "set -e",
    "d=/tmp/check",
    "mkdir -p $d/src $d/scripts",
    "ln -s /repo/node_modules $d/node_modules",
    "cp /repo/packages/db/package.json $d/package.json",
    "for f in /repo/packages/db/src/*; do [ \"${f##*/}\" = restore-check.ts ] || ln -s \"$f\" $d/src/; done",
    "printf %s \"$CHECK_LIB\" | base64 -d | gunzip > $d/src/restore-check.ts",
    "printf %s \"$CHECK_MAIN\" | base64 -d | gunzip > $d/scripts/restore-check.ts",
    "exec node $d/scripts/restore-check.ts",
  ].join("; ")];
}
process.stdout.write(JSON.stringify({ containerOverrides: [{ name: "dbadmin", command, environment }] }));
')
task=$("$AWS" ecs run-task --region "$region" --cluster "$cluster" --launch-type FARGATE \
  --task-definition "$(tf output -raw dbadmin_task_definition)" \
  --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$group],assignPublicIp=ENABLED}" \
  --overrides "$overrides" --query 'tasks[0].taskArn' --output text | tr -d '\r')
echo "check task: $task"
"$AWS" ecs wait tasks-stopped --region "$region" --cluster "$cluster" --tasks "$task"
code=$("$AWS" ecs describe-tasks --region "$region" --cluster "$cluster" --tasks "$task" \
  --query 'tasks[0].containers[0].exitCode' --output text | tr -d '\r')
"$AWS" logs get-log-events --region "$region" --log-group-name "/$prefix/dbadmin" \
  --log-stream-name "dbadmin/dbadmin/${task##*/}" --start-from-head \
  --query 'events[].message' --output text | tr '\t' '\n' | tr -d '\r' || true
checked=$(since)

behind=$(((started - $(date -u -d "$restore_point" +%s)) / 60))
echo "restore point: $restore_point or later, $behind min before the drill began (RPO target ≤ 15 min)"
echo "copy available after $available, checked after $checked (RTO target ≤ 4 h. A real restore also points the services at the copy: docs/RUNBOOKS/database-restore.md)"
[ "$code" = "0" ] || { echo "restore check FAILED (exit $code)" >&2; exit 1; }
echo "restore drill passed"
