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
# KMS — nine customer-managed keys (rds, documents, audit_archive, secrets,
# data, search, asymm_sign, logs, alerts). Six of those are explicitly required
# by the brief; documents + logs round out the set, and alerts encrypts the SNS
# topics the alarms publish to.
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
# Database — Aurora PostgreSQL cluster (writer + optional readers), encrypted,
# isolated subnets. Capacity (serverless vs provisioned) and reader count are
# auto-derived from the environment unless explicitly overridden. See ADR 0029.
# -----------------------------------------------------------------------------

module "rds" {
  source = "./modules/rds"

  name_prefix                         = local.name_prefix
  vpc_id                              = module.network.vpc_id
  isolated_subnet_ids                 = module.network.isolated_subnet_ids
  ingress_security_group_ids          = [module.ecs.task_security_group_id]
  kms_key_arn                         = module.kms.rds_key_arn
  engine_version                      = var.rds_engine_version
  capacity_mode                       = local.aurora_capacity_mode
  instance_class                      = var.rds_instance_class
  serverless_min_acu                  = var.aurora_serverless_min_acu
  serverless_max_acu                  = var.aurora_serverless_max_acu
  reader_count                        = local.aurora_reader_count
  backup_retention_days               = var.rds_backup_retention_days
  deletion_protection                 = var.rds_deletion_protection
  master_username                     = var.rds_master_username
  database_name                       = var.rds_database_name
  performance_insights_retention_days = var.rds_performance_insights_retention_days

  # Aurora Global Database role + cross-region wiring. Standalone by default;
  # the primary stack creates the global cluster, the secondary stack joins it
  # with the primary's global id + cluster ARN (operator-supplied).
  global_cluster_role           = var.rds_global_cluster_role
  global_cluster_identifier     = var.rds_global_cluster_identifier
  replication_source_identifier = var.rds_replication_source_identifier

  # Connection pooler. Off by default; enabling it provisions an RDS Proxy in
  # front of the cluster (operator then repoints DATABASE_URL at the proxy
  # endpoint). See modules/rds/proxy.tf.
  enable_rds_proxy = var.rds_enable_proxy

  tags = local.phi_tags
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

# Package-photo bytes (dock-capture proof-of-condition shots). Same
# deletable-PHI bucket profile as documents (SSE-KMS, versioned,
# TLS-only, NO Object Lock — tenant-shred must be able to delete), same
# documents CMK (same PHI-image data class; avoids minting a CMK that
# the kms-inventory gate would require documenting separately). The
# app's production boot guard refuses to start without this bucket —
# in-memory photo storage loses captures across instances/redeploys.
module "s3_package_photos" {
  source = "./modules/s3-documents"

  name_prefix                = local.name_prefix
  purpose                    = "package-photos"
  kms_key_arn                = module.kms.documents_key_arn
  noncurrent_expiration_days = var.environment == "prod" ? 365 : 90
  tags                       = local.phi_tags
}

# -----------------------------------------------------------------------------
# IAM — least-privilege task roles per service, scoped to per-key ARNs.
# -----------------------------------------------------------------------------

module "iam" {
  source = "./modules/iam"

  name_prefix               = local.name_prefix
  aws_account_id            = data.aws_caller_identity.current.account_id
  region                    = var.region
  data_key_arn              = module.kms.data_key_arn
  search_key_arn            = module.kms.search_key_arn
  asymm_sign_key_arn        = module.kms.asymm_sign_key_arn
  audit_archive_key_arn     = module.kms.audit_archive_key_arn
  secrets_key_arn           = module.kms.secrets_key_arn
  logs_key_arn              = module.kms.logs_key_arn
  documents_key_arn         = module.kms.documents_key_arn
  documents_bucket_arn      = module.s3_documents.bucket_arn
  package_photos_bucket_arn = module.s3_package_photos.bucket_arn
  audit_archive_bucket_arn  = module.s3_audit_archive.bucket_arn
  secret_arns               = module.secrets.secret_arns
  tags                      = local.common_tags
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
  # Lock the ALB to the CloudFront edge when the distribution fronts it.
  restrict_ingress_to_cloudfront = var.enable_cloudfront
  enable_shield_advanced         = var.enable_shield_advanced
  tags                           = local.common_tags
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

