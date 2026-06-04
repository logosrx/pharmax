# =============================================================================
# Database module — Amazon Aurora PostgreSQL-Compatible Edition.
#
# This module provisions the transactional source of truth (ADR 0003). It is
# named `rds` because Aurora is an Amazon RDS engine; the directory name is
# kept stable so compliance evidence references remain valid.
#
# Why Aurora PostgreSQL (not a single-instance RDS, not Aurora DSQL):
#   - 100% PostgreSQL-compatible, so the command-bus relies on the exact
#     primitives ADR 0003 / ADR 0007 require: `SELECT … FOR UPDATE`,
#     `FOR UPDATE SKIP LOCKED`, `pg_advisory_xact_lock`, RLS + `SET LOCAL`,
#     and foreign keys with `ON DELETE RESTRICT`. Aurora DSQL uses optimistic
#     concurrency with none of those, so it is disqualified (see ADR 0029).
#   - A REAL reader endpoint that powers `REPORTING_DATABASE_URL`
#     (packages/database/reporting-client.ts) so heavy report scans never
#     compete with live workflow transactions on the writer.
#   - 6-way storage replication across 3 AZs, ~30s failover, storage that
#     auto-scales to 128 TiB, and Aurora Global Database as the clean path
#     for the multi-region DR posture (ADR 0022).
#
# Capacity is selectable per environment:
#   - capacity_mode = "serverless"  → Aurora Serverless v2 (db.serverless),
#     scales between serverless_min_acu and serverless_max_acu. Best for
#     dev / staging (scales low when idle).
#   - capacity_mode = "provisioned" → fixed instance_class writer + readers.
#     Best for prod (predictable steady-state cost).
#
# Design choices (HIPAA / SOC 2 aware):
#   - Storage encryption with a customer-managed KMS key.
#   - TLS-only enforced via cluster parameter group (`rds.force_ssl = 1`).
#   - No public access. SG accepts 5432 ONLY from the ECS task SG.
#   - Performance Insights on (KMS-encrypted), Enhanced Monitoring on.
#   - Postgres logs exported to CloudWatch.
#   - copy_tags_to_snapshot so backup snapshots inherit the
#     `DataClassification = phi` tag — required for our backup-scan policy.
#   - manage_master_user_password → the master password lives in an
#     AWS-managed Secrets Manager secret; Terraform never sees plaintext.
# =============================================================================

locals {
  # Aurora cluster parameter-group family is derived from the engine major,
  # e.g. engine_version "16.4" → "aurora-postgresql16".
  engine_major         = split(".", var.engine_version)[0]
  cluster_param_family = "aurora-postgresql${local.engine_major}"
  is_serverless        = var.capacity_mode == "serverless"
  instance_class       = local.is_serverless ? "db.serverless" : var.instance_class

  # Aurora Global Database role.
  is_primary   = var.global_cluster_role == "primary"
  is_secondary = var.global_cluster_role == "secondary"

  # AWS forbids ManageMasterUserPassword on an Aurora GLOBAL database, so the
  # managed-secret path is used only for a standalone cluster. A global primary
  # gets an explicit generated password (exposed via the master_password
  # output); a secondary inherits credentials from the primary.
  use_managed_password = var.global_cluster_role == "standalone"

  # The global cluster id this cluster attaches to: created here for a
  # primary, supplied for a secondary, none for standalone. `one(...)` over
  # the splat is null-safe when the global cluster count is 0.
  effective_global_cluster_id = local.is_secondary ? var.global_cluster_identifier : one(aws_rds_global_cluster.this[*].id)
}

# ---- Aurora Global Database container (primary stack only) ------------------
#
# The global cluster is the cross-region container. The primary cluster (below)
# attaches to it; secondary clusters in other regions/stacks attach to the same
# id. Must be storage-encrypted for an encrypted global database.

# Explicit master password for a global PRIMARY (managed secret unsupported
# on global databases). Alphanumeric so it is URL-safe in DATABASE_URL.
resource "random_password" "master" {
  count   = local.is_primary ? 1 : 0
  length  = 32
  special = false
}

resource "aws_rds_global_cluster" "this" {
  count = local.is_primary ? 1 : 0

  global_cluster_identifier = "${var.name_prefix}-global"
  engine                    = "aurora-postgresql"
  engine_version            = var.engine_version
  storage_encrypted         = true

  # A console/auto minor-version bump must not fight Terraform; the primary
  # cluster and the global cluster track the same engine_version.
  lifecycle {
    ignore_changes = [engine_version]
  }
}

resource "aws_db_subnet_group" "this" {
  name       = "${var.name_prefix}-db"
  subnet_ids = var.isolated_subnet_ids

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-db-subnet-group"
  })
}

