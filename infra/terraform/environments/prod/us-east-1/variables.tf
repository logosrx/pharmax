# Pass-through vars for the env-region working directory.

variable "project" {
  type    = string
  default = "pharmax"
}

variable "environment" {
  type    = string
  default = "prod"
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "tags" {
  type    = map(string)
  default = {}
}

variable "vpc_cidr" { type = string }
variable "availability_zone_count" { type = number }
variable "nat_gateway_strategy" { type = string }
variable "vpc_flow_logs_retention_days" { type = number }

variable "acm_certificate_domain" { type = string }
variable "alb_idle_timeout_seconds" { type = number }

variable "asymm_sign_key_spec" {
  type    = string
  default = "ECC_NIST_P384"
}

variable "rds_instance_class" { type = string }
variable "rds_allocated_storage_gb" { type = number }
variable "rds_max_allocated_storage_gb" { type = number }
variable "rds_backup_retention_days" { type = number }
variable "rds_engine_version" { type = string }
variable "rds_parameter_group_family" { type = string }
variable "rds_multi_az" { type = bool }
variable "rds_deletion_protection" { type = bool }
variable "rds_performance_insights_retention_days" { type = number }

# Aurora capacity. Leave at the sentinel defaults ("" / -1) to auto-derive
# from environment (prod=provisioned+1 reader, else serverless writer-only).
variable "aurora_capacity_mode" {
  type    = string
  default = ""
}
variable "aurora_serverless_min_acu" {
  type    = number
  default = 0.5
}
variable "aurora_serverless_max_acu" {
  type    = number
  default = 16
}
variable "aurora_reader_count" {
  type    = number
  default = -1
}

variable "rds_global_cluster_role" {
  type    = string
  default = "standalone"
}

variable "ecs_web_cpu" { type = number }
variable "ecs_web_memory" { type = number }
variable "ecs_web_desired_count" { type = number }
variable "ecs_web_min_count" { type = number }
variable "ecs_web_max_count" { type = number }
variable "ecs_worker_cpu" { type = number }
variable "ecs_worker_memory" { type = number }
variable "ecs_worker_desired_count" { type = number }
variable "ecs_print_agent_cpu" { type = number }
variable "ecs_print_agent_memory" { type = number }
variable "ecs_print_agent_desired_count" { type = number }
variable "ecs_log_retention_days" { type = number }
variable "ecs_container_insights_enabled" { type = bool }

variable "waf_rate_limit_per_5min" { type = number }
variable "alarm_sns_topic_arn" {
  type    = string
  default = ""
}

variable "audit_archive_retention_years" {
  type    = number
  default = 7
}
variable "audit_archive_glacier_transition_days" {
  type    = number
  default = 90
}

# ---- Security baseline ------------------------------------------------------

variable "enable_security_baseline" {
  type    = bool
  default = false
}
variable "security_enable_cloudtrail" {
  type    = bool
  default = true
}
variable "security_enable_config" {
  type    = bool
  default = true
}
variable "security_enable_config_rules" {
  type    = bool
  default = true
}
variable "security_enable_guardduty" {
  type    = bool
  default = true
}
variable "security_enable_securityhub" {
  type    = bool
  default = true
}
variable "security_enable_securityhub_fsbp" {
  type    = bool
  default = true
}
variable "cloudtrail_log_retention_days" {
  type    = number
  default = 2555
}
variable "guardduty_finding_publishing_frequency" {
  type    = string
  default = "SIX_HOURS"
}

# ---- App config -------------------------------------------------------------

variable "support_email" {
  type    = string
  default = ""
}
variable "app_url" {
  type    = string
  default = ""
}

# ---- Shield Advanced --------------------------------------------------------

variable "enable_shield_advanced" {
  type    = bool
  default = false
}

# ---- CloudFront -------------------------------------------------------------

variable "enable_cloudfront" {
  type    = bool
  default = false
}
variable "cloudfront_origin_domain_name" {
  type    = string
  default = ""
}
variable "cloudfront_aliases" {
  type    = list(string)
  default = []
}
variable "cloudfront_acm_certificate_arn" {
  type    = string
  default = ""
}
variable "cloudfront_price_class" {
  type    = string
  default = "PriceClass_100"
}
variable "cloudfront_geo_restriction_type" {
  type    = string
  default = "none"
}
variable "cloudfront_geo_restriction_locations" {
  type    = list(string)
  default = []
}

# ---- ElastiCache (Redis) ----------------------------------------------------

variable "enable_elasticache" {
  type    = bool
  default = false
}
variable "elasticache_node_type" {
  type    = string
  default = "cache.t4g.small"
}
variable "elasticache_engine_version" {
  type    = string
  default = "7.1"
}
variable "elasticache_parameter_group_family" {
  type    = string
  default = "redis7"
}
variable "elasticache_replica_count" {
  type    = number
  default = 1
}
variable "elasticache_multi_az" {
  type    = bool
  default = true
}
variable "elasticache_at_rest_kms_key_arn" {
  type    = string
  default = null
}
variable "elasticache_maxmemory_policy" {
  type    = string
  default = "allkeys-lru"
}
variable "elasticache_snapshot_retention_days" {
  type    = number
  default = 0
}

# ---- CI/CD deploy role (GitHub Actions OIDC) --------------------------------

variable "enable_cicd_deploy_role" {
  type    = bool
  default = false
}
variable "cicd_github_repository" {
  type    = string
  default = ""
}
variable "cicd_github_environment" {
  type    = string
  default = ""
}
variable "cicd_github_subject_claims" {
  type    = list(string)
  default = []
}
variable "cicd_create_oidc_provider" {
  type    = bool
  default = true
}
variable "cicd_oidc_provider_arn" {
  type    = string
  default = ""
}

# ---- Terraform-apply role (GitHub Actions OIDC) ------------------------------

variable "enable_terraform_apply_role" {
  type    = bool
  default = false
}
variable "tfapply_github_repository" {
  type    = string
  default = ""
}
variable "tfapply_github_environments" {
  type    = list(string)
  default = []
}
variable "tfapply_create_oidc_provider" {
  type    = bool
  default = false
}
variable "tfapply_oidc_provider_arn" {
  type    = string
  default = ""
}