  # Package-photo storage (apps/web boot guard requires both in prod;
  # the worker uses the bucket name for the orphan-object sweeper).
  package_photos_bucket_name   = module.s3_package_photos.bucket_name
  package_photos_kms_key_alias = module.kms.documents_key_alias

  # Inject REPORTING_DATABASE_URL (Aurora reader endpoint) only when a reader
  # instance exists; otherwise reports read the primary writer.
  enable_reporting_replica = local.reporting_replica_enabled

  # Grafana Cloud OTLP export (opt-in; off until the operator has created the
  # Grafana Cloud stack and populated the `grafana-cloud-otlp-headers` secret
  # — see docs/observability/grafana-cloud-otel-backend.md).
  otel_backend_enabled        = var.otel_backend_enabled
  otel_exporter_otlp_endpoint = var.otel_exporter_otlp_endpoint

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

  web_support_email = var.support_email
  web_app_url       = var.app_url

  # Trusted XFF hop count follows the edge topology of this stack: with
  # CloudFront in front of the ALB the client address is 2 hops away; an
  # ALB-only stack is 1. Derived from the same flag that provisions
  # CloudFront and locks the ALB to its prefix list, so the two can never
  # drift apart.
  web_trusted_proxy_hop_count = var.enable_cloudfront ? 2 : 1

  aws_region = var.region
  tags       = local.common_tags
}

# -----------------------------------------------------------------------------
# Security baseline — CloudTrail + AWS Config + GuardDuty + Security Hub.
# Optional (off by default). These are account+region singletons: enable in
# EXACTLY ONE stack per account+region (the primary). SOC 2 CC7.2/CC7.3/CC6.x.
# -----------------------------------------------------------------------------

module "security_baseline" {
  count  = var.enable_security_baseline ? 1 : 0
  source = "./modules/security-baseline"

  name_prefix = local.name_prefix

  enable_cloudtrail       = var.security_enable_cloudtrail
  enable_config           = var.security_enable_config
  enable_config_rules     = var.security_enable_config_rules
  enable_guardduty        = var.security_enable_guardduty
  enable_securityhub      = var.security_enable_securityhub
  securityhub_enable_fsbp = var.security_enable_securityhub_fsbp

  cloudtrail_log_retention_days          = var.cloudtrail_log_retention_days
  guardduty_finding_publishing_frequency = var.guardduty_finding_publishing_frequency

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# CloudFront — global edge CDN in front of the ALB. Optional (off by default);
# enable ONLY in the primary us-east-1 stack (CLOUDFRONT-scoped WAF + ACM must
# live in us-east-1). When enabled, the ALB SG is locked to the CloudFront
# origin-facing prefix list above.
# -----------------------------------------------------------------------------

module "cloudfront" {
  count  = var.enable_cloudfront ? 1 : 0
  source = "./modules/cloudfront"

  name_prefix = local.name_prefix
  # Defaults to the ALB DNS for convenience, but production MUST set a custom
  # origin domain covered by the ALB cert (see the module's variables.tf).
  origin_domain_name        = var.cloudfront_origin_domain_name != "" ? var.cloudfront_origin_domain_name : module.alb.alb_dns_name
  aliases                   = var.cloudfront_aliases
  acm_certificate_arn       = var.cloudfront_acm_certificate_arn
  price_class               = var.cloudfront_price_class
  rate_limit_per_5min       = var.waf_rate_limit_per_5min
  geo_restriction_type      = var.cloudfront_geo_restriction_type
  geo_restriction_locations = var.cloudfront_geo_restriction_locations

  enable_shield_advanced = var.enable_shield_advanced

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# ElastiCache — Redis replication group backing @pharmax/cache (REDIS_URL).
# Optional (off by default); private isolated subnets, TLS + AUTH, ingress
# only from the ECS task SG. See modules/elasticache for the REDIS_URL
# assembly note.
# -----------------------------------------------------------------------------

module "elasticache" {
  count  = var.enable_elasticache ? 1 : 0
  source = "./modules/elasticache"

