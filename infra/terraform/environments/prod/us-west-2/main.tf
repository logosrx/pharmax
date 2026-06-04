# =============================================================================
# Pharmax — prod / us-west-2 entry point. DR region.
#
# This is the warm-standby region per ADR 0022's tenant-pinned-region model.
# Today no tenants are pinned here — the stack exists so the failover path
# (region-level KMS outage in us-east-1, regional service degradation, etc.)
# is rehearsable end-to-end. When a non-US tenant signs and is pinned here,
# the stack starts serving traffic without a fresh provisioning event.
#
# Operationally:
#   - State lives in a separate S3 bucket in us-west-2 (NOT in us-east-1) so
#     a us-east-1 outage does not also brick our DR Terraform.
#   - The KMS keys here are in us-west-2; cross-region key access does NOT
#     work, so signed Merkle manifests, envelope-encrypted PHI, and search
#     blind indexes from us-east-1 are NOT readable from this region. That
#     is by design — the failover path treats this region as a fresh
#     starting point for RPO=now data while the source region is offline.
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

  # AWS Shield Advanced (account-level subscription; protects this region's ALB).
  enable_shield_advanced = var.enable_shield_advanced

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

  # Aurora Global Database — this DR region joins the primary's global cluster
  # as a read-only secondary (managed promotion on failover). The two
  # identifiers come from the us-east-1 primary stack's outputs.
  rds_global_cluster_role           = var.rds_global_cluster_role
  rds_global_cluster_identifier     = var.rds_global_cluster_identifier
  rds_replication_source_identifier = var.rds_replication_source_identifier

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
