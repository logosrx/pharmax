# =============================================================================
# Pharmax — root input variables.
#
# Every value that varies between dev / staging / prod / region lives here.
# Module inputs are derived from these so we never pass a raw region / account
# id down the tree. The .tfvars files under environments/<env>/<region>/
# supply the concrete values per env-region tuple.
# =============================================================================

# ---- Identity ---------------------------------------------------------------

variable "project" {
  description = "Project slug used to prefix every resource name. Keep lowercase + hyphens."
  type        = string
  default     = "pharmax"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.project))
    error_message = "project must be lowercase alphanumeric + hyphens, 2-31 chars, starting with a letter."
  }
}

variable "environment" {
  description = "Environment short name (dev, staging, prod). Drives sizing, retention, alarming."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "region" {
  description = "AWS region for ALL resources in this stack. One stack = one region."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]+$", var.region))
    error_message = "region must look like a real AWS region code, e.g. us-east-1."
  }
}

variable "tags" {
  description = "Extra tags applied to every resource (merged on top of computed defaults)."
  type        = map(string)
  default     = {}
}

# ---- Network ----------------------------------------------------------------

variable "vpc_cidr" {
  description = "Primary VPC CIDR block. Must be a /16 with enough room for N AZ x 3 tiers."
  type        = string
  default     = "10.40.0.0/16"
}

variable "availability_zone_count" {
  description = "Number of AZs to span (subnets are created in each)."
  type        = number
  default     = 3

  validation {
    condition     = var.availability_zone_count >= 2 && var.availability_zone_count <= 4
    error_message = "availability_zone_count must be between 2 and 4."
  }
}

variable "nat_gateway_strategy" {
  description = "single = one NAT (cheap, dev); per_az = one NAT per AZ (HA, prod)."
  type        = string
  default     = "per_az"

  validation {
    condition     = contains(["single", "per_az"], var.nat_gateway_strategy)
    error_message = "nat_gateway_strategy must be 'single' or 'per_az'."
  }
}

variable "vpc_flow_logs_retention_days" {
  description = "CloudWatch Logs retention for VPC flow logs."
  type        = number
  default     = 90
}

# ---- ALB / DNS --------------------------------------------------------------

variable "acm_certificate_domain" {
  description = "Domain name of the ACM certificate that the ALB HTTPS listener will use. The cert must already exist in this region; the ALB module looks it up via data block."
  type        = string
}

variable "alb_idle_timeout_seconds" {
  description = "ALB idle timeout. Keep below the longest streaming request (default 60s is fine for Next.js)."
  type        = number
  default     = 60
}

# ---- KMS --------------------------------------------------------------------

variable "asymm_sign_key_spec" {
  description = <<-EOT
    Spec for the asymmetric Merkle-root signing CMK. ECC_NIST_P384 is the
    default. Override only if a downstream verifier needs RSA.
  EOT
  type        = string
  default     = "ECC_NIST_P384"
}

# ---- RDS --------------------------------------------------------------------

variable "rds_instance_class" {
  description = "RDS instance class. Defaults are env-tuned in tfvars files."
  type        = string
}

variable "rds_allocated_storage_gb" {
  description = "Initial storage size in GB. Storage autoscaling is enabled to a higher max."
  type        = number
  default     = 100
}

variable "rds_max_allocated_storage_gb" {
  description = "Cap for storage autoscaling. Prevents runaway disk costs."
  type        = number
  default     = 1000
}

variable "rds_backup_retention_days" {
  description = "Automated backup retention. HIPAA-aware default of 35 (max for RDS). Must remain >= 35 for prod."
  type        = number
  default     = 35

  validation {
    condition     = var.rds_backup_retention_days >= 7 && var.rds_backup_retention_days <= 35
    error_message = "rds_backup_retention_days must be between 7 and 35 (RDS max)."
  }
}

variable "rds_engine_version" {
  description = "PostgreSQL engine version. We pin to a known-good 16.x minor."
  type        = string
  default     = "16.4"
}

variable "rds_parameter_group_family" {
  description = "RDS parameter group family. Must match the engine major (postgres16)."
  type        = string
  default     = "postgres16"
}

variable "rds_multi_az" {
  description = "Multi-AZ standby. Required for prod."
  type        = bool
  default     = true
}

variable "rds_deletion_protection" {
  description = "Block accidental terraform destroy. Required true for prod and staging."
  type        = bool
  default     = true
}

variable "rds_master_username" {
  description = "RDS master username. Password is generated and stored in Secrets Manager."
  type        = string
  default     = "pharmax_admin"
}

