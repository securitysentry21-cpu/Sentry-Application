# What the cell's configuration must keep, checked by planning it against mocked providers: no AWS
# account, no credentials, nothing created (`terraform test`, Terraform 1.7 or later). Run by CI
# (.github/workflows/ci.yml › terraform) and by `infra/scripts/tf-test.sh`. Each run names the
# review finding or the SEC/ARCH rule it holds.

mock_provider "aws" {
  # Mocked values apply while planning, which is all these runs do.
  override_during = plan
  # Plans need real-looking values where the configuration computes from them.
  mock_data "aws_caller_identity" {
    defaults = { account_id = "111122223333" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["eu-central-1a", "eu-central-1b", "eu-central-1c"] }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
  # Known only after apply in a real plan; the DNS validation records are keyed by them.
  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:eu-central-1:111122223333:certificate/mock"
      domain_validation_options = [{
        domain_name           = "app.example.test"
        resource_record_name  = "_check.app.example.test."
        resource_record_type  = "CNAME"
        resource_record_value = "_check.acm-validations.aws."
      }]
    }
  }
  # A resource's `id` stays unknown while planning unless it is mocked.
  mock_resource "aws_cognito_user_pool" {
    defaults = { id = "eu-central-1_mock" }
  }
  mock_resource "aws_cognito_user_pool_client" {
    defaults = { id = "mockclient" }
  }
  mock_resource "aws_secretsmanager_secret" {
    defaults = { arn = "arn:aws:secretsmanager:eu-central-1:111122223333:secret:mock" }
  }
  mock_resource "aws_ecr_repository" {
    defaults = { repository_url = "111122223333.dkr.ecr.eu-central-1.amazonaws.com/sentryops" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::111122223333:role/mock" }
  }
  mock_resource "aws_acm_certificate_validation" {
    defaults = { certificate_arn = "arn:aws:acm:eu-central-1:111122223333:certificate/mock" }
  }
}
mock_provider "aws" {
  alias = "backup"
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }
}
mock_provider "random" {
  override_during = plan
}
mock_provider "tls" {
  override_during = plan
  mock_resource "tls_private_key" {
    defaults = { public_key_pem = "mock public key" }
  }
}

# The production baseline (env/production.tfvars, with a domain and an alarm address).
variables {
  environment         = "production"
  domain              = "example.test"
  alerts_email        = "ops@example.test"
  fcm_service_account = "{\"type\":\"service_account\"}"
}

run "photo_bucket_keeps_versions_and_copies_them" {
  command = plan

  # Review L-03, ARCH §19.6, §19.8.
  assert {
    condition     = aws_s3_bucket_versioning.attachments.versioning_configuration[0].status == "Enabled"
    error_message = "The photo bucket must be versioned (review L-03)."
  }
  assert {
    condition     = length(aws_s3_bucket_replication_configuration.attachments) == 1
    error_message = "Production copies photos to the backup region (ARCH §19.8)."
  }
  assert {
    condition = (
      aws_s3_bucket_replication_configuration.attachments[0].rule[0].delete_marker_replication[0].status == "Enabled"
    )
    error_message = "Retention's deletions must reach the copy, or the copy outlives SEC §16."
  }
  assert {
    condition = alltrue([
      for rule in aws_s3_bucket_lifecycle_configuration.attachments.rule :
      alltrue([for n in rule.noncurrent_version_expiration : n.noncurrent_days <= var.db_backup_retention_days])
    ])
    error_message = "Older versions must expire within the backup window (SEC §16)."
  }
  # Review L-29: a rule that does it must exist, in the bucket and in its copy. Over an empty list the
  # check above is true, so it alone passed with the expiry deleted. (The filter's `prefix` is
  # computed by the provider and unknown in a mocked plan, so a prefix added to this rule is not
  # caught here; a tag or an `and` filter is.)
  assert {
    condition = alltrue([
      for lifecycle in [
        aws_s3_bucket_lifecycle_configuration.attachments,
        aws_s3_bucket_lifecycle_configuration.attachments_copy[0],
        ] : length([
          for r in lifecycle.rule : r.id if(
            r.status == "Enabled" &&
            length(r.filter) == 1 &&
            length(r.filter[0].and) == 0 &&
            length(r.filter[0].tag) == 0 &&
            length(r.noncurrent_version_expiration) == 1 &&
            r.noncurrent_version_expiration[0].noncurrent_days == var.db_backup_retention_days &&
            length(r.expiration) == 1 &&
            r.expiration[0].expired_object_delete_marker == true
          )
      ]) == 1
    ])
    error_message = "The bucket and its copy each need one rule, for every key, that expires older versions with the backups and cleans delete markers (SEC §16, review L-29)."
  }
  assert {
    condition     = aws_s3_bucket_versioning.attachments_copy[0].versioning_configuration[0].status == "Enabled"
    error_message = "The copy is versioned, so a deletion that reaches it is recoverable too (review L-03)."
  }
}

