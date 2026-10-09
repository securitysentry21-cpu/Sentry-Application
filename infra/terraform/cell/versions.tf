# One cell environment (ARCH §19.8, D-37): `test` now, on the AWS Free plan in the first account (an
# account of AWS's simplified type, limited to Sydney); `production` before the first real guard, in
# Frankfurt (infra/README.md). Each has its own variables (../env/<environment>.tfvars) and its own
# state. Production is never changed by hand.
terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State in S3 with native locking. infra/scripts/bootstrap-state.sh creates the bucket and writes
  # ../env/<environment>.backend.hcl (bucket, key and region), which `terraform init` reads.
  backend "s3" {
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = local.tags
  }
}

# Backups are also copied to a second region (ARCH §19.4, §19.8).
provider "aws" {
  alias  = "backup"
  region = var.backup_region
  default_tags {
    tags = local.tags
  }
}

data "aws_caller_identity" "current" {}

locals {
  name       = "sentryops-${var.environment}"
  account_id = data.aws_caller_identity.current.account_id
  tags = {
    project     = "sentryops"
    environment = var.environment
    managed_by  = "terraform"
  }
}
