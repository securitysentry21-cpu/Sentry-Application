#!/usr/bin/env bash
# For an environment with image_builder = "codebuild": builds sentryops:<sha> with CodeBuild inside the
# account (infra/terraform/cell/codebuild.tf) and waits for it. Build only commits that passed CI.
#   infra/scripts/build-image.sh test <sha>
set -euo pipefail
source "$(dirname "$0")/env.sh" "${1:?usage: build-image.sh <test|production> <commit sha>}"
sha="${2:?usage: build-image.sh <test|production> <commit sha>}"
case "$sha" in *[!0-9a-f]* | "") echo "expected a full commit SHA, got: $sha" >&2; exit 2 ;; esac
[ "${#sha}" -eq 40 ] || { echo "expected a full 40-character commit SHA" >&2; exit 2; }

if "$AWS" ecr describe-images --region "$region" --repository-name sentryops --image-ids "imageTag=$sha" >/dev/null 2>&1; then
  echo "sentryops:$sha is already built"
  exit 0
fi
project=$(tf output -raw image_build_project)
build=$("$AWS" codebuild start-build --region "$region" --project-name "$project" \
  --environment-variables-override "name=GIT_COMMIT,value=$sha,type=PLAINTEXT" \
  --query 'build.id' --output text)
echo "building sentryops:$sha ($build)"
while :; do
  status=$("$AWS" codebuild batch-get-builds --region "$region" --ids "$build" --query 'builds[0].buildStatus' --output text)
  [ "$status" = "IN_PROGRESS" ] || break
  sleep 20
done
echo "build $status"
if [ "$status" != "SUCCEEDED" ]; then
  "$AWS" logs tail "/$prefix/image-builder" --region "$region" --since 1h --format short | tail -40 || true
  exit 1
fi
