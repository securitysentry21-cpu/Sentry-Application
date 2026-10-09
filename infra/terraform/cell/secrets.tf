# Secrets Manager (SEC §13): generated here, read only by the tasks that need them, encrypted with
# our key. One secret per consumer, so each task's role can read only its own (least privilege).
resource "random_password" "db" {
  for_each = toset(["migrator", "app_runtime", "system_worker", "retention_worker"])
  length   = 40
  special  = false
}

# Derives checkpoint QR tokens (ARCH §11.1). Changing it invalidates every printed label.
resource "random_password" "qr_token_secret" {
  length  = 64
  special = false
}

locals {
  # Inside the image (infra/docker/Dockerfile): the RDS certificate authorities of every region.
  db_ca_path = "/repo/infra/certs/rds-global-bundle.pem"
  db_url = {
    for role in ["app_runtime", "system_worker"] :
    role => "postgres://${role}:${random_password.db[role].result}@${aws_db_instance.main.address}:${aws_db_instance.main.port}/sentryops?sslmode=verify-full&sslrootcert=${local.db_ca_path}"
  }
}

resource "aws_secretsmanager_secret" "api" {
  name                    = "${local.name}/api"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "api" {
  secret_id = aws_secretsmanager_secret.api.id
  secret_string = jsonencode({
    DATABASE_URL       = local.db_url.app_runtime
    QR_TOKEN_SECRET    = random_password.qr_token_secret.result
    OIDC_CLIENT_SECRET = aws_cognito_user_pool_client.dashboard.client_secret
  })
}

# The worker also sweeps across organizations as system_worker (ARCH §4.5).
resource "aws_secretsmanager_secret" "worker" {
  name                    = "${local.name}/worker"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "worker" {
  secret_id = aws_secretsmanager_secret.worker.id
  secret_string = jsonencode({
    DATABASE_URL       = local.db_url.app_runtime
    SWEEP_DATABASE_URL = local.db_url.system_worker
    QR_TOKEN_SECRET    = random_password.qr_token_secret.result
    OIDC_CLIENT_SECRET = aws_cognito_user_pool_client.dashboard.client_secret
  })
}

# Read only by the one-off database task, which sets these passwords on the roles.
resource "aws_secretsmanager_secret" "db_roles" {
  name                    = "${local.name}/db-roles"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "db_roles" {
  secret_id = aws_secretsmanager_secret.db_roles.id
  secret_string = jsonencode({
    MIGRATOR_PASSWORD         = random_password.db["migrator"].result
    APP_RUNTIME_PASSWORD      = random_password.db["app_runtime"].result
    SYSTEM_WORKER_PASSWORD    = random_password.db["system_worker"].result
    RETENTION_WORKER_PASSWORD = random_password.db["retention_worker"].result
  })
}
