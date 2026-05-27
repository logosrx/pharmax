# =============================================================================
# RDS module — Postgres 16, Multi-AZ, encrypted, isolated subnets.
#
# Design choices (HIPAA / SOC 2 aware):
#   - Storage encryption with a customer-managed KMS key.
#   - TLS-only enforced via parameter group (`rds.force_ssl = 1`).
#   - No public_access. Security group accepts 5432 ONLY from the ECS task SG.
#   - Performance Insights on (KMS-encrypted), Enhanced Monitoring on.
#   - Postgres logs exported to CloudWatch for retention + alerting.
#   - copy_tags_to_snapshot so backup snapshots inherit the
#     `DataClassification = phi` tag — required for our backup-scan policy.
#   - Master password is generated and stored in Secrets Manager BEFORE the
#     RDS instance is created (operator populates the secret out-of-band, or
#     uses RDS-managed master user password). We deliberately do NOT pass the
#     password in `master_password` to avoid plaintext in state.
#
# The actual password rotation is handled by Secrets Manager + RDS-managed
# rotation (see manage_master_user_password below).
# =============================================================================

resource "aws_db_subnet_group" "this" {
  name       = "${var.name_prefix}-db"
  subnet_ids = var.isolated_subnet_ids

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-db-subnet-group"
  })
}

resource "aws_security_group" "rds" {
  name        = "${var.name_prefix}-rds"
  description = "RDS Postgres SG — accepts 5432 only from the ECS task SG"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-rds"
  })
}

resource "aws_security_group_rule" "rds_ingress_from_app" {
  count = length(var.ingress_security_group_ids)

  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = var.ingress_security_group_ids[count.index]
  security_group_id        = aws_security_group.rds.id
  description              = "Allow Postgres from app SG ${var.ingress_security_group_ids[count.index]}"
}

# Default deny on egress (we don't want RDS calling out anywhere).
# RDS doesn't open egress unless asked, but stating the empty rule explicitly
# makes the intent reviewable.

# ---- Parameter group --------------------------------------------------------
#
# Enforces TLS, useful logging, and prepares the row-level-security and
# audit chain workloads.
#
# - rds.force_ssl = 1 → reject non-TLS connections at the engine
# - log_statement = ddl → record DDL but not data (no PHI in logs)
# - log_min_duration_statement = 1000 → log slow queries for tuning
# - log_connections = 1 → audit who connects (with their pg role)
# - log_disconnections = 1 → matched pair to log_connections
# - shared_preload_libraries = pg_stat_statements → query stats for perf
# - track_io_timing = on → cheap perf data
# - statement_timeout matches our app-level Prisma timeouts
# - idle_in_transaction_session_timeout caps abandoned txns that would
#   hold RLS row locks (very important for the command-bus pattern)

resource "aws_db_parameter_group" "this" {
  name        = "${var.name_prefix}-pg"
  family      = var.parameter_group_family
  description = "Hardened Pharmax Postgres parameter group"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  parameter {
    name  = "log_statement"
    value = "ddl"
  }

  parameter {
    name  = "log_min_duration_statement"
    value = "1000"
  }

  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_stat_statements"
    apply_method = "pending-reboot"
  }

  parameter {
    name  = "track_io_timing"
    value = "on"
  }

  parameter {
    name  = "idle_in_transaction_session_timeout"
    value = "300000"
  }

  parameter {
    name  = "statement_timeout"
    value = "30000"
  }

  tags = var.tags

  lifecycle {
    create_before_destroy = true
  }
}

# ---- IAM role for enhanced monitoring ---------------------------------------

resource "aws_iam_role" "rds_enhanced_monitoring" {
  count = var.monitoring_interval_seconds > 0 ? 1 : 0

  name = "${var.name_prefix}-rds-enhanced-monitoring"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "monitoring.rds.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "rds_enhanced_monitoring" {
  count = var.monitoring_interval_seconds > 0 ? 1 : 0

  role       = aws_iam_role.rds_enhanced_monitoring[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

# ---- The instance -----------------------------------------------------------

resource "aws_db_instance" "this" {
  identifier     = "${var.name_prefix}-postgres"
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  username = var.master_username

  # Use AWS-managed master user password (stored in Secrets Manager).
  # This is preferred over passing a `password = ` value because
  # Terraform never sees the plaintext, and rotation is built-in.
  manage_master_user_password   = true
  master_user_secret_kms_key_id = var.kms_key_arn

  db_name              = var.database_name
  db_subnet_group_name = aws_db_subnet_group.this.name
  parameter_group_name = aws_db_parameter_group.this.name
  port                 = 5432

  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false

  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = var.kms_key_arn
  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_allocated_storage_gb

  multi_az            = var.multi_az
  deletion_protection = var.deletion_protection

  backup_retention_period = var.backup_retention_days
  backup_window           = var.backup_window
  maintenance_window      = var.maintenance_window
  copy_tags_to_snapshot   = true
  delete_automated_backups = false

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = var.kms_key_arn
  performance_insights_retention_period = var.performance_insights_retention_days

  monitoring_interval = var.monitoring_interval_seconds
  monitoring_role_arn = var.monitoring_interval_seconds > 0 ? aws_iam_role.rds_enhanced_monitoring[0].arn : null

  enabled_cloudwatch_logs_exports = var.enabled_cloudwatch_logs_exports

  auto_minor_version_upgrade = true
  apply_immediately          = false
  skip_final_snapshot        = false
  final_snapshot_identifier  = "${var.name_prefix}-postgres-final-${formatdate("YYYYMMDDhhmmss", timestamp())}"

  iam_database_authentication_enabled = true

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-postgres"
  })

  # `timestamp()` in final_snapshot_identifier means every plan would show
  # a diff. Ignore it so plans are stable.
  lifecycle {
    ignore_changes = [final_snapshot_identifier, master_user_secret_kms_key_id]
  }
}
