# =============================================================================
# Pharmax — root composition.
#
# This is the per-environment per-region stack. It is intended to be either:
#
#   1. **Used directly** — `terraform init && terraform apply -var-file=...`
#      from this directory, with `backend.tf` linked from the chosen
#      env-region directory and `provider "aws"` declared in `provider.tf`.
#
#   2. **Called as a module** — every env-region directory under
#      `environments/<env>/<region>/` declares its own `provider "aws"`,
#      `terraform { backend "s3" {} }`, and instantiates this composition
#      via `module "stack" { source = "../../../" ... }`. This is the
#      pattern used in production: each (env, region) tuple has its own
#      Terraform working directory with its own remote state.
#
# Module instantiation order follows the dependency DAG:
#
#   network ─┬─> rds (isolated subnets)
#            ├─> alb (public subnets) ─> ecs (private subnets) ─> cloudwatch
#            └─> waf (associated with alb)
#   kms     ─┬─> rds (storage encryption)
#            ├─> secrets (secret encryption)
#            ├─> s3-audit-archive (dedicated audit-archive CMK)
#            ├─> s3-documents (documents CMK)
#            └─> ecs (logs CMK + data/search/asymm-sign env injection)
#   ecr      (independent)
#   iam     ─> ecs
#
# Every module receives `local.common_tags` so the operator can audit
# "what does X cost" at the resource-group level. The HIPAA / SOC 2
# critical resources also pick up `local.phi_tags` (Data Classification + HIPAA
# scope).
#
# Reference: ADR 0023 (KMS adapter), ADR 0024 (Merkle signing + Object Lock),
# ADR 0025 (Clerk webhook secret).
# =============================================================================

# Provider declaration lives in `provider.tf` (when run directly) or in the
# caller (when invoked as a module). We DO NOT declare a `provider` block
# here — that would force every caller to re-declare it.

# Discover the current account id without hardcoding it. Used by IAM and
# resource policies that need an explicit principal.
data "aws_caller_identity" "current" {}

# -----------------------------------------------------------------------------
# Network — VPC + public/private/isolated subnets across N AZs + NAT + flow logs.
# -----------------------------------------------------------------------------

module "network" {
  source = "./modules/network"

  name_prefix              = local.name_prefix
  vpc_cidr                 = var.vpc_cidr
  availability_zone_count  = var.availability_zone_count
  nat_gateway_strategy     = var.nat_gateway_strategy
  flow_logs_retention_days = var.vpc_flow_logs_retention_days
  flow_logs_kms_key_arn    = module.kms.logs_key_arn
  tags                     = local.common_tags
}

# -----------------------------------------------------------------------------
# KMS — eight customer-managed keys (rds, documents, audit_archive, secrets,
# data, search, asymm_sign, logs). Six of those are explicitly required by
# the brief; documents + logs round out the set.
# -----------------------------------------------------------------------------

module "kms" {
  source = "./modules/kms"

  name_prefix         = local.name_prefix
  aws_account_id      = data.aws_caller_identity.current.account_id
  asymm_sign_key_spec = var.asymm_sign_key_spec
  tags                = local.common_tags
}

# -----------------------------------------------------------------------------
# Secrets Manager — one entry per logical app secret, encrypted with the
# secrets CMK. Rotation lambdas are wireable via `var.rotation_lambda_arns`.
# -----------------------------------------------------------------------------

module "secrets" {
  source = "./modules/secrets"

  name_prefix            = local.name_prefix
  kms_key_arn            = module.kms.secrets_key_arn
  initial_values         = var.secret_values
  recovery_in_days       = var.environment == "prod" ? 30 : 7
  rotation_lambda_arns   = var.secret_rotation_lambda_arns
  rotation_interval_days = var.secret_rotation_interval_days
  tags                   = local.common_tags
}

# -----------------------------------------------------------------------------
# ECR — container registries with lifecycle policies (web, worker, print-agent).
# -----------------------------------------------------------------------------

module "ecr" {
  source = "./modules/ecr"

  name_prefix = local.name_prefix
  tags        = local.common_tags
}

# -----------------------------------------------------------------------------
# RDS — Postgres 16 Multi-AZ, encrypted, isolated subnets.
# -----------------------------------------------------------------------------

module "rds" {
  source = "./modules/rds"

  name_prefix                         = local.name_prefix
  vpc_id                              = module.network.vpc_id
  isolated_subnet_ids                 = module.network.isolated_subnet_ids
  ingress_security_group_ids          = [module.ecs.task_security_group_id]
  kms_key_arn                         = module.kms.rds_key_arn
  engine_version                      = var.rds_engine_version
  parameter_group_family              = var.rds_parameter_group_family
  instance_class                      = var.rds_instance_class
  allocated_storage_gb                = var.rds_allocated_storage_gb
  max_allocated_storage_gb            = var.rds_max_allocated_storage_gb
  backup_retention_days               = var.rds_backup_retention_days
  multi_az                            = var.rds_multi_az
  deletion_protection                 = var.rds_deletion_protection
  master_username                     = var.rds_master_username
  database_name                       = var.rds_database_name
  performance_insights_retention_days = var.rds_performance_insights_retention_days
  tags                                = local.phi_tags
}

# -----------------------------------------------------------------------------
# S3 — audit archive (Object Lock COMPLIANCE, dedicated CMK) + documents.
# -----------------------------------------------------------------------------

module "s3_audit_archive" {
  source = "./modules/s3-audit-archive"

  name_prefix             = local.name_prefix
  kms_key_arn             = module.kms.audit_archive_key_arn
  retention_years         = var.audit_archive_retention_years
  glacier_transition_days = var.audit_archive_glacier_transition_days
  tags                    = local.phi_tags
}

