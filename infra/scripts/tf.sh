#!/usr/bin/env bash
# Terraform for one environment, with its variables and its own working data:
#   infra/scripts/tf.sh test plan
#   infra/scripts/tf.sh test apply
#   infra/scripts/tf.sh test output -raw dashboard_url
set -euo pipefail
env_name="${1:?usage: tf.sh <test|production> <terraform command> [args]}"
shift
command="${1:?usage: tf.sh <test|production> <terraform command> [args]}"
shift
TERRAFORM="${TERRAFORM:-terraform}"
cell="$(cd "$(dirname "$0")/../terraform/cell" && pwd)"
if command -v cygpath >/dev/null 2>&1; then cell="$(cygpath -m "$cell")"; export MSYS_NO_PATHCONV=1; fi
export TF_DATA_DIR=".terraform-$env_name"

case "$command" in
  plan | apply | destroy | import | refresh)
    release="../env/$env_name.release.tfvars"
    [ -f "$cell/$release" ] || printf 'image_tag           = ""\nmigration_image_tag = ""\n' >"$cell/$release"
    exec "$TERRAFORM" -chdir="$cell" "$command" -input=false \
      -var-file="../env/$env_name.tfvars" -var-file="$release" "$@"
    ;;
  *)
    exec "$TERRAFORM" -chdir="$cell" "$command" "$@"
    ;;
esac
