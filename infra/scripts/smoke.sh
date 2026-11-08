#!/usr/bin/env bash
# The checks after a release (infra/README.md › Releasing):
#   infra/scripts/smoke.sh test
# From outside: health, readiness, the sign-in page, and the live stream refusing a request without a
# session. From inside, as one-off tasks with each service's own permissions, the object store:
#   - the worker uploads through a signed link as a phone would, can't overwrite the object, downloads
#     it through a signed link and deletes it;
#   - the api is refused a delete (only the worker deletes, SEC §16.5).
set -euo pipefail
source "$(dirname "$0")/env.sh" "${1:?usage: smoke.sh <test|production>}"

failed=0
expect() { # <what> <expected> <actual>
  if [ "$2" = "$3" ]; then echo "✓ $1"; else echo "✗ $1: expected $2, got $3"; failed=1; fi
}
origin=$(tf output -raw dashboard_url | tr -d '\r')
status() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$origin$1"; }
expect "health" 200 "$(status /api/v1/health)"
expect "ready (the database answers)" 200 "$(status /api/v1/ready)"
expect "the sign-in page" 200 "$(status /sign-in)"
expect "the live stream refuses a request without a session" 401 "$(status /api/v1/stream)"

cluster=$(tf output -raw cluster | tr -d '\r')
subnets=$(tf output -json task_subnets | tr -d '[]" \r\n')
groups=$(tf output -json task_security_groups | tr -d '\r')
# Runs <script> (JavaScript importing the image's own modules) as a one-off task of <service>, with
# that service's definition, network and role; prints its log; returns its exit code.
inside() {
  local service=$1 script=$2 definition group overrides task code
  definition=$("$AWS" ecs describe-services --region "$region" --cluster "$cluster" --services "$service" \
    --query 'services[0].taskDefinition' --output text | tr -d '\r')
  group=$(printf '%s' "$groups" | sed -n "s/.*\"$service\": *\"\([^\"]*\)\".*/\1/p")
  overrides=$(SERVICE="$service" SCRIPT="$script" node -e '
    const command = ["node", "--input-type=module", "-e", process.env.SCRIPT];
    process.stdout.write(JSON.stringify({ containerOverrides: [{ name: process.env.SERVICE, command }] }));')
  task=$("$AWS" ecs run-task --region "$region" --cluster "$cluster" --launch-type FARGATE \
    --task-definition "$definition" \
    --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$group],assignPublicIp=ENABLED}" \
    --overrides "$overrides" --query 'tasks[0].taskArn' --output text | tr -d '\r')
  "$AWS" ecs wait tasks-stopped --region "$region" --cluster "$cluster" --tasks "$task"
  "$AWS" logs get-log-events --region "$region" --log-group-name "/$prefix/$service" \
    --log-stream-name "$service/$service/${task##*/}" --start-from-head \
    --query 'events[].message' --output text | tr '\t' '\n' | tr -d '\r' | sed 's/^/  /' || true
  code=$("$AWS" ecs describe-tasks --region "$region" --cluster "$cluster" --tasks "$task" \
    --query 'tasks[0].containers[0].exitCode' --output text | tr -d '\r')
  [ "$code" = "0" ]
}

store='
import { randomUUID } from "node:crypto";
import { containerCredentials, S3ObjectStore } from "/repo/apps/api/src/storage/s3.ts";
import { systemClock } from "/repo/packages/domain/src/clock.ts";
const store = new S3ObjectStore({
  bucket: process.env.S3_BUCKET,
  region: process.env.S3_REGION,
  credentials: containerCredentials(process.env, systemClock),
  clock: systemClock,
});
const key = `exports/smoke/${randomUUID()}.txt`;'

echo "the worker: signed upload, no overwrite, signed download, delete"
if inside worker "$store"'
const body = Buffer.from(`smoke ${new Date().toISOString()}`);
const results = [];
const upload = await store.signUpload(key, "text/plain", body.length, 300);
// fetch sets the length itself, to the value the link was signed with.
const { "content-length": _length, ...headers } = upload.headers;
results.push(["signed upload", 200, (await fetch(upload.url, { method: "PUT", headers, body })).status]);
results.push(["the same upload again is refused", 412, (await fetch(upload.url, { method: "PUT", headers, body })).status]);
const download = await fetch((await store.signDownload(key, 60, "smoke.txt")).url);
results.push(["signed download", 200, download.status]);
results.push(["it holds what was uploaded", true, (await download.text()) === body.toString()]);
await store.delete(key);
results.push(["deleted", null, await store.size(key)]);
for (const [what, wanted, got] of results) console.log(`${wanted === got ? "ok" : "FAILED"} ${what}: ${got}`);
process.exitCode = results.every(([, wanted, got]) => wanted === got) ? 0 : 1;'; then
  echo "✓ the worker's object store round trip"
else
  echo "✗ the worker's object store round trip"; failed=1
fi

echo "the api: a delete must be refused"
if inside api "$store"'
try {
  await store.delete(key);
  console.log("FAILED the api deleted an object");
  process.exitCode = 1;
} catch (error) {
  console.log(`ok refused: ${error.message}`);
}'; then
  echo "✓ the api may not delete"
else
  echo "✗ the api may not delete"; failed=1
fi

[ "$failed" = 0 ] && echo "smoke test passed" || { echo "smoke test FAILED" >&2; exit 1; }
