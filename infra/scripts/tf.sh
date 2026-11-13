#!/usr/bin/env bash
# Terraform for one environment, with its variables and its own working data:
#   infra/scripts/tf.sh test plan
#   infra/scripts/tf.sh test apply
#   infra/scripts/tf.sh test output -raw dashboard_url
# To apply exactly the plan that was read (Fable pass 2, review L-32), save it and apply the file;
# a saved plan carries its variables and refuses -var-file:
#   infra/scripts/tf.sh test plan -out=change.tfplan      (in infra/terraform/cell; *.tfplan is ignored)
#   infra/scripts/tf.sh test apply-plan change.tfplan
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
  apply-plan)
    plan_file="${1:?usage: tf.sh <env> apply-plan <saved plan file, as written by plan -out=>}"
    exec "$TERRAFORM" -chdir="$cell" apply -input=false "$plan_file"
    ;;
  *)
    exec "$TERRAFORM" -chdir="$cell" "$command" "$@"
    ;;
esac