run "no_managed_waf_rule_sees_an_sos" {
  command = plan

  # Review L-02, L-28, L-29, INV-15: the only refusal of an SOS is a revoked app version. For each
  # rule, what its scope-down skips, read from the plan's structure (not from substrings of it): the
  # kind of match, its pattern, the part of the request it reads and its transformations. A new rule,
  # a lost `not`, a different field, constraint, pattern or transformation each changes the result.
  assert {
    condition = jsonencode({
      for rule in aws_wafv2_web_acl.main[0].rule : rule.name => [
        # The statements under the `not`, and those under an `or` there (a nested statement has its
        # own type, so the two lists are built apart, with the same description of each statement).
        for group in rule.statement[0].managed_rule_group_statement : sort(concat(
          [
            for s in group.scope_down_statement[0].not_statement[0].statement : (
              length(s.regex_match_statement) == 1 ? join(" ", [
                "regex",
                s.regex_match_statement[0].regex_string,
                join("+", [for f, v in s.regex_match_statement[0].field_to_match[0] : f if length(v) > 0]),
                join(",", sort([for t in s.regex_match_statement[0].text_transformation : "${t.priority}:${t.type}"])),
                ]) : length(s.byte_match_statement) == 1 ? join(" ", [
                "bytes",
                s.byte_match_statement[0].search_string,
                s.byte_match_statement[0].positional_constraint,
                join("+", [for f, v in s.byte_match_statement[0].field_to_match[0] : f if length(v) > 0]),
                join(",", sort([for t in s.byte_match_statement[0].text_transformation : "${t.priority}:${t.type}"])),
              ]) : "other"
            ) if length(s.or_statement) == 0
          ],
          flatten([
            for top in group.scope_down_statement[0].not_statement[0].statement : [
              for any in top.or_statement : [
                for s in any.statement : (
                  length(s.regex_match_statement) == 1 ? join(" ", [
                    "regex",
                    s.regex_match_statement[0].regex_string,
                    join("+", [for f, v in s.regex_match_statement[0].field_to_match[0] : f if length(v) > 0]),
                    join(",", sort([for t in s.regex_match_statement[0].text_transformation : "${t.priority}:${t.type}"])),
                    ]) : length(s.byte_match_statement) == 1 ? join(" ", [
                    "bytes",
                    s.byte_match_statement[0].search_string,
                    s.byte_match_statement[0].positional_constraint,
                    join("+", [for f, v in s.byte_match_statement[0].field_to_match[0] : f if length(v) > 0]),
                    join(",", sort([for t in s.byte_match_statement[0].text_transformation : "${t.priority}:${t.type}"])),
                  ]) : "other"
                )
              ]
            ]
          ]),
        ))
      ]
      }) == jsonencode({
      "aws-ip-reputation" = [[
        "regex ^/api/v1/sos(/[0-9a-fA-F-]{36}/(status|locations|cancel-request))?$ uri_path 0:URL_DECODE,1:NORMALIZE_PATH",
      ]]
      "aws-common" = [[
        "bytes /api/v1/sync/ STARTS_WITH uri_path 0:URL_DECODE,1:NORMALIZE_PATH",
        "regex ^/api/v1/sos(/[0-9a-fA-F-]{36}/(status|locations|cancel-request))?$ uri_path 0:URL_DECODE,1:NORMALIZE_PATH",
      ]]
      "aws-known-bad-inputs" = [[
        "bytes /api/v1/sync/ STARTS_WITH uri_path 0:URL_DECODE,1:NORMALIZE_PATH",
        "regex ^/api/v1/sos(/[0-9a-fA-F-]{36}/(status|locations|cancel-request))?$ uri_path 0:URL_DECODE,1:NORMALIZE_PATH",
      ]]
    })
    error_message = "Each managed WAF rule group must skip exactly the guard's SOS routes (and the body rules /api/v1/sync/), by URI path, decoded and normalized (INV-15, review L-02, L-28)."
  }
}

