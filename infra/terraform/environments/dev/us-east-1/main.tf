# =============================================================================
# Pharmax — dev / us-east-1 entry point.
#
# This directory is its own Terraform working directory. It instantiates the
# stack composition at `../../../` once; everything else is configuration.
#
# To copy this for a new env-region:
#
#   1. cp -r environments/dev/us-east-1 environments/<env>/<region>
#   2. Edit `provider.tf` (the default region) and the .tfvars (region,
#      vpc_cidr, acm_certificate_domain, alarm_sns_topic_arn).
#   3. Edit `backend.tf` (state bucket region + key + lock table — see
#      `backend.tf.example`).
#   4. `terraform init && terraform plan -var-file=terraform.tfvars`.
# =============================================================================

module "stack" {
  source = "../../.."

  project     = var.project
  environment = var.environment
  region      = var.region
  tags        = var.tags

  vpc_cidr                     = var.vpc_cidr
  availability_zone_count      = var.availability_zone_count
  nat_gateway_strategy         = var.nat_gateway_strategy
  vpc_flow_logs_retention_days = var.vpc_flow_logs_retention_days

  acm_certificate_domain   = var.acm_certificate_domain
  alb_idle_timeout_seconds = var.alb_idle_timeout_seconds

  asymm_sign_key_spec = var.asymm_sign_key_spec

  rds_instance_class                      = var.rds_instance_class
  rds_allocated_storage_gb                = var.rds_allocated_storage_gb
  rds_max_allocated_storage_gb            = var.rds_max_allocated_storage_gb
  rds_backup_retention_days               = var.rds_backup_retention_days
  rds_engine_version                      = var.rds_engine_version
  rds_parameter_group_family              = var.rds_parameter_group_family
  rds_multi_az                            = var.rds_multi_az
  rds_deletion_protection                 = var.rds_deletion_protection
  rds_performance_insights_retention_days = var.rds_performance_insights_retention_days

  aurora_capacity_mode      = var.aurora_capacity_mode
  aurora_serverless_min_acu = var.aurora_serverless_min_acu
  aurora_serverless_max_acu = var.aurora_serverless_max_acu
  aurora_reader_count       = var.aurora_reader_count

  ecs_web_cpu                    = var.ecs_web_cpu
  ecs_web_memory                 = var.ecs_web_memory
  ecs_web_desired_count          = var.ecs_web_desired_count
  ecs_web_min_count              = var.ecs_web_min_count
  ecs_web_max_count              = var.ecs_web_max_count
  ecs_worker_cpu                 = var.ecs_worker_cpu
  ecs_worker_memory              = var.ecs_worker_memory
  ecs_worker_desired_count       = var.ecs_worker_desired_count
  ecs_print_agent_cpu            = var.ecs_print_agent_cpu
  ecs_print_agent_memory         = var.ecs_print_agent_memory
  ecs_print_agent_desired_count  = var.ecs_print_agent_desired_count
  ecs_log_retention_days         = var.ecs_log_retention_days
  ecs_container_insights_enabled = var.ecs_container_insights_enabled

  waf_rate_limit_per_5min = var.waf_rate_limit_per_5min
  alarm_sns_topic_arn     = var.alarm_sns_topic_arn

  audit_archive_retention_years         = var.audit_archive_retention_years
  audit_archive_glacier_transition_days = var.audit_archive_glacier_transition_days

  # CI/CD deploy role for .github/workflows/deploy.yml. dev owns the
  # account-level GitHub OIDC provider (cicd_create_oidc_provider = true)
  # since no other working directory in this account has created one yet.
  enable_cicd_deploy_role   = var.enable_cicd_deploy_role
  cicd_github_repository    = var.cicd_github_repository
  cicd_github_environment   = var.cicd_github_environment
  cicd_create_oidc_provider = var.cicd_create_oidc_provider
  cicd_oidc_provider_arn    = var.cicd_oidc_provider_arn
}
