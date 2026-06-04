# =============================================================================
# Pharmax — prod / us-east-1 entry point. Primary region.
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

  # Aurora Global Database — this primary region owns the global cluster.
  rds_global_cluster_role = var.rds_global_cluster_role

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

  # Security baseline (CloudTrail / Config / GuardDuty / Security Hub).
  # us-east-1 primary stack owns these account/region singletons.
  enable_security_baseline               = var.enable_security_baseline
  security_enable_cloudtrail             = var.security_enable_cloudtrail
  security_enable_config                 = var.security_enable_config
  security_enable_config_rules           = var.security_enable_config_rules
  security_enable_guardduty              = var.security_enable_guardduty
  security_enable_securityhub            = var.security_enable_securityhub
  security_enable_securityhub_fsbp       = var.security_enable_securityhub_fsbp
  cloudtrail_log_retention_days          = var.cloudtrail_log_retention_days
  guardduty_finding_publishing_frequency = var.guardduty_finding_publishing_frequency

  # AWS Shield Advanced (account-level subscription; protects ALB + CloudFront).
  enable_shield_advanced = var.enable_shield_advanced

  # CloudFront edge (us-east-1 primary stack owns the global distribution).
  enable_cloudfront                    = var.enable_cloudfront
  cloudfront_origin_domain_name        = var.cloudfront_origin_domain_name
  cloudfront_aliases                   = var.cloudfront_aliases
  cloudfront_acm_certificate_arn       = var.cloudfront_acm_certificate_arn
  cloudfront_price_class               = var.cloudfront_price_class
  cloudfront_geo_restriction_type      = var.cloudfront_geo_restriction_type
  cloudfront_geo_restriction_locations = var.cloudfront_geo_restriction_locations

  # ElastiCache Redis (backs @pharmax/cache via REDIS_URL).
  enable_elasticache                  = var.enable_elasticache
  elasticache_node_type               = var.elasticache_node_type
  elasticache_engine_version          = var.elasticache_engine_version
  elasticache_parameter_group_family  = var.elasticache_parameter_group_family
  elasticache_replica_count           = var.elasticache_replica_count
  elasticache_multi_az                = var.elasticache_multi_az
  elasticache_at_rest_kms_key_arn     = var.elasticache_at_rest_kms_key_arn
  elasticache_maxmemory_policy        = var.elasticache_maxmemory_policy
  elasticache_snapshot_retention_days = var.elasticache_snapshot_retention_days

  # CI/CD deploy role (GitHub Actions OIDC). prod / us-east-1 is the primary
  # region and the designated owner of the account-level OIDC provider.
  enable_cicd_deploy_role    = var.enable_cicd_deploy_role
  cicd_github_repository     = var.cicd_github_repository
  cicd_github_environment    = var.cicd_github_environment
  cicd_github_subject_claims = var.cicd_github_subject_claims
  cicd_create_oidc_provider  = var.cicd_create_oidc_provider
  cicd_oidc_provider_arn     = var.cicd_oidc_provider_arn
}
