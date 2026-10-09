# The services on ECS Fargate, Arm (ARCH §19.8): api, web and worker run continuously; dbadmin is a
# one-off task (migrations) and the api task also runs the operator CLI. One image for all of them.
resource "aws_ecr_repository" "app" {
  name                 = "sentryops"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 30 images"
      selection    = { tagStatus = "any", countType = "imageCountMoreThan", countNumber = 30 }
      action       = { type = "expire" }
    }]
  })
}

resource "aws_ecs_cluster" "main" {
  name = local.name
}

resource "aws_cloudwatch_log_group" "service" {
  for_each          = toset(["api", "web", "worker", "dbadmin"])
  name              = "/${local.name}/${each.key}"
  retention_in_days = 30
}

locals {
  # Before the first release there is no image yet: the services stay at zero tasks on a placeholder.
  placeholder_image = "public.ecr.aws/docker/library/busybox:stable"
  image             = var.image_tag == "" ? local.placeholder_image : "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
  migration_image   = var.migration_image_tag == "" ? local.placeholder_image : "${aws_ecr_repository.app.repository_url}:${var.migration_image_tag}"
  released          = var.image_tag != ""

  app_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "CELL_REGION", value = var.region },
    { name = "PUBLIC_ORIGIN", value = local.public_origin },
    { name = "TRUST_PROXY", value = "true" },
    { name = "LOG_LEVEL", value = "info" },
    { name = "OIDC_ISSUER", value = "https://cognito-idp.${var.region}.amazonaws.com/${aws_cognito_user_pool.dashboard.id}" },
    { name = "OIDC_CLIENT_ID", value = aws_cognito_user_pool_client.dashboard.id },
    { name = "FEATURE_SOS", value = "false" },
    { name = "MOBILE_MIN_VERSION", value = "0.1.0" },
    { name = "MOBILE_RECOMMENDED_VERSION", value = "0.1.0" },
  ]

  logs = {
    for k, g in aws_cloudwatch_log_group.service : k => {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = g.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = k
      }
    }
  }

  secret_from = {
    api    = aws_secretsmanager_secret.api.arn
    worker = aws_secretsmanager_secret.worker.arn
  }
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution["api"].arn
  task_role_arn            = aws_iam_role.task["api"].arn
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([{
    name         = "api"
    image        = local.image
    essential    = true
    command      = ["node", "apps/api/src/main.ts"]
    portMappings = [{ containerPort = 4000, protocol = "tcp" }]
    environment  = concat(local.app_environment, [{ name = "HOST", value = "0.0.0.0" }, { name = "PORT", value = "4000" }])
    secrets = [for key in ["DATABASE_URL", "QR_TOKEN_SECRET", "OIDC_CLIENT_SECRET"] :
    { name = key, valueFrom = "${local.secret_from.api}:${key}::" }]
    logConfiguration = local.logs["api"]
  }])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution["worker"].arn
  task_role_arn            = aws_iam_role.task["worker"].arn
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([{
    name        = "worker"
    image       = local.image
    essential   = true
    command     = ["node", "apps/api/src/worker.ts"]
    environment = concat(local.app_environment, [{ name = "DETECTOR_INTERVAL_S", value = "60" }])
    secrets = [for key in ["DATABASE_URL", "SWEEP_DATABASE_URL", "QR_TOKEN_SECRET", "OIDC_CLIENT_SECRET"] :
    { name = key, valueFrom = "${local.secret_from.worker}:${key}::" }]
    logConfiguration = local.logs["worker"]
  }])
}

resource "aws_ecs_task_definition" "web" {
  family                   = "${local.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution["web"].arn
  task_role_arn            = aws_iam_role.task["web"].arn
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([{
    name             = "web"
    image            = local.image
    essential        = true
    command          = ["node", "node_modules/next/dist/bin/next", "start", "apps/web", "--port", "3000", "--hostname", "0.0.0.0"]
    portMappings     = [{ containerPort = 3000, protocol = "tcp" }]
    environment      = [{ name = "NODE_ENV", value = "production" }]
    logConfiguration = local.logs["web"]
  }])
}

