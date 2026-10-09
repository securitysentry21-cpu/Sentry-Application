# RDS for PostgreSQL 17 (ARCH §19.8): private subnets, no public endpoint, TLS required, encrypted
# with our own KMS key, 35 days of point-in-time recovery; in production also a standby in a second
# zone (db_multi_az) and automated backups copied to eu-west-1 (backup_copy_enabled).
resource "aws_kms_key" "main" {
  description             = "${local.name}: database, its backups and the application secrets"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_kms_alias" "main" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.main.key_id
}

resource "aws_kms_key" "backup" {
  count                   = var.backup_copy_enabled ? 1 : 0
  provider                = aws.backup
  description             = "${local.name}: database backups copied to ${var.backup_region}"
  enable_key_rotation     = true
  deletion_window_in_days = 30
}

resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_parameter_group" "main" {
  name   = "${local.name}-pg17"
  family = "postgres17"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  # Slow statements are logged by duration only; parameters may hold personal data and stay out.
  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }
}

resource "aws_db_instance" "main" {
  identifier     = local.name
  engine         = "postgres"
  engine_version = "17"
  instance_class = var.db_instance_class

  allocated_storage     = var.db_allocated_storage_gb
  max_allocated_storage = var.db_allocated_storage_gb * 5
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.main.arn

  # The administrator only creates roles and the database (packages/db/scripts/deploy-db.ts); RDS
  # keeps its password in Secrets Manager and rotates it. Nothing else ever uses it.
  username                      = "sentry_admin"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.main.key_id

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  publicly_accessible    = false
  multi_az               = var.db_multi_az
  parameter_group_name   = aws_db_parameter_group.main.name
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  backup_retention_period = 35
  backup_window           = "20:00-21:00"         # 01:00–02:00 in Pakistan
  maintenance_window      = "sun:21:30-sun:22:30" # Monday 02:30–03:30 in Pakistan
  copy_tags_to_snapshot   = true

  auto_minor_version_upgrade      = true
  deletion_protection             = var.environment == "production"
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${local.name}-final"
  enabled_cloudwatch_logs_exports = ["postgresql"]
}

resource "aws_db_instance_automated_backups_replication" "backup" {
  count                  = var.backup_copy_enabled ? 1 : 0
  provider               = aws.backup
  source_db_instance_arn = aws_db_instance.main.arn
  kms_key_id             = aws_kms_key.backup[0].arn
  retention_period       = 35
}
