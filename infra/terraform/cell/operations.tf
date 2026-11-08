# The operator's alarms beyond the SOS pipeline's (ARCH §18.3, §18.4), by email through the same
# topic (notifications.tf). Every alarm says what to look at and names its runbook (docs/RUNBOOKS).
# Each reads either a log line with a fixed `msg` (counts and seconds only, SEC §15) or an AWS metric.
#
# Cost: CloudWatch bills about $0.10 a month per alarm metric, and the first ten are free (the
# published rate; check the bill). The alarms here add up to about a dozen metrics beyond those in
# notifications.tf, so roughly $1 a month. Paused environments quiet the ones that would otherwise
# fire because nothing is running.

locals {
  active = var.paused ? 0 : 1

  # Values the worker and the API log, read as metrics.
  value_filters = {
    JobLagSeconds = {
      group   = "worker"
      pattern = "{ $.msg = \"worker heartbeat\" }"
      value   = "$.maxJobLagSeconds"
      default = null
    }
    WorkerHeartbeat = {
      group   = "worker"
      pattern = "{ $.msg = \"worker heartbeat\" }"
      value   = "1"
      default = null
    }
    # The heartbeat keeps the log group busy, so a round with nothing to count reads 0, not "no data".
    NotificationsSent = {
      group   = "worker"
      pattern = "{ $.msg = \"notification run\" }"
      value   = "$.sent"
      default = 0
    }
    NotificationsFailed = {
      group   = "worker"
      pattern = "{ $.msg = \"notification run\" }"
      value   = "$.failed"
      default = 0
    }
    AppErrorReports = {
      group   = "api"
      pattern = "{ $.msg = \"app_error\" }"
      value   = "1"
      default = 0
    }
  }

  alb_dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
    TargetGroup  = aws_lb_target_group.api.arn_suffix
  }
}

resource "aws_cloudwatch_log_metric_filter" "values" {
  for_each       = local.value_filters
  name           = "${local.name}-${each.key}"
  log_group_name = aws_cloudwatch_log_group.service[each.value.group].name
  pattern        = each.value.pattern
  metric_transformation {
    name          = each.key
    namespace     = local.metric_namespace
    value         = each.value.value
    default_value = each.value.default
  }
}

# Job lag over 2 minutes (ARCH §18.3): a loop in the worker is that far behind its schedule.
resource "aws_cloudwatch_metric_alarm" "job_lag" {
  alarm_name          = "${local.name}-job-lag"
  alarm_description   = "A background loop is more than 2 minutes late (runbook: SOS notifications failing). Check the worker's log for the lagging job."
  namespace           = local.metric_namespace
  metric_name         = "JobLagSeconds"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 120
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.values]
}

# The worker gone: its heartbeat (every 30 s) stopped for 5 minutes. Only while the environment runs.
resource "aws_cloudwatch_metric_alarm" "worker_silent" {
  count               = local.active
  alarm_name          = "${local.name}-worker-silent"
  alarm_description   = "The worker has logged no heartbeat for 5 minutes: it is down or stuck (runbook: SOS notifications failing)."
  namespace           = local.metric_namespace
  metric_name         = "WorkerHeartbeat"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.values]
}

# A provider failing more than 5% of the sends in 15 minutes (ARCH §18.4), once there are at least 10.
resource "aws_cloudwatch_metric_alarm" "notification_failure_rate" {
  alarm_name          = "${local.name}-notification-failure-rate"
  alarm_description   = "More than 5% of notification sends failed in 15 minutes (runbook: notification provider outage)."
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.values]

  metric_query {
    id          = "rate"
    expression  = "IF(sent + failed >= 10, 100 * failed / (sent + failed + 0.0001), 0)"
    label       = "failed sends, %"
    return_data = true
  }
  metric_query {
    id = "sent"
    metric {
      namespace   = local.metric_namespace
      metric_name = "NotificationsSent"
      period      = 900
      stat        = "Sum"
    }
  }
  metric_query {
    id = "failed"
    metric {
      namespace   = local.metric_namespace
      metric_name = "NotificationsFailed"
      period      = 900
      stat        = "Sum"
    }
  }
}

# Server errors above 2% of the API's requests (ARCH §18.4), once there are at least 50 in 5 minutes.
# The load balancer reports a count of 5xx only when there were some, so a missing one counts as 0.
resource "aws_cloudwatch_metric_alarm" "api_error_rate" {
  alarm_name          = "${local.name}-api-error-rate"
  alarm_description   = "More than 2% of API requests ended in a server error (5xx) for 15 minutes (runbook: mass device offline; check the API log)."
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = 2
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]

  metric_query {
    id          = "rate"
    expression  = "IF(FILL(requests, 0) >= 50, 100 * FILL(errors, 0) / (FILL(requests, 0) + 0.0001), 0)"
    label       = "API server errors, %"
    return_data = true
  }
  metric_query {
    id = "requests"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      period      = 300
      stat        = "Sum"
      dimensions  = local.alb_dimensions
    }
  }
  metric_query {
    id = "errors"
    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      period      = 300
      stat        = "Sum"
      dimensions  = local.alb_dimensions
    }
  }
}

# No API task passing the load balancer's health check (the API tasks are down).
resource "aws_cloudwatch_metric_alarm" "api_unhealthy" {
  count               = local.active
  alarm_name          = "${local.name}-api-unhealthy"
  alarm_description   = "No healthy API task behind the load balancer for 2 minutes: guards cannot sync and an SOS cannot arrive (runbook: mass device offline)."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  dimensions          = local.alb_dimensions
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]
}

# Database health (ARCH §18.4): processor, and disk before it runs out.
resource "aws_cloudwatch_metric_alarm" "db_cpu" {
  alarm_name          = "${local.name}-db-cpu"
  alarm_description   = "The database processor has been above 85% for 15 minutes (runbook: database restore, if it does not settle)."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 85
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]
}

resource "aws_cloudwatch_metric_alarm" "db_storage" {
  alarm_name          = "${local.name}-db-storage"
  alarm_description   = "The database has under 15% of its disk left. Storage can grow on its own only up to its limit (database.tf); raise it before it runs out."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = var.db_allocated_storage_gb * 1024 * 1024 * 1024 * 0.15
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]
}

# The certificate (production, where we hold our own): AWS renews it by itself, so this fires only
# when a renewal is failing, three weeks before it would matter.
resource "aws_cloudwatch_metric_alarm" "certificate_expiry" {
  count               = local.has_domain ? 1 : 0
  alarm_name          = "${local.name}-certificate-expiry"
  alarm_description   = "The dashboard's certificate expires in under 21 days and was not renewed. Check its DNS validation record."
  namespace           = "AWS/CertificateManager"
  metric_name         = "DaysToExpiry"
  dimensions          = { CertificateArn = aws_acm_certificate.app[0].arn }
  statistic           = "Minimum"
  period              = 86400
  evaluation_periods  = 1
  threshold           = 21
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]
}

# The guard app reporting its own errors in a burst (ARCH §18.6): a bad release, or a crash loop.
resource "aws_cloudwatch_metric_alarm" "app_error_burst" {
  alarm_name          = "${local.name}-app-error-burst"
  alarm_description   = "20 or more error reports from guard phones in 15 minutes: a build may be broken (runbook: revoking an app version). Read the app_error lines in the API log."
  namespace           = local.metric_namespace
  metric_name         = "AppErrorReports"
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = 20
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]
  depends_on          = [aws_cloudwatch_log_metric_filter.values]
}
