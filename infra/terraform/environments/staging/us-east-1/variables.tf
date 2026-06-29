# Pass-through vars for the env-region working directory.
# Mirrors the stack composition's variables.tf. Values come from terraform.tfvars.

variable "project" {
  type    = string
  default = "pharmax"
}

variable "environment" {
  type    = string
  default = "staging"
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