resource "aws_security_group" "rds" {
  name        = "${var.name_prefix}-aurora"
  description = "Aurora PostgreSQL SG - accepts 5432 only from the ECS task SG"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-aurora"
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

# ---- Cluster parameter group ------------------------------------------------
#
# Aurora PostgreSQL applies `rds.force_ssl`, logging, and the idle-/statement-
# timeout caps at the CLUSTER level. `pg_stat_statements` is already in the
# Aurora default `shared_preload_libraries`, so we do not re-declare it (doing
# so risks dropping other engine defaults).
#
# - rds.force_ssl = 1 → reject non-TLS connections at the engine
# - log_statement = ddl → record DDL but not data (no PHI in logs)
# - log_min_duration_statement = 1000 → log slow queries for tuning
# - log_connections / log_disconnections = 1 → audit who connects
# - track_io_timing = on → cheap perf data
# - idle_in_transaction_session_timeout caps abandoned txns that would hold
#   row locks (critical for the command-bus pattern)
# - statement_timeout matches our app-level Prisma timeouts

resource "aws_rds_cluster_parameter_group" "this" {
  name        = "${var.name_prefix}-aurora-pg"
  family      = local.cluster_param_family
  description = "Hardened Pharmax Aurora PostgreSQL cluster parameter group"

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

  name = "${var.name_prefix}-aurora-enhanced-monitoring"

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

# ---- The cluster ------------------------------------------------------------

resource "aws_rds_cluster" "this" {
  cluster_identifier = "${var.name_prefix}-aurora"
  engine             = "aurora-postgresql"
  engine_version     = var.engine_version
  engine_mode        = "provisioned" # required even for Serverless v2

  # A secondary cluster inherits the database + master credentials from the
  # primary via Global Database replication, so these MUST be null here.
  database_name   = local.is_secondary ? null : var.database_name
  master_username = local.is_secondary ? null : var.master_username

  # Master credential strategy:
  #   - standalone     → AWS-managed master password (Secrets Manager, rotated
  #                      by AWS; Terraform never sees the plaintext).
  #   - global primary → explicit generated password (AWS forbids the managed
  #                      secret on a global DB); exposed via master_password output.
  #   - global secondary → none (inherited from the primary via replication).
  manage_master_user_password   = local.use_managed_password ? true : null
  master_user_secret_kms_key_id = local.use_managed_password ? var.kms_key_arn : null
  master_password               = local.is_primary ? random_password.master[0].result : null

  # Global Database attachment. Standalone → null (unchanged). Primary →
  # the global cluster created above. Secondary → the supplied id, plus the
  # primary cluster ARN as the replication source.
  global_cluster_identifier     = local.effective_global_cluster_id
  replication_source_identifier = local.is_secondary ? var.replication_source_identifier : null

  db_subnet_group_name            = aws_db_subnet_group.this.name
  db_cluster_parameter_group_name = aws_rds_cluster_parameter_group.this.name
  vpc_security_group_ids          = [aws_security_group.rds.id]
  port                            = 5432

  storage_encrypted = true
  kms_key_id        = var.kms_key_arn

  backup_retention_period      = var.backup_retention_days
  preferred_backup_window      = var.backup_window
  preferred_maintenance_window = var.maintenance_window
  copy_tags_to_snapshot        = true

  deletion_protection                 = var.deletion_protection
  iam_database_authentication_enabled = true

  enabled_cloudwatch_logs_exports = var.enabled_cloudwatch_logs_exports

  # Serverless v2 scaling. Only consulted by `db.serverless` instances; for a
  # fully-provisioned cluster it is inert, so we always declare it.
  serverlessv2_scaling_configuration {
    min_capacity = var.serverless_min_acu
    max_capacity = var.serverless_max_acu
  }

  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name_prefix}-aurora-final-${formatdate("YYYYMMDDhhmmss", timestamp())}"

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-aurora"
  })

  # `timestamp()` would show a diff on every plan. `engine_version` is ignored
  # so a console-applied minor upgrade does not fight Terraform mid-incident.
  # `replication_source_identifier` is ignored because a promoted secondary
  # (managed failover) detaches from its source, and AWS rewrites the field
  # post-promotion — Terraform must not try to reattach it mid-incident.
  lifecycle {
    ignore_changes = [
      final_snapshot_identifier,
      master_user_secret_kms_key_id,
      engine_version,
      replication_source_identifier,
      master_password,
    ]
  }
}

# ---- Cluster instances (writer + optional readers) --------------------------
#
# The first instance (index 0) becomes the writer; the rest are readers that
# serve the reader endpoint (REPORTING_DATABASE_URL). `count` therefore is
# 1 + reader_count.

resource "aws_rds_cluster_instance" "this" {
  count = 1 + var.reader_count

  identifier         = "${var.name_prefix}-aurora-${count.index}"
  cluster_identifier = aws_rds_cluster.this.id
  instance_class     = local.instance_class
  engine             = aws_rds_cluster.this.engine
  engine_version     = aws_rds_cluster.this.engine_version

  db_subnet_group_name = aws_db_subnet_group.this.name
  publicly_accessible  = false

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = var.kms_key_arn
  performance_insights_retention_period = var.performance_insights_retention_days

  monitoring_interval = var.monitoring_interval_seconds
  monitoring_role_arn = var.monitoring_interval_seconds > 0 ? aws_iam_role.rds_enhanced_monitoring[0].arn : null

  auto_minor_version_upgrade = true
  apply_immediately          = false

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-aurora-${count.index}"
    Role = count.index == 0 ? "writer" : "reader"
  })

  lifecycle {
    ignore_changes = [engine_version]
  }
}
