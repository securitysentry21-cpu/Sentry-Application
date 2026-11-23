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

# The state holds every generated secret (review L-22, approved by the owner 2026-11-23): it is
# encrypted with a key of our own, rotated every year, and CloudTrail records every use of it. Made
# here, not in the cell: the cell's destroy would schedule its own state's key for deletion while
# still writing that state. State written before stays under S3's key until it is rewritten.
alias="alias/sentryops-${env_name}-tfstate"
key=$("$AWS" kms describe-key --key-id "$alias" --region "$region" --query KeyMetadata.Arn --output text \
  2>/dev/null || true)
if [ -z "$key" ] || [ "$key" = "None" ]; then
  key=$("$AWS" kms create-key --region "$region" --description "Terraform state, sentryops-$env_name" \
    --query KeyMetadata.Arn --output text)
  "$AWS" kms create-alias --region "$region" --alias-name "$alias" --target-key-id "$key"
  echo "created state key: $alias"
else
  echo "state key exists: $alias"
fi
"$AWS" kms enable-key-rotation --region "$region" --key-id "$key"
"$AWS" s3api put-bucket-encryption --bucket "$bucket" --region "$region" --server-side-encryption-configuration \
  "{\"Rules\":[{\"ApplyServerSideEncryptionByDefault\":{\"SSEAlgorithm\":\"aws:kms\",\"KMSMasterKeyID\":\"$key\"},\"BucketKeyEnabled\":true}]}"
"$AWS" s3api put-bucket-policy --bucket "$bucket" --region "$region" --policy "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Sid\": \"DenyInsecureTransport\", \"Effect\": \"Deny\", \"Principal\": \"*\", \"Action\": \"s3:*\",
    \"Resource\": [\"arn:aws:s3:::$bucket\", \"arn:aws:s3:::$bucket/*\"],
    \"Condition\": {\"Bool\": {\"aws:SecureTransport\": \"false\"}}
  }]
}"

# Terraform asks for the key itself on every write, so the state never depends on the bucket's
# default alone. The file is git-ignored: it names the account.
backend_dir="${BACKEND_DIR:-$here/../terraform/env}"
printf 'bucket     = "%s"\nkey        = "%s/terraform.tfstate"\nregion     = "%s"\nencrypt    = true\nkms_key_id = "%s"\n' \
  "$bucket" "$env_name" "$region" "$key" >"$backend_dir/$env_name.backend.hcl"
TF_DATA_DIR=".terraform-$env_name" "$TERRAFORM" -chdir="$here/../terraform/cell" init -input=false -reconfigure \
  -backend-config="$backend_dir/$env_name.backend.hcl"
