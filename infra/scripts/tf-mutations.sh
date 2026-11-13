#!/usr/bin/env bash
# The Terraform tests' own negative controls (Fable pass 2, review L-29): in pass 2 the WAF and photo
# bucket tests still passed with the mechanisms they guard broken. Each mutation below breaks one
# mechanism in a scratch copy of the cell; `terraform test` must then fail, in the run named.
# Run by tf-test.sh after the tests pass (CI's terraform job); needs its `init` first.
#   infra/scripts/tf-mutations.sh
set -euo pipefail
cell="$(cd "$(dirname "$0")/../terraform/cell" && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch" 2>/dev/null || true' EXIT
if command -v cygpath >/dev/null 2>&1; then
  cell="$(cygpath -m "$cell")"
  scratch="$(cygpath -m "$scratch")"
  export MSYS_NO_PATHCONV=1
fi
TERRAFORM="${TERRAFORM:-terraform}"
# The providers tf-test.sh installed; the copy has no modules, so nothing else is needed.
export TF_DATA_DIR="$cell/.terraform-tftest"

failed=0
count=0
# mutate <name> <file> <run that must fail> <perl substitution, applied to the whole file>
mutate() {
  local name="$1" file="$2" run="$3" substitution="$4"
  # A fresh copy each time (on Windows a just-finished run can still hold its folder).
  count=$((count + 1))
  local copy="$scratch/cell-$count"
  mkdir -p "$copy"
  cp "$cell"/*.tf "$cell/.terraform.lock.hcl" "$copy/"
  cp -r "$cell/tests" "$copy/tests"
  perl -0pi -e "$substitution" "$copy/$file"
  if cmp -s "$cell/$file" "$copy/$file"; then
    echo "BROKEN CONTROL  $name: the substitution changed nothing in $file"
    failed=1
    return
  fi
  if "$TERRAFORM" -chdir="$copy" test -no-color >"$copy.txt" 2>&1; then
    echo "NOT CAUGHT      $name: every Terraform test passes with it"
    failed=1
  elif grep -q "run \"$run\"... fail" "$copy.txt"; then
    echo "caught          $name ($run)"
  else
    echo "WRONG REASON    $name: the tests failed, but not in $run"
    sed -n '1,40p' "$copy.txt"
    failed=1
  fi
}

# Fable's four (pass 2, appendix B), then one per remaining part of each assertion.
# A and F break a managed group's exemption (the IP reputation group's), not the flood counter's.
mutate "A: an SOS exemption reads the query string, not the path" edge.tf no_managed_waf_rule_sees_an_sos \
  's/(name     = "aws-ip-reputation".*?regex_string = local\.sos_guard_paths\s*field_to_match \{\s*)uri_path \{\}/${1}query_string {}/s'
mutate "B: the sync exemption matches the exact path only" edge.tf no_managed_waf_rule_sees_an_sos \
  's/positional_constraint = "STARTS_WITH"/positional_constraint = "EXACTLY"/'
mutate "C: older photo versions never expire" attachments.tf photo_bucket_keeps_versions_and_copies_them \
  's/(id\s*= "older-versions-with-the-backups"\s*status\s*= "Enabled"\s*filter \{\}\s*)noncurrent_version_expiration \{[^}]*\}/$1/'
mutate "D: the copy bucket has no lifecycle" attachments.tf photo_bucket_keeps_versions_and_copies_them \
  's/resource "aws_s3_bucket_lifecycle_configuration" "attachments_copy" \{.*?\n\}\n//s'
mutate "E: the SOS exemption covers every /api/v1/sos* path again" edge.tf no_managed_waf_rule_sees_an_sos \
  's/sos_guard_paths = "[^"]*"/sos_guard_paths = "^\/api\/v1\/sos"/'
mutate "F: an exemption skips path normalization" edge.tf no_managed_waf_rule_sees_an_sos \
  's/(name     = "aws-ip-reputation".*?type     = )"NORMALIZE_PATH"/${1}"LOWERCASE"/s'
mutate "G: a fourth managed rule group without the exemption" edge.tf no_managed_waf_rule_sees_an_sos \
  's/(  rule \{\n    name     = "aws-ip-reputation")/  rule {\n    name     = "aws-extra"\n    priority = 9\n    override_action {\n      none {}\n    }\n    statement {\n      managed_rule_group_statement {\n        vendor_name = "AWS"\n        name        = "AWSManagedRulesAdminProtectionRuleSet"\n      }\n    }\n    visibility_config {\n      cloudwatch_metrics_enabled = true\n      metric_name                = "aws-extra"\n      sampled_requests_enabled   = true\n    }\n  }\n\n$1/'
mutate "H: the copy bucket is not versioned" attachments.tf photo_bucket_keeps_versions_and_copies_them \
  's/(resource "aws_s3_bucket_versioning" "attachments_copy" \{.*?status = )"Enabled"/$1"Suspended"/s'
mutate "I: production may turn its WAF off" variables.tf production_keeps_its_waf \
  's/var\.environment != "production" \|\| var\.waf_enabled/var.waf_enabled || !var.waf_enabled/'
mutate "J: production may turn its backup copy off" variables.tf production_keeps_its_backup_copy \
  's/var\.environment != "production" \|\| var\.backup_copy_enabled/var.backup_copy_enabled || !var.backup_copy_enabled/'
# The owner's decisions on pass 2's Q7 and pass 1's Q4.
mutate "K: the SOS flood rule blocks instead of counting" edge.tf sos_floods_are_counted_never_blocked \
  's/(name     = "sos-flood-count"\s*priority = 0\s*action \{\s*)count \{\}/${1}block {}/'
mutate "L: the SOS flood rule reads the query string" edge.tf sos_floods_are_counted_never_blocked \
  's/(name     = "sos-flood-count".*?field_to_match \{\s*)uri_path \{\}/${1}query_string {}/s'
mutate "M: SOS switched on before the hardware-bound device key" services.tf sos_stays_off_until_the_device_key_is_hardware_bound \
  's/\{ name = "FEATURE_SOS", value = "false" \}/{ name = "FEATURE_SOS", value = "true" }/'

if [ "$failed" -ne 0 ]; then
  echo "A Terraform test does not hold what it claims (review L-29)."
  exit 1
fi
echo "Every mutation is caught."
