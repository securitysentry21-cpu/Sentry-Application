variable "environment" {
  description = "test or production. Names every resource (sentryops-<environment>-…)."
  type        = string
  validation {
    condition     = contains(["test", "production"], var.environment)
    error_message = "environment must be test or production"
  }
}

variable "region" {
  description = "The cell's region (D-13, D-37)."
  type        = string
  default     = "eu-central-1"
}

variable "backup_region" {
  description = "Where database backups are also copied (ARCH §19.8)."
  type        = string
  default     = "eu-west-1"
}

variable "domain" {
  description = "The company domain, with its DNS in Route 53 in this account. Empty: the test address from CloudFront (edge.tf). Required before real guards: the guard app has the address built in."
  type        = string
  default     = ""
  # Review L-15: without a domain, production would build in test mode (no WAF, internal load balancer).
  validation {
    condition     = var.environment != "production" || var.domain != ""
    error_message = "Production needs its domain (env/production.tfvars) before any apply."
  }
}

variable "app_host" {
  description = "The dashboard and API share one origin: https://<app_host>.<domain> (review A-07)."
  type        = string
  default     = "app"
}

variable "github_repository" {
  description = "The only repository whose main branch may push images (owner/name)."
  type        = string
  default     = "securitysentry21-cpu/Sentry-Application"
}

variable "alerts_email" {
  description = "Where GuardDuty findings and budget warnings are sent. Personal data: set it in the git-ignored local.auto.tfvars, never in a committed file."
  type        = string
  default     = ""
  # Review L-15: an apply from a machine without local.auto.tfvars would remove the alarm subscription.
  validation {
    condition     = var.environment != "production" || var.alerts_email != ""
    error_message = "Production needs alerts_email (local.auto.tfvars): without it the alarms reach nobody."
  }
}

variable "monthly_budget_usd" {
  description = "Budget warnings at 85% and 100% of this, and when the forecast exceeds it."
  type        = number
  default     = 200
}

# ── Switches for the production baseline (ARCH §19.8); the test environment turns some off ───

variable "waf_enabled" {
  description = "AWS WAF managed rules in front of the load balancer (only with a domain)."
  type        = bool
  default     = true
}

variable "backup_copy_enabled" {
  description = "Copy automated database backups to the backup region."
  type        = bool
  default     = true
}

variable "guardduty_enabled" {
  description = "GuardDuty threat detection (ARCH §19.8). AWS's simplified account type blocks it."
  type        = bool
  default     = true
}

variable "cloudtrail_multi_region" {
  description = "One trail recording every region; a single-region account records its own."
  type        = bool
  default     = true
}

variable "image_builder" {
  description = "Who builds and pushes the server image: github (CI through GitHub OIDC) or codebuild (AWS CodeBuild in this account, where an OIDC provider can't be added)."
  type        = string
  default     = "github"
  validation {
    condition     = contains(["github", "codebuild"], var.image_builder)
    error_message = "image_builder must be github or codebuild"
  }
}

# ── Releases (infra/scripts/release.sh writes these to release.auto.tfvars) ────────────────────

variable "image_tag" {
  description = "The image the services run: a commit SHA that CI built and pushed. Empty: services stay at zero tasks."
  type        = string
  default     = ""
}

variable "migration_image_tag" {
  description = "The image the database task runs. A release moves it first, migrates, then moves image_tag."
  type        = string
  default     = ""
}

# ── Sizes (Pilot 0 is about 50 guards; D-34). Raise before the 1,000-guard rollout. ────────────

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "db_multi_az" {
  description = "A standby copy in a second availability zone (ARCH §19.8)."
  type        = bool
  default     = true
}

variable "db_allocated_storage_gb" {
  type    = number
  default = 20
}

variable "db_backup_retention_days" {
  description = "Point-in-time recovery window (ARCH §19.8: 35). The Free plan allows less."
  type        = number
  default     = 35
}

variable "db_storage_autoscaling" {
  description = "Let storage grow up to five times the allocation."
  type        = bool
  default     = true
}

variable "paused" {
  description = "Switched off to save money: no service tasks run and the database is stopped. Data and settings stay. RDS restarts a stopped database by itself after 7 days; another apply stops it again."
  type        = bool
  default     = false
}

variable "api_desired_count" {
  type    = number
  default = 1
}

variable "web_desired_count" {
  type    = number
  default = 1
}

# ── Notifications and the canary (Phase 8) ──────────────────────────────────────────────────────

variable "fcm_service_account" {
  description = "The Firebase service account JSON for pushes to the guard app (D-26). Empty until the Firebase project exists. A secret: set it in the git-ignored local.auto.tfvars, never in a committed file."
  type        = string
  default     = ""
  sensitive   = true
  # Review L-15: the same machine would remove the push credentials from the worker's secret.
  validation {
    condition     = var.environment != "production" || var.fcm_service_account != ""
    error_message = "Production needs fcm_service_account (local.auto.tfvars), or guard pushes stop."
  }
}

variable "canary_enabled" {
  description = "The synthetic SOS (ARCH §22): a canary organization's SOS every 5 minutes, end to end, with alarms when it fails or goes quiet. Needs the canary organization first (operator create-canary)."
  type        = bool
  default     = false
}

variable "canary_device_id" {
  description = "The canary phone's device ID, printed by operator create-canary."
  type        = string
  default     = ""
}

variable "canary_device_key" {
  description = "The canary phone's private key, printed once by operator create-canary. A secret: local.auto.tfvars only."
  type        = string
  default     = ""
  sensitive   = true
}

# ── Guard app versions (ARCH §15.2; runbook "Revoking an app version") ─────────────────────────

variable "mobile_min_version" {
  description = "The oldest guard app the API accepts. An older app is told to update; on a shift it keeps tracking (PROD §7)."
  type        = string
  default     = "0.1.0"
}

variable "mobile_recommended_version" {
  description = "The version the app suggests updating to."
  type        = string
  default     = "0.1.0"
}

variable "mobile_revoked_versions" {
  description = "Exact app versions that must stop working now (a security flaw). A revoked app is refused until it is updated; set it in the environment's tfvars and apply. Empty for none."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for v in var.mobile_revoked_versions : can(regex("^[0-9A-Za-z.+-]{1,40}$", v))])
    error_message = "Each revoked version must look like 0.1.3 (letters, digits, dots, plus and hyphen)."
  }
}
