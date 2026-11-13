#!/usr/bin/env bash
# The cell's configuration checks, with no AWS account and no credentials (CI's terraform job):
# formatting, validation, and infra/terraform/cell/tests/*.tftest.hcl, which plan the cell against
# mocked providers and assert what it must keep (review L-02, L-03, L-05, L-06, L-14, L-15), then
# breaks each mechanism in a scratch copy and checks that a test fails (tf-mutations.sh, L-29).
# Needs Terraform 1.11 or later (mocked values while planning).
#   infra/scripts/tf-test.sh
set -euo pipefail
cell="$(cd "$(dirname "$0")/../terraform/cell" && pwd)"
if command -v cygpath >/dev/null 2>&1; then cell="$(cygpath -m "$cell")"; export MSYS_NO_PATHCONV=1; fi
TERRAFORM="${TERRAFORM:-terraform}"
# Its own working data, apart from each environment's (tf.sh) and never with a backend.
export TF_DATA_DIR=".terraform-tftest"

"$TERRAFORM" -chdir="$cell" init -backend=false -input=false -no-color >/dev/null
"$TERRAFORM" -chdir="$cell" fmt -check -recursive -no-color
"$TERRAFORM" -chdir="$cell" validate -no-color
"$TERRAFORM" -chdir="$cell" test -no-color
bash "$(dirname "$0")/tf-mutations.sh"
