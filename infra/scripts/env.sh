#!/usr/bin/env bash
# Shared by the scripts in this folder: the environment's region, from infra/terraform/env/<env>.tfvars.
#   source "$(dirname "$0")/env.sh" <test|production>
env_name="${1:?an environment name: test or production}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tfvars="$here/../terraform/env/$env_name.tfvars"
[ -f "$tfvars" ] || { echo "no such environment: $env_name" >&2; exit 2; }
region=$(sed -n 's/^region *= *"\([^"]*\)".*/\1/p' "$tfvars")
region="${region:-eu-central-1}"
AWS="${AWS:-aws}"
TERRAFORM="${TERRAFORM:-terraform}"
prefix="sentryops-$env_name"
tf() { "$here/tf.sh" "$env_name" "$@"; }
