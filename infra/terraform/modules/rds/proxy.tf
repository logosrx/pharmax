# =============================================================================
# RDS Proxy — managed connection pooler (OPT-IN, default OFF).
#
# Why: serverless / autoscaled compute (ECS web tasks) opening direct Postgres
# connections is the classic path to connection-pool exhaustion under load —
# the failure mode you want already mitigated BEFORE you hit it, not during an
# incident. RDS Proxy multiplexes many short-lived client connections onto a
# small warm pool to the cluster, and fails over transparently.
#
# This is wired but gated by `var.enable_rds_proxy` (default false) so it has
# ZERO effect on existing stacks until an operator opts in, plans, and then
# repoints DATABASE_URL's host at the proxy endpoint (output `proxy_endpoint`).
#
# Notes:
#   - Auth uses the AWS-managed master-user secret, so the proxy is only
#     available on a `standalone` cluster (manage_master_user_password = true).
#     A global-primary cluster uses an explicit password and would need a
#     separately-managed secret; that path is intentionally out of scope here.
#   - Our session tenancy GUCs are TRANSACTION-scoped (`set_config(..., true)`),
#     which is multiplexing-safe — they reset at COMMIT, so the proxy can reuse
#     the backend for another tenant without leaking context. The per-role
#     `options=-c role=...` startup param will pin a session to a backend
#     (expected, and harmless: app vs system roles use separate credentials).
# =============================================================================

locals {
  # Proxy auth needs the AWS-managed master-user secret, which only exists on
  # the standalone (managed-password) cluster.
  enable_proxy      = var.enable_rds_proxy && local.use_managed_password
  master_secret_arn = try(aws_rds_cluster.this.master_user_secret[0].secret_arn, null)
}

data "aws_region" "current" {}

# ---- IAM role: lets the proxy read the master-user secret -------------------

resource "aws_iam_role" "proxy" {
  count = local.enable_proxy ? 1 : 0

  name = "${var.name_prefix}-rds-proxy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "rds.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy" "proxy" {
  count = local.enable_proxy ? 1 : 0

  name = "${var.name_prefix}-rds-proxy-secret-access"
  role = aws_iam_role.proxy[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = [local.master_secret_arn]
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [var.kms_key_arn]
        Condition = {
          StringEquals = {
            "kms:ViaService" = "secretsmanager.${data.aws_region.current.name}.amazonaws.com"
          }
        }
      },
    ]
  })
}

# ---- Security group: clients -> proxy -> cluster ---------------------------

resource "aws_security_group" "proxy" {
  count = local.enable_proxy ? 1 : 0

  name        = "${var.name_prefix}-rds-proxy"
  description = "RDS Proxy ENIs - ingress from app SGs, egress to Aurora SG"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-rds-proxy"
  })
}

resource "aws_security_group_rule" "proxy_ingress_from_app" {
  count = local.enable_proxy ? length(var.ingress_security_group_ids) : 0

  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = var.ingress_security_group_ids[count.index]
  security_group_id        = aws_security_group.proxy[0].id
  description              = "Allow Postgres from app SG ${var.ingress_security_group_ids[count.index]}"
}

resource "aws_security_group_rule" "proxy_egress_to_db" {
  count = local.enable_proxy ? 1 : 0

  type                     = "egress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.rds.id
  security_group_id        = aws_security_group.proxy[0].id
  description              = "Proxy egress to Aurora SG"
}

# The cluster SG must also accept connections FROM the proxy SG.
resource "aws_security_group_rule" "rds_ingress_from_proxy" {
  count = local.enable_proxy ? 1 : 0

  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.proxy[0].id
  security_group_id        = aws_security_group.rds.id
  description              = "Allow Postgres from RDS Proxy SG"
}

# ---- The proxy + target group ----------------------------------------------

resource "aws_db_proxy" "this" {
  count = local.enable_proxy ? 1 : 0

  name                   = "${var.name_prefix}-aurora-proxy"
  engine_family          = "POSTGRESQL"
  role_arn               = aws_iam_role.proxy[0].arn
  vpc_subnet_ids         = var.isolated_subnet_ids
  vpc_security_group_ids = [aws_security_group.proxy[0].id]
  require_tls            = true
  idle_client_timeout    = var.proxy_idle_client_timeout_seconds
  debug_logging          = false

  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "DISABLED"
    secret_arn  = local.master_secret_arn
  }

  tags = var.tags
}

resource "aws_db_proxy_default_target_group" "this" {
  count = local.enable_proxy ? 1 : 0

  db_proxy_name = aws_db_proxy.this[0].name

  connection_pool_config {
    max_connections_percent      = var.proxy_max_connections_percent
    max_idle_connections_percent = var.proxy_max_idle_connections_percent
    connection_borrow_timeout    = 120
  }
}

resource "aws_db_proxy_target" "this" {
  count = local.enable_proxy ? 1 : 0

  db_cluster_identifier = aws_rds_cluster.this.cluster_identifier
  db_proxy_name         = aws_db_proxy.this[0].name
  target_group_name     = aws_db_proxy_default_target_group.this[0].name
}