  name_prefix                = local.name_prefix
  vpc_id                     = module.network.vpc_id
  subnet_ids                 = module.network.isolated_subnet_ids
  ingress_security_group_ids = [module.ecs.task_security_group_id]
  secrets_kms_key_arn        = module.kms.secrets_key_arn

  node_type               = var.elasticache_node_type
  engine_version          = var.elasticache_engine_version
  parameter_group_family  = var.elasticache_parameter_group_family
  replica_count           = var.elasticache_replica_count
  multi_az                = var.elasticache_multi_az
  at_rest_kms_key_arn     = var.elasticache_at_rest_kms_key_arn
  maxmemory_policy        = var.elasticache_maxmemory_policy
  snapshot_retention_days = var.elasticache_snapshot_retention_days

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# CI/CD deploy role — GitHub Actions OIDC role for the source → ECR → ECS
# pipeline. Optional (off by default); enable in one working directory per
# account. Scoped to push only the pharmax ECR repos and roll out only the
# pharmax ECS services. See .github/workflows/deploy.yml.
# -----------------------------------------------------------------------------

module "cicd_deploy" {
  count  = var.enable_cicd_deploy_role ? 1 : 0
  source = "./modules/cicd-deploy"

  name_prefix    = local.name_prefix
  aws_account_id = data.aws_caller_identity.current.account_id
  region         = var.region

  github_repository     = var.cicd_github_repository
  github_environment    = var.cicd_github_environment
  github_subject_claims = var.cicd_github_subject_claims
  create_oidc_provider  = var.cicd_create_oidc_provider
  oidc_provider_arn     = var.cicd_oidc_provider_arn

  ecr_repository_arns = values(module.ecr.repository_arns)
  passrole_role_arns = [
    module.iam.task_execution_role_arn,
    module.iam.task_role_web_arn,
    module.iam.task_role_worker_arn,
    module.iam.task_role_print_agent_arn,
  ]

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Terraform-apply role — GitHub Actions OIDC role for the approval-gated
# terraform-apply workflow (.github/workflows/terraform-apply.yml). Optional
# (off by default); enable in one working directory per account. Trust is
# exact-match scoped to the gated `terraform-apply-<env-region>` GitHub
# Environment subject claims, so the role is only assumable from a job that
# has passed required-reviewer approval.
#
# Chicken-and-egg: the FIRST apply in a virgin account is operator-driven
# (this role doesn't exist yet); enabling this module during that first
# apply creates the role so every subsequent apply can use the CI path.
# -----------------------------------------------------------------------------

module "terraform_apply_role" {
  count  = var.enable_terraform_apply_role ? 1 : 0
  source = "./modules/iam-github-oidc-apply"

  name_prefix    = local.name_prefix
  aws_account_id = data.aws_caller_identity.current.account_id

  github_repository   = var.tfapply_github_repository
  github_environments = var.tfapply_github_environments

  # Provider resolution: explicit ARN wins; otherwise re-use the provider the
  # cicd-deploy module owns in this working directory; otherwise create one
  # here (tfapply_create_oidc_provider = true).
  create_oidc_provider = var.tfapply_create_oidc_provider
  oidc_provider_arn = var.tfapply_oidc_provider_arn != "" ? var.tfapply_oidc_provider_arn : try(
    module.cicd_deploy[0].oidc_provider_arn, ""
  )

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Restore-drill preflight role — GitHub Actions OIDC role for the read-only
# preflight phase of the quarterly DR drill (.github/workflows/restore-drill.yml).
# Optional (off by default); enable in the working directory that owns the
# cluster the drill restores FROM (prod primary). Permissions are exactly
# rds:DescribeDBClusters on that cluster + kms:DescribeKey on its CMK — the
# destructive drill phases stay operator-driven.
# -----------------------------------------------------------------------------

module "restore_drill_role" {
  count  = var.enable_restore_drill_role ? 1 : 0
  source = "./modules/iam-github-oidc-drill"

  name_prefix = local.name_prefix

  github_repository = var.drill_github_repository
  github_ref        = var.drill_github_ref

