# Detection (ARCH §19.8): CloudTrail records every API call in the account, and GuardDuty looks for
# threats; its findings go to the operator by email.
resource "aws_s3_bucket" "trail" {
  bucket = "${local.name}-cloudtrail-${local.account_id}"
}

resource "aws_s3_bucket_public_access_block" "trail" {
  bucket                  = aws_s3_bucket.trail.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "trail" {
  bucket = aws_s3_bucket.trail.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "trail" {
  bucket = aws_s3_bucket.trail.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "trail" {
  bucket = aws_s3_bucket.trail.id
  rule {
    id     = "expire-after-a-year"
    status = "Enabled"
    filter {}
    expiration {
      days = 365
    }
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

locals {
  trail_arn = "arn:aws:cloudtrail:${var.region}:${local.account_id}:trail/${local.name}"
}

data "aws_iam_policy_document" "trail_bucket" {
  statement {
    sid       = "CloudTrailAclCheck"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.trail.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }
  }
  statement {
    sid       = "CloudTrailWrite"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.trail.arn}/AWSLogs/${local.account_id}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }
  }
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.trail.arn, "${aws_s3_bucket.trail.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "trail" {
  bucket = aws_s3_bucket.trail.id
  policy = data.aws_iam_policy_document.trail_bucket.json
}

resource "aws_cloudtrail" "main" {
  name                          = local.name
  s3_bucket_name                = aws_s3_bucket.trail.id
  is_multi_region_trail         = var.cloudtrail_multi_region
  include_global_service_events = true
  enable_log_file_validation    = true
  depends_on                    = [aws_s3_bucket_policy.trail]

  # With selectors the trail records only what they select, so management events (every API call
  # in the account) are named first.
  advanced_event_selector {
    name = "management events"
    field_selector {
      field  = "eventCategory"
      equals = ["Management"]
    }
  }

  # Review L-22, approved by the owner 2026-11-23: every read, upload, overwrite and delete of an
  # object in the photo bucket, a signed link's included. Versioning keeps a deleted original (Q2);
  # this is how anyone learns that one needs recovering. About $0.10 per 100,000 requests.
  advanced_event_selector {
    name = "photo bucket objects"
    field_selector {
      field  = "eventCategory"
      equals = ["Data"]
    }
    field_selector {
      field  = "resources.type"
      equals = ["AWS::S3::Object"]
    }
    field_selector {
      field       = "resources.ARN"
      starts_with = ["${aws_s3_bucket.attachments.arn}/"]
    }
  }
}

# A photo or export deleted by anyone but the worker (retention, and export files after 7 days)
# emails the operator: a bug, a stolen role or a person. Runbook 08 says how to recover the version.
# The worker's own deletes are counted in its RETENTION_RUN rows instead.
resource "aws_cloudwatch_event_rule" "photo_deleted" {
  name        = "${local.name}-photo-deleted"
  description = "An object in the photo bucket deleted by anyone but the worker (runbook 08)"
  event_pattern = jsonencode({
    source        = ["aws.s3"]
    "detail-type" = ["AWS API Call via CloudTrail"]
    detail = {
      eventSource       = ["s3.amazonaws.com"]
      eventName         = ["DeleteObject", "DeleteObjects", "DeleteObjectVersion"]
      requestParameters = { bucketName = [aws_s3_bucket.attachments.id] }
      # A role's session other than the worker's, or anyone signed in some other way (an IAM user,
      # the root user), which has no session issuer at all.
      "$or" = [
        { userIdentity = { sessionContext = { sessionIssuer = { arn = [{ "anything-but" = [aws_iam_role.task["worker"].arn] }] } } } },
        { userIdentity = { type = [{ "anything-but" = ["AssumedRole"] }] } },
      ]
    }
  })
}

resource "aws_cloudwatch_event_target" "photo_deleted" {
  rule = aws_cloudwatch_event_rule.photo_deleted.name
  arn  = aws_sns_topic.operations.arn
}

resource "aws_guardduty_detector" "main" {
  count  = var.guardduty_enabled ? 1 : 0
  enable = true
}

# Not encrypted with the AWS-managed SNS key: EventBridge can't publish to a topic that uses it.
# Findings name resources, never guard data.
resource "aws_sns_topic" "alerts" {
  count = var.guardduty_enabled ? 1 : 0
  name  = "${local.name}-security-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  count     = var.guardduty_enabled && var.alerts_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alerts[0].arn
  protocol  = "email"
  endpoint  = var.alerts_email
}

resource "aws_cloudwatch_event_rule" "guardduty" {
  count       = var.guardduty_enabled ? 1 : 0
  name        = "${local.name}-guardduty-findings"
  description = "GuardDuty findings of medium severity and above"
  event_pattern = jsonencode({
    source        = ["aws.guardduty"]
    "detail-type" = ["GuardDuty Finding"]
    detail        = { severity = [{ numeric = [">=", 4] }] }
  })
}

resource "aws_cloudwatch_event_target" "guardduty" {
  count = var.guardduty_enabled ? 1 : 0
  rule  = aws_cloudwatch_event_rule.guardduty[0].name
  arn   = aws_sns_topic.alerts[0].arn
}

data "aws_iam_policy_document" "alerts_topic" {
  count = var.guardduty_enabled ? 1 : 0
  statement {
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts[0].arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.guardduty[0].arn]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  count  = var.guardduty_enabled ? 1 : 0
  arn    = aws_sns_topic.alerts[0].arn
  policy = data.aws_iam_policy_document.alerts_topic[0].json
}

# Spending warnings by email. Credits are left out, so the warning comes while there is still credit
# left, not after it has run out.
resource "aws_budgets_budget" "monthly" {
  count        = var.alerts_email == "" ? 0 : 1
  name         = "${local.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_types {
    include_credit = false
    include_refund = false
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 85
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alerts_email]
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.alerts_email]
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.alerts_email]
  }
}