run "database_logs_keep_no_values" {
  command = plan

  # Review L-05, SEC §15: no bind parameter and no failing row in PostgreSQL's log.
  assert {
    condition = alltrue([
      for name, value in {
        log_parameter_max_length          = "0"
        log_parameter_max_length_on_error = "0"
        log_error_verbosity               = "terse"
      } : contains([for p in aws_db_parameter_group.main.parameter : "${p.name}=${p.value}"], "${name}=${value}")
    ])
    error_message = "PostgreSQL must log no parameters and no error DETAIL (review L-05)."
  }
  assert {
    condition     = aws_cloudwatch_log_group.postgresql.retention_in_days == 30
    error_message = "The PostgreSQL log must expire (review L-05)."
  }
}

run "the_api_believes_only_the_load_balancer" {
  command = plan

  # Review L-06: X-Forwarded-For only from inside the VPC; the dashboard gets the photo host (L-01).
  assert {
    condition = strcontains(
      aws_ecs_task_definition.api.container_definitions,
      jsonencode({ name = "TRUST_PROXY", value = "10.20.0.0/16" })
    )
    error_message = "TRUST_PROXY must be the VPC range, never true (review L-06)."
  }
  assert {
    condition = strcontains(
      aws_ecs_task_definition.web.container_definitions,
      "\"name\":\"PHOTO_ORIGIN\",\"value\":\"https://sentryops-production-attachments-111122223333.s3.eu-central-1.amazonaws.com\""
    )
    error_message = "The dashboard's CSP needs the photo bucket's origin (review L-01)."
  }
}

run "released_images_are_kept" {
  command = plan

  # Review L-14: the image an environment runs is never expired by the "last 30" rule.
  assert {
    condition = (
      jsondecode(aws_ecr_lifecycle_policy.app.policy).rules[0].rulePriority == 1 &&
      jsondecode(aws_ecr_lifecycle_policy.app.policy).rules[0].selection.tagPatternList == ["release-*"] &&
      jsondecode(aws_ecr_lifecycle_policy.app.policy).rules[0].selection.countNumber >= 50
    )
    error_message = "Released images (release-*) must be kept by the first lifecycle rule (review L-14)."
  }
}

# Review L-15: production refuses to plan without what only local.auto.tfvars holds, or its domain.
run "production_needs_its_domain" {
  command = plan
  variables {
    domain = ""
  }
  expect_failures = [var.domain]
}

run "production_needs_the_alarm_address" {
  command = plan
  variables {
    alerts_email = ""
  }
  expect_failures = [var.alerts_email]
}

run "production_needs_the_push_credentials" {
  command = plan
  variables {
    fcm_service_account = ""
  }
  expect_failures = [var.fcm_service_account]
}

# Pass 2 on L-15: production cannot turn off its WAF or its backup-region copy.
run "production_keeps_its_waf" {
  command = plan
  variables {
    waf_enabled = false
  }
  expect_failures = [var.waf_enabled]
}

run "production_keeps_its_backup_copy" {
  command = plan
  variables {
    backup_copy_enabled = false
  }
  expect_failures = [var.backup_copy_enabled]
}

# The test environment (env/test.tfvars) still plans with none of them.
run "test_environment_plans_without_them" {
  command = plan
  variables {
    environment         = "test"
    domain              = ""
    alerts_email        = ""
    fcm_service_account = ""
    waf_enabled         = false
    backup_copy_enabled = false
  }
  assert {
    condition     = length(aws_s3_bucket_replication_configuration.attachments) == 0
    error_message = "The test environment has no backup copy."
  }
}