module "s3_documents" {
  source = "./modules/s3-documents"

  name_prefix                = local.name_prefix
  kms_key_arn                = module.kms.documents_key_arn
  noncurrent_expiration_days = var.environment == "prod" ? 365 : 90
  tags                       = local.phi_tags
}

# -----------------------------------------------------------------------------
# IAM — least-privilege task roles per service, scoped to per-key ARNs.
# -----------------------------------------------------------------------------

module "iam" {
  source = "./modules/iam"

  name_prefix              = local.name_prefix
  aws_account_id           = data.aws_caller_identity.current.account_id
  region                   = var.region
  data_key_arn             = module.kms.data_key_arn
  search_key_arn           = module.kms.search_key_arn
  asymm_sign_key_arn       = module.kms.asymm_sign_key_arn
  audit_archive_key_arn    = module.kms.audit_archive_key_arn
  secrets_key_arn          = module.kms.secrets_key_arn
  logs_key_arn             = module.kms.logs_key_arn
  documents_bucket_arn     = module.s3_documents.bucket_arn
  audit_archive_bucket_arn = module.s3_audit_archive.bucket_arn
  secret_arns              = module.secrets.secret_arns
  tags                     = local.common_tags
}

# -----------------------------------------------------------------------------
# ALB — Application Load Balancer, HTTPS listener, target groups.
# -----------------------------------------------------------------------------

module "alb" {
  source = "./modules/alb"

  name_prefix                = local.name_prefix
  vpc_id                     = module.network.vpc_id
  public_subnet_ids          = module.network.public_subnet_ids
  acm_certificate_domain     = var.acm_certificate_domain
  idle_timeout_seconds       = var.alb_idle_timeout_seconds
  enable_deletion_protection = var.environment != "dev"
  tags                       = local.common_tags
}

# -----------------------------------------------------------------------------
# WAFv2 — managed rule groups + rate limit, attached to the ALB.
# -----------------------------------------------------------------------------

module "waf" {
  source = "./modules/waf"

  name_prefix         = local.name_prefix
  alb_arn             = module.alb.alb_arn
  rate_limit_per_5min = var.waf_rate_limit_per_5min
  tags                = local.common_tags
}

# -----------------------------------------------------------------------------
# ECS — Fargate cluster + web/worker/print-agent services.
# -----------------------------------------------------------------------------

module "ecs" {
  source = "./modules/ecs"

  name_prefix                    = local.name_prefix
  vpc_id                         = module.network.vpc_id
  private_subnet_ids             = module.network.private_subnet_ids
  alb_target_group_web_arn       = module.alb.target_group_web_arn
  alb_security_group_id          = module.alb.security_group_id
  task_execution_role_arn        = module.iam.task_execution_role_arn
  task_role_web_arn              = module.iam.task_role_web_arn
  task_role_worker_arn           = module.iam.task_role_worker_arn
  task_role_print_agent_arn      = module.iam.task_role_print_agent_arn
  logs_kms_key_arn               = module.kms.logs_key_arn
  log_retention_days             = var.ecs_log_retention_days
  container_insights_enabled     = var.ecs_container_insights_enabled
  ecr_web_repository_url         = module.ecr.web_repository_url
  ecr_worker_repository_url      = module.ecr.worker_repository_url
  ecr_print_agent_repository_url = module.ecr.print_agent_repository_url
  ecr_web_image_tag              = var.ecs_web_image_tag
  ecr_worker_image_tag           = var.ecs_worker_image_tag
  ecr_print_agent_image_tag      = var.ecs_print_agent_image_tag
  secret_arns                    = module.secrets.secret_arns

  data_kms_key_alias          = module.kms.data_key_alias
  search_kms_key_alias        = module.kms.search_key_alias
  asymm_sign_kms_key_alias    = module.kms.asymm_sign_key_alias
  audit_archive_kms_key_alias = module.kms.audit_archive_key_alias
  audit_archive_bucket_name   = module.s3_audit_archive.bucket_name

  web_cpu           = var.ecs_web_cpu
  web_memory        = var.ecs_web_memory
  web_desired_count = var.ecs_web_desired_count
  web_min_count     = var.ecs_web_min_count
  web_max_count     = var.ecs_web_max_count

  worker_cpu           = var.ecs_worker_cpu
  worker_memory        = var.ecs_worker_memory
  worker_desired_count = var.ecs_worker_desired_count

  print_agent_cpu           = var.ecs_print_agent_cpu
  print_agent_memory        = var.ecs_print_agent_memory
  print_agent_desired_count = var.ecs_print_agent_desired_count

  aws_region = var.region
  tags       = local.common_tags
}

# -----------------------------------------------------------------------------
# CloudWatch — alarms + dashboard.
# -----------------------------------------------------------------------------

module "cloudwatch" {
  source = "./modules/cloudwatch"

  name_prefix         = local.name_prefix
  aws_region          = var.region
  alarm_sns_topic_arn = var.alarm_sns_topic_arn

  rds_instance_id                 = module.rds.instance_id
  alb_arn_suffix                  = module.alb.alb_arn_suffix
  alb_target_group_web_arn_suffix = module.alb.target_group_web_arn_suffix
  ecs_cluster_name                = module.ecs.cluster_name
  ecs_service_web_name            = module.ecs.service_web_name
  ecs_service_worker_name         = module.ecs.service_worker_name
  ecs_service_print_agent_name    = module.ecs.service_print_agent_name

  tags = local.common_tags
}