variable "rds_database_name" {
  description = "Initial database name created on RDS."
  type        = string
  default     = "pharmax"
}

variable "rds_performance_insights_retention_days" {
  description = "Performance Insights retention in days (7 = free tier, 731 = paid long-term)."
  type        = number
  default     = 7
}

# ---- ECS --------------------------------------------------------------------

variable "ecs_web_cpu" {
  description = "Fargate CPU units for the web task (256 = .25 vCPU, 1024 = 1 vCPU)."
  type        = number
  default     = 1024
}

variable "ecs_web_memory" {
  description = "Fargate memory MiB for the web task."
  type        = number
  default     = 2048
}

variable "ecs_web_desired_count" {
  description = "Initial web task count. Auto-scaling will move within min/max."
  type        = number
  default     = 2
}

variable "ecs_web_min_count" {
  description = "Auto-scaling floor for web."
  type        = number
  default     = 2
}

variable "ecs_web_max_count" {
  description = "Auto-scaling ceiling for web."
  type        = number
  default     = 10
}

variable "ecs_worker_cpu" {
  description = "Fargate CPU units for the worker task."
  type        = number
  default     = 1024
}

variable "ecs_worker_memory" {
  description = "Fargate memory MiB for the worker task."
  type        = number
  default     = 2048
}

variable "ecs_worker_desired_count" {
  description = "Worker task count. Fixed (no autoscaling) — the worker is a polling drain."
  type        = number
  default     = 2
}

variable "ecs_print_agent_cpu" {
  description = "Fargate CPU units for the print-agent task."
  type        = number
  default     = 512
}

variable "ecs_print_agent_memory" {
  description = "Fargate memory MiB for the print-agent task."
  type        = number
  default     = 1024
}

variable "ecs_print_agent_desired_count" {
  description = "Print-agent task count. Typically 1 per pharmacy site, parameterized."
  type        = number
  default     = 1
}

variable "ecs_log_retention_days" {
  description = "CloudWatch Logs retention for ECS task logs."
  type        = number
}

variable "ecs_container_insights_enabled" {
  description = "Enable ECS Container Insights (recommended; costs ~$2/cluster/month per metric)."
  type        = bool
  default     = true
}

variable "ecs_web_image_tag" {
  description = "Image tag for the web task. CD pipeline updates this on deploy."
  type        = string
  default     = "latest"
}

variable "ecs_worker_image_tag" {
  description = "Image tag for the worker task."
  type        = string
  default     = "latest"
}

variable "ecs_print_agent_image_tag" {
  description = "Image tag for the print-agent task."
  type        = string
  default     = "latest"
}

# ---- WAF --------------------------------------------------------------------

variable "waf_rate_limit_per_5min" {
  description = "Per-IP rate limit for the rate-based rule (requests per 5-minute window)."
  type        = number
  default     = 2000
}

# ---- Alarms / SNS -----------------------------------------------------------

variable "alarm_sns_topic_arn" {
  description = "ARN of an existing SNS topic to receive CloudWatch alarms. Empty disables actions (alarm still fires)."
  type        = string
  default     = ""
}

# ---- Secrets ----------------------------------------------------------------

variable "secret_values" {
  description = <<-EOT
    Initial values for app secrets. Each entry creates a Secrets Manager secret
    with the given value. Pass {} (the default) to create empty secrets that an
    operator rotates manually after the first apply — this is recommended so
    secret material does not live in .tfvars at all.
  EOT
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "secret_rotation_lambda_arns" {
  description = <<-EOT
    Optional map of logical-secret-name -> rotation lambda ARN. Wires
    Secrets Manager rotation to the named lambda. Until the lambda is
    deployed, leave this empty and rotate via the runbook.
  EOT
  type        = map(string)
  default     = {}
}

variable "secret_rotation_interval_days" {
  description = "Days between automatic rotation invocations for any secret with a lambda wired."
  type        = number
  default     = 90
}

# ---- Audit archive ----------------------------------------------------------

variable "audit_archive_retention_years" {
  description = "Default Object Lock COMPLIANCE retention on the audit archive bucket. HIPAA-aware default 7."
  type        = number
  default     = 7

  validation {
    condition     = var.audit_archive_retention_years >= 6
    error_message = "audit_archive_retention_years must be at least 6 (HIPAA minimum)."
  }
}

variable "audit_archive_glacier_transition_days" {
  description = "Days after which audit archive objects transition to Glacier Deep Archive. Cannot be 0."
  type        = number
  default     = 90
}