# Migrations (packages/db/scripts/deploy-db.ts), run by infra/scripts/release.sh before the services move.
resource "aws_ecs_task_definition" "dbadmin" {
  family                   = "${local.name}-dbadmin"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution["dbadmin"].arn
  task_role_arn            = aws_iam_role.task["dbadmin"].arn
  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }
  container_definitions = jsonencode([{
    name      = "dbadmin"
    image     = local.migration_image
    essential = true
    command   = ["node", "packages/db/scripts/deploy-db.ts"]
    environment = [
      { name = "DB_HOST", value = aws_db_instance.main.address },
      { name = "DB_PORT", value = tostring(aws_db_instance.main.port) },
      { name = "DB_NAME", value = "sentryops" },
      { name = "DB_SSL_ROOT_CERT", value = local.db_ca_path },
    ]
    secrets = concat(
      [
        { name = "DB_ADMIN_USER", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:username::" },
        { name = "DB_ADMIN_PASSWORD", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::" },
      ],
      [for key in ["MIGRATOR_PASSWORD", "APP_RUNTIME_PASSWORD", "SYSTEM_WORKER_PASSWORD", "RETENTION_WORKER_PASSWORD"] :
      { name = key, valueFrom = "${aws_secretsmanager_secret.db_roles.arn}:${key}::" }],
    )
    logConfiguration = local.logs["dbadmin"]
  }])
}

locals {
  services = {
    api    = { definition = aws_ecs_task_definition.api.arn, count = var.api_desired_count, port = 4000, target = aws_lb_target_group.api.arn }
    web    = { definition = aws_ecs_task_definition.web.arn, count = var.web_desired_count, port = 3000, target = aws_lb_target_group.web.arn }
    worker = { definition = aws_ecs_task_definition.worker.arn, count = 1, port = null, target = null }
  }
}

resource "aws_ecs_service" "app" {
  for_each        = local.services
  name            = each.key
  cluster         = aws_ecs_cluster.main.id
  task_definition = each.value.definition
  desired_count   = local.released ? each.value.count : 0
  launch_type     = "FARGATE"
  propagate_tags  = "SERVICE"

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.service[each.key].id]
    assign_public_ip = true
  }

  dynamic "load_balancer" {
    for_each = each.value.target == null ? [] : [each.value]
    content {
      target_group_arn = load_balancer.value.target
      container_name   = each.key
      container_port   = load_balancer.value.port
    }
  }

  # A failed deployment rolls back by itself.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  deployment_minimum_healthy_percent = each.key == "worker" ? 0 : 100
  deployment_maximum_percent         = each.key == "worker" ? 100 : 200
  health_check_grace_period_seconds  = each.value.target == null ? null : 60

  depends_on = [aws_lb_listener.https, aws_lb_listener.http_forward]
}

# ── Roles: one execution role (pulls the image, reads its secrets) and one task role per service ──

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "execution" {
  for_each           = toset(["api", "web", "worker", "dbadmin"])
  name               = "${local.name}-${each.key}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  for_each   = aws_iam_role.execution
  role       = each.value.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

locals {
  execution_secrets = {
    api     = [aws_secretsmanager_secret.api.arn]
    worker  = [aws_secretsmanager_secret.worker.arn]
    dbadmin = [aws_secretsmanager_secret.db_roles.arn, aws_db_instance.main.master_user_secret[0].secret_arn]
  }
}

data "aws_iam_policy_document" "execution_secrets" {
  for_each = local.execution_secrets
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = each.value
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.main.arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  for_each = local.execution_secrets
  name     = "read-own-secrets"
  role     = aws_iam_role.execution[each.key].name
  policy   = data.aws_iam_policy_document.execution_secrets[each.key].json
}

# The services' own AWS permissions: none yet (files in S3 arrive with incidents, Phase 8).
resource "aws_iam_role" "task" {
  for_each           = toset(["api", "web", "worker", "dbadmin"])
  name               = "${local.name}-${each.key}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}