  source_cluster_arns = [module.rds.cluster_arn]
  kms_key_arns        = [module.kms.rds_key_arn]

  # Same provider resolution as the apply role: explicit ARN wins, else re-use
  # the provider the cicd-deploy module owns in this working directory.
  create_oidc_provider = var.drill_create_oidc_provider
  oidc_provider_arn = var.drill_oidc_provider_arn != "" ? var.drill_oidc_provider_arn : try(
    module.cicd_deploy[0].oidc_provider_arn, ""
  )

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Alerting — the SNS topics alarms publish to (critical → page, warning →
# ticket). Optional so a dev stack can stay topic-free, but production must
# enable it: `scripts/check-alarm-actions.ts` fails the build if a prod
# env-region leaves `enable_alerting` off or leaves the cloudwatch module
# unwired. Subscription endpoints arrive as TF_VAR_* at apply time and are
# never committed — see the module's variables.tf.
# -----------------------------------------------------------------------------

module "alerting" {
  count  = var.enable_alerting ? 1 : 0
  source = "./modules/alerting"

  name_prefix    = local.name_prefix
  aws_account_id = data.aws_caller_identity.current.account_id
  aws_region     = var.region
  kms_key_arn    = module.kms.alerts_key_arn

  critical_email_subscriptions = var.alerting_critical_email_subscriptions
  warning_email_subscriptions  = var.alerting_warning_email_subscriptions
  critical_https_subscriptions = var.alerting_critical_https_subscriptions
  warning_https_subscriptions  = var.alerting_warning_https_subscriptions

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# CloudWatch — alarms + dashboard.
# -----------------------------------------------------------------------------

module "cloudwatch" {
  source = "./modules/cloudwatch"

  name_prefix = local.name_prefix
  aws_region  = var.region

  # `try(...)` covers the alerting-disabled case; the empty string is the
  # module's documented "evaluate but notify nobody" fallback, which is only
  # acceptable outside production.
  critical_alarm_sns_topic_arn = try(module.alerting[0].critical_topic_arn, "")
  warning_alarm_sns_topic_arn  = try(module.alerting[0].warning_topic_arn, "")
  alarm_sns_topic_arn          = var.alarm_sns_topic_arn

  # No tasks intended → no availability alarm, otherwise it fires forever and
  # trains the rotation to ignore the feed. See the resource comment in
  # modules/cloudwatch/main.tf for the scaling caveat.
  print_agent_running_alarm_enabled = var.ecs_print_agent_desired_count > 0

  rds_cluster_id                  = module.rds.cluster_id
  rds_instance_id                 = module.rds.writer_instance_id
  alb_arn_suffix                  = module.alb.alb_arn_suffix
  alb_target_group_web_arn_suffix = module.alb.target_group_web_arn_suffix
  ecs_cluster_name                = module.ecs.cluster_name
  ecs_service_web_name            = module.ecs.service_web_name
  ecs_service_worker_name         = module.ecs.service_worker_name
  ecs_service_print_agent_name    = module.ecs.service_print_agent_name

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Synthetics — outside-in heartbeat canary. Everything in `module "cloudwatch"`
# watches from inside AWS; the canary is the only monitor that sees the public
# ingress path (DNS, TLS, CloudFront, WAF, ALB) the way a user does. See
# modules/synthetics/README.md for scope and deliberate non-goals.
# -----------------------------------------------------------------------------

module "synthetics" {
  count  = var.enable_synthetics ? 1 : 0
  source = "./modules/synthetics"

  name_prefix = local.name_prefix

  # The module validates this is a full https:// URL, so enabling synthetics
  # without app_url set fails at plan time with an actionable message.
  heartbeat_url = "${var.app_url}/api/health"

  # Same severity-topic contract (and the same empty-string fallback
  # semantics) as `module "cloudwatch"` above.
  critical_alarm_sns_topic_arn = try(module.alerting[0].critical_topic_arn, "")
  warning_alarm_sns_topic_arn  = try(module.alerting[0].warning_topic_arn, "")
  alarm_sns_topic_arn          = var.alarm_sns_topic_arn

  tags = local.common_tags
}
