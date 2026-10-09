#!/usr/bin/env bash
# Run once per environment: creates the private, versioned, encrypted S3 bucket that holds Terraform's
# state (it contains generated secrets, so only the account's administrators may read it), writes
# infra/terraform/env/<environment>.backend.hcl, and runs `terraform init` for that environment.
#   infra/scripts/bootstrap-state.sh test
set -euo pipefail
source "$(dirname "$0")/env.sh" "${1:?usage: bootstrap-state.sh <test|production>}"
account=$("$AWS" sts get-caller-identity --query Account --output text)
bucket="sentryops-${env_name}-tfstate-${account}"

if "$AWS" s3api head-bucket --bucket "$bucket" --region "$region" 2>/dev/null; then
  echo "state bucket exists: $bucket"
else
  "$AWS" s3api create-bucket --bucket "$bucket" --region "$region" \
    --create-bucket-configuration "LocationConstraint=$region" >/dev/null
  echo "created state bucket: $bucket ($region)"
fi
"$AWS" s3api put-public-access-block --bucket "$bucket" --region "$region" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
"$AWS" s3api put-bucket-versioning --bucket "$bucket" --region "$region" --versioning-configuration Status=Enabled
"$AWS" s3api put-bucket-encryption --bucket "$bucket" --region "$region" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
"$AWS" s3api put-bucket-policy --bucket "$bucket" --region "$region" --policy "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Sid\": \"DenyInsecureTransport\", \"Effect\": \"Deny\", \"Principal\": \"*\", \"Action\": \"s3:*\",
    \"Resource\": [\"arn:aws:s3:::$bucket\", \"arn:aws:s3:::$bucket/*\"],
    \"Condition\": {\"Bool\": {\"aws:SecureTransport\": \"false\"}}
  }]
}"

printf 'bucket = "%s"\nkey    = "%s/terraform.tfstate"\nregion = "%s"\n' "$bucket" "$env_name" "$region" \
  >"$here/../terraform/env/$env_name.backend.hcl"
TF_DATA_DIR=".terraform-$env_name" "$TERRAFORM" -chdir="$here/../terraform/cell" init -input=false -reconfigure \
  -backend-config="../env/$env_name.backend.hcl"
