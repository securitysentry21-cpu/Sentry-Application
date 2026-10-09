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

variable "api_desired_count" {
  type    = number
  default = 1
}

variable "web_desired_count" {
  type    = number
  default = 1
}
