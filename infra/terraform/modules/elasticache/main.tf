# =============================================================================
# ElastiCache module — Redis (cluster-mode-disabled replication group).
#
# Backs `@pharmax/cache` (REDIS_URL). Cross-request cache for near-immutable,
# expensive-to-resolve values (identity mapping, permission sets). It is a
# PERFORMANCE shortcut only — correctness always traces to Postgres — so the
# data here is non-PHI by construction.
#
# Design choices (HIPAA / SOC 2 aware):
#   - In a private VPC: isolated subnets, no public access.
#   - SG accepts 6379 ONLY from the ECS task SG.
#   - Encryption in transit (TLS) + at rest. Transit encryption requires an
#     AUTH token, which we generate and store in Secrets Manager (encrypted
#     with the secrets CMK) so it never lives in plaintext .tfvars.
#   - maxmemory-policy = allkeys-lru: every cache entry already carries a TTL
#     (see @pharmax/cache), so evicting the least-recently-used key under
#     memory pressure is the correct cache behaviour.
#
# Assembling REDIS_URL (mirrors the RDS "Assembling DATABASE_URL" pattern):
#   The app consumes a single `rediss://` URL via the `redis-url` Secrets
#   Manager secret that ECS already injects. After apply, assemble it from
#   this module's outputs + the generated auth token:
#
#     rediss://:<auth_token>@<primary_endpoint_address>:<port>
#
#   and store it in the `redis-url` app secret. The auth token is in the
#   `*-redis-auth-token` secret created here. Keeping the URL in the existing
#   app secret means zero changes to the ECS/IAM/secrets wiring.
# =============================================================================

resource "aws_elasticache_subnet_group" "this" {
  name       = "${var.name_prefix}-redis"
  subnet_ids = var.subnet_ids

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-redis-subnet-group"
  })
}

resource "aws_security_group" "this" {
  name        = "${var.name_prefix}-redis"
  description = "Redis SG - accepts 6379 only from the ECS task SG"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-redis"
  })
}

resource "aws_security_group_rule" "ingress_from_app" {
  count = length(var.ingress_security_group_ids)

  type                     = "ingress"
  from_port                = 6379
  to_port                  = 6379
  protocol                 = "tcp"
  source_security_group_id = var.ingress_security_group_ids[count.index]
  security_group_id        = aws_security_group.this.id
  description              = "Allow Redis from app SG ${var.ingress_security_group_ids[count.index]}"
}

resource "aws_elasticache_parameter_group" "this" {
  name        = "${var.name_prefix}-redis-params"
  family      = var.parameter_group_family
  description = "Pharmax Redis parameter group (${var.name_prefix})"

  parameter {
    name  = "maxmemory-policy"
    value = var.maxmemory_policy
  }

  lifecycle {
    create_before_destroy = true
  }
}

# ---- AUTH token -------------------------------------------------------------
# Transit encryption requires an AUTH token. Generated here (alphanumeric so
# it is URL-safe inside the rediss:// connection string) and stored in Secrets
# Manager encrypted with the secrets CMK. Terraform state holds it (sensitive);
# rotate via the runbook + `terraform apply -replace` of the random_password.

resource "random_password" "auth_token" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "auth_token" {
  name                    = "${var.name_prefix}-redis-auth-token"
  description             = "ElastiCache Redis AUTH token. Used to assemble REDIS_URL."
  kms_key_id              = var.secrets_kms_key_arn
  recovery_window_in_days = var.secret_recovery_in_days

  tags = var.tags
}

resource "aws_secretsmanager_secret_version" "auth_token" {
  secret_id     = aws_secretsmanager_secret.auth_token.id
  secret_string = random_password.auth_token.result
}

# ---- Replication group ------------------------------------------------------

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = "${var.name_prefix}-redis"
  description          = "Pharmax Redis cache (${var.name_prefix})"

  engine         = "redis"
  engine_version = var.engine_version
  node_type      = var.node_type
  port           = 6379

  parameter_group_name = aws_elasticache_parameter_group.this.name
  subnet_group_name    = aws_elasticache_subnet_group.this.name
  security_group_ids   = [aws_security_group.this.id]

  # One primary + N read replicas. Multi-AZ + automatic failover require at
  # least one replica, so both are gated on replica_count > 0.
  num_cache_clusters         = 1 + var.replica_count
  automatic_failover_enabled = var.replica_count > 0
  multi_az_enabled           = var.multi_az && var.replica_count > 0

  at_rest_encryption_enabled = true
  # null → AWS-managed key. Pass a CMK ARN to use a customer-managed key.
  kms_key_id                 = var.at_rest_kms_key_arn
  transit_encryption_enabled = true
  auth_token                 = random_password.auth_token.result

  snapshot_retention_limit   = var.snapshot_retention_days
  maintenance_window         = var.maintenance_window
  apply_immediately          = var.apply_immediately
  auto_minor_version_upgrade = true

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-redis"
  })

  # Minor-version upgrades applied out-of-band must not fight Terraform; the
  # auth token rotates via an explicit -replace of random_password.auth_token.
  lifecycle {
    ignore_changes = [engine_version, auth_token]
  }
}
