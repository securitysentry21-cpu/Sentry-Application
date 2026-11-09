# Notifications (ARCH §13, D-26) and the SOS pipeline's alarms (Phase 8).
#
# Web Push for the dashboard: the VAPID key pair is generated here. Only the worker sends, so only the
# worker's secret holds the private key; the api, which faces the internet, gets the public half and
# tells browsers that (apps/api config.ts). Pushes to the guard app go through Firebase Cloud Messaging
# with the service account in var.fcm_service_account, once the Firebase project exists.
resource "tls_private_key" "vapid" {
  algorithm   = "ECDSA"
  ecdsa_curve = "P256"
}

# Alarms for the operator, by email (var.alerts_email). Every message is about the pipeline, never a
# person: no names, numbers or coordinates are ever logged (SEC §15).
resource "aws_sns_topic" "operations" {
  name = "${local.name}-operations"
}

resource "aws_sns_topic_subscription" "operations_email" {
  count     = var.alerts_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.operations.arn
  protocol  = "email"
  endpoint  = var.alerts_email
}

locals {
  metric_namespace = "SENTRY/${var.environment}"

  # What the worker logs (apps/api/src/worker.ts), counted from its JSON log lines.
  worker_metrics = {
    SosPipelineErrors            = "{ $.msg = \"sos pipeline error*\" }"
    NotificationProviderFailures = "{ $.msg = \"notification provider failure\" }"
    SosUnacknowledged            = "{ $.msg = \"sos unacknowledged\" }"
    CanaryFailures               = "{ $.msg = \"canary failed\" || $.msg = \"canary misconfigured\" }"
    CanaryOk                     = "{ $.msg = \"canary ok\" }"
    # Review L-12: every other loop's failure line (apps/api/src/worker.ts › failed()). The outbox
    # dispatcher is how an SOS reaches the dashboards; the detectors run the "sos unacknowledged"
    # check. A loop that fails each round still reports on time, so job lag never shows it.
    WorkerLoopFailures = "{ ${join(" || ", [for m in local.worker_loop_failures : "$.msg = \"${m}\""])} }"
  }
  worker_loop_failures = [
    "outbox dispatcher failed",
    "shift detectors failed",
    "attachment processor failed",
    "export runner failed",
    "retention run failed",
  ]

  alarms = {
    sos-pipeline-error = {
      metric      = "SosPipelineErrors"
      description = "The SOS escalation or sender loop failed. Check the worker log now."
      period      = 60
      threshold   = 1
    }
    notification-provider-failure = {
      metric      = "NotificationProviderFailures"
      description = "A push or SMS provider refused or failed three times in five minutes."
      period      = 300
      threshold   = 3
    }
    sos-unacknowledged = {
      metric      = "SosUnacknowledged"
      description = "An SOS has been open and unacknowledged for longer than the organization's limit."
      period      = 60
      threshold   = 1
    }
    worker-loop-failed = {
      metric      = "WorkerLoopFailures"
      description = "A worker loop (outbox dispatcher, detectors, photos, exports or retention) failed 3 times in 5 minutes: dashboards may not be getting SOS updates. Check the worker log (runbook: SOS notifications failing)."
      period      = 300
      threshold   = 3
    }
    canary-failed = {
      metric      = "CanaryFailures"
      description = "The synthetic SOS did not make it through (or the canary is misconfigured)."
      period      = 600
      threshold   = 1
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "worker" {
  for_each       = local.worker_metrics
  name           = "${local.name}-${each.key}"
  log_group_name = aws_cloudwatch_log_group.service["worker"].name
  pattern        = each.value
  metric_transformation {
    name          = each.key
    namespace     = local.metric_namespace
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "worker" {
  for_each            = local.alarms
  alarm_name          = "${local.name}-${each.key}"
  alarm_description   = each.value.description
  namespace           = local.metric_namespace
  metric_name         = each.value.metric
  statistic           = "Sum"
  period              = each.value.period
  evaluation_periods  = 1
  threshold           = each.value.threshold
  comparison_operator = "GreaterThanOrEqualToThreshold"
  # No log lines (the environment paused, a quiet night) is not a failure.
  treat_missing_data = "notBreaching"
  alarm_actions      = [aws_sns_topic.operations.arn]
  ok_actions         = [aws_sns_topic.operations.arn]
  depends_on         = [aws_cloudwatch_log_metric_filter.worker]
}

# The canary gone quiet: no successful run for 30 minutes while it is switched on.
resource "aws_cloudwatch_metric_alarm" "canary_silent" {
  count               = var.canary_enabled && !var.paused ? 1 : 0
  alarm_name          = "${local.name}-canary-silent"
  alarm_description   = "No successful synthetic SOS for 30 minutes: the worker or the pipeline is down."
  namespace           = local.metric_namespace
  metric_name         = "CanaryOk"
  statistic           = "Sum"
  period              = 600
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.worker]
}
