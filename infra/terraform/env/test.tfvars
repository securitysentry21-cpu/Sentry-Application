# The test environment: test data only, never real guards (docs/DECISIONS.md, infrastructure).
# The first AWS account is on the Free plan, and of AWS's simplified type, which allows only Sydney,
# blocks GuardDuty and can't trust GitHub's OIDC provider (so CodeBuild builds the image). No domain
# yet: CloudFront gives the address (edge.tf).
environment              = "test"
region                   = "ap-southeast-2"
backup_region            = "ap-southeast-2" # unused: no backup copy in test
domain                   = ""
db_multi_az              = false
db_backup_retention_days = 1 # the Free plan refuses longer (FreeTierRestrictionError)
db_storage_autoscaling   = false
backup_copy_enabled      = false
waf_enabled              = false
guardduty_enabled        = false
cloudtrail_multi_region  = false
image_builder            = "codebuild"
monthly_budget_usd       = 80
