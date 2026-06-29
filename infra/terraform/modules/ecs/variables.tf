variable "name_prefix" {
  description = "Resource name prefix."
  type        = string
}

variable "aws_region" {
  description = "AWS region (passed to container log driver config)."
  type        = string
}

variable "vpc_id" {
  description = "VPC id."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnets that run the ECS tasks (egress via NAT)."
  type        = list(string)
}

variable "alb_target_group_web_arn" {
  description = "Target group the web service attaches to."
  type        = string
}

variable "alb_security_group_id" {
  description = "ALB security group id — only source allowed to reach web tasks."
  type        = string
}

variable "task_execution_role_arn" {
  description = "Shared execution role (fetches image + secrets)."
  type        = string
}

variable "task_role_web_arn" {
  description = "Web service task role."
  type        = string
}

variable "task_role_worker_arn" {
  description = "Worker service task role."
  type        = string
}

variable "task_role_print_agent_arn" {
  description = "Print-agent service task role."
  type        = string
}

variable "logs_kms_key_arn" {
  description = "CMK used to encrypt every ECS task log group."
  type        = string
}

variable "log_retention_days" {
  description = "Log group retention. Pass 14 (dev), 90 (staging), 365 (prod)."
  type        = number
}

variable "container_insights_enabled" {
  description = "Toggle ECS Container Insights."
  type        = bool
  default     = true
}

variable "ecr_web_repository_url" {
  description = "ECR url for the web image."
  type        = string
}

variable "ecr_worker_repository_url" {
  description = "ECR url for the worker image."
  type        = string
}

variable "ecr_print_agent_repository_url" {
  description = "ECR url for the print-agent image."
  type        = string
}

variable "ecr_web_image_tag" {
  description = "Image tag for the web task."
  type        = string
}

variable "ecr_worker_image_tag" {
  description = "Image tag for the worker task."
  type        = string
}

variable "ecr_print_agent_image_tag" {
  description = "Image tag for the print-agent task."
  type        = string
}

variable "secret_arns" {
  description = "Map of logical-name -> Secrets Manager ARN."
  type        = map(string)
}

variable "enable_reporting_replica" {
  description = <<-EOT
    When true, inject REPORTING_DATABASE_URL (the Aurora reader endpoint
    connection string) into the web and worker tasks so heavy report scans
    read from a replica instead of the writer. Only enable when a reader
    instance exists AND the `reporting-database-url` secret is populated —
    an empty value fails the app's URL validation at boot. When false, the
    env var is omitted and reports read the primary.
  EOT
  type        = bool
  default     = false
}

variable "data_kms_key_alias" {
  description = "Alias of the data CMK (PHI envelope encryption). Injected as AWS_KMS_DATA_KEY_ID + legacy AWS_KMS_APP_KEY_ID into every service container."
  type        = string
}

variable "search_kms_key_alias" {
  description = "Alias of the search CMK (HMAC blind-index). Injected as AWS_KMS_SEARCH_KEY_ID into web + worker containers."
  type        = string
}

variable "asymm_sign_kms_key_alias" {
  description = "Alias of the asymmetric Merkle-root signing CMK. Injected as MERKLE_SIGNER_KMS_KEY_ID into the worker container only (the name apps/worker/src/env.ts reads)."
  type        = string
}

variable "audit_archive_kms_key_alias" {
  description = "Alias of the audit-archive bucket SSE-KMS CMK. Injected as AUDIT_ARCHIVE_KMS_KEY_ID into the worker container."
  type        = string
}

variable "audit_archive_bucket_name" {
  description = "Bucket name for the Object-Lock audit archive. Injected as AUDIT_ARCHIVE_BUCKET into the worker container."
  type        = string
}

# ---- Web sizing ------------------------------------------------------------

variable "web_cpu" { type = number }
variable "web_memory" { type = number }
variable "web_desired_count" { type = number }
variable "web_min_count" { type = number }
variable "web_max_count" { type = number }
variable "web_container_port" {
  type    = number
  default = 3000
}

variable "web_health_check_path" {
  type    = string
  default = "/api/health"
}

variable "web_cpu_target_utilization_percent" {
  type    = number
  default = 60
}

# ---- Worker sizing ---------------------------------------------------------

variable "worker_cpu" { type = number }
variable "worker_memory" { type = number }
variable "worker_desired_count" { type = number }

# ---- Print-agent sizing ----------------------------------------------------

variable "print_agent_cpu" { type = number }
variable "print_agent_memory" { type = number }
variable "print_agent_desired_count" { type = number }

variable "web_support_email" {
  description = "Operator-facing support email injected as SUPPORT_EMAIL on the web task. Required by the web app's production boot guard. Empty = not injected (non-prod)."
  type        = string
  default     = ""
}

variable "web_app_url" {
  description = "Public base URL injected as APP_URL on the web task (e.g. https://app.pharmax.co). Empty = app falls back to its localhost default (non-prod only)."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags applied to every ECS resource."
  type        = map(string)
  default     = {}
}
