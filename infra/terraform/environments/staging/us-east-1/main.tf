# =============================================================================
# Pharmax — staging / us-east-1 entry point. See dev/us-east-1/main.tf for
# the canonical commentary; this is a sibling instantiation.
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
}
