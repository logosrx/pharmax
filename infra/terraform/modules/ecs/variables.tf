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

variable "otel_backend_enabled" {
  description = <<-EOT
    When true, inject OTEL_EXPORTER_OTLP_ENDPOINT (plain env var) and
    OTEL_EXPORTER_OTLP_HEADERS (from the `grafana-cloud-otlp-headers`
    secret) into the web and worker tasks so `@pharmax/telemetry` exports
    traces + metrics directly to the Grafana Cloud OTLP gateway. Only
    enable AFTER the secret holds a real
    `Authorization=Basic <base64(instanceId:token)>` value — the shipped
    placeholder merely 401s at the gateway (exporter logs + retries; the
    app keeps serving), but there is no reason to burn export batches on
    a stack that does not exist yet. When false, nothing is injected and
    telemetry keeps its localhost:4318 default (no backend; exporter
    no-ops against a closed port). Setup runbook:
    docs/observability/grafana-cloud-otel-backend.md.
  EOT
  type        = bool
  default     = false
}

variable "otel_exporter_otlp_endpoint" {
  description = <<-EOT
    OTLP/HTTP base URL injected as OTEL_EXPORTER_OTLP_ENDPOINT into web +
    worker when `otel_backend_enabled` is true. For Grafana Cloud this is
    the stack's REGION-SPECIFIC gateway,
    `https://otlp-gateway-<region>.grafana.net/otlp` — copy the exact URL
    from the stack's "OpenTelemetry → Configure" page; a wrong-region URL
    fails auth because tokens are stack-scoped.
  EOT
  type        = string

  validation {
    condition     = can(regex("^https://", var.otel_exporter_otlp_endpoint))
    error_message = "otel_exporter_otlp_endpoint must be a full https:// URL (the Grafana Cloud OTLP gateway base, ending in /otlp)."
  }
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

variable "package_photos_bucket_name" {
  description = "S3 bucket holding package-photo bytes (S3_PACKAGE_PHOTOS_BUCKET for web + worker). The web app's production boot guard requires it."
  type        = string
}

variable "package_photos_kms_key_alias" {
  description = "KMS CMK alias for SSE-KMS on package-photo objects (S3_PACKAGE_PHOTOS_KMS_KEY_ID; the documents CMK)."
  type        = string
}

variable "reports_bucket_name" {
  description = "Scheduled-report CSV archive bucket. Injected as REPORT_ARCHIVE_S3_BUCKET; without it the worker falls back to an in-memory archive that discards every report on restart (R-028)."
  type        = string
}

variable "reports_kms_key_alias" {
  description = "KMS alias for the reports bucket. Injected as REPORT_ARCHIVE_S3_KMS_KEY_ID. The S3 adapter is only selected when BOTH this and the bucket are set."
  type        = string
}

# --- Notifications -----------------------------------------------------
#
# Gated behind a flag that defaults OFF, deliberately.
#
# An ECS task definition referencing a Secrets Manager secret with no
# version fails to start with ResourceInitializationError — see the Clerk
# decommission note in this module and the placeholder comment in
# modules/secrets. Wiring RESEND_API_KEY unconditionally would therefore
# convert "notifications degrade to log-only" into "the worker does not
# boot", which is a strictly worse failure than the one being fixed.
#
# So: create the secret, leave it empty, and flip this to true once it is
# populated. Until then the worker keeps its in-memory channel and its
# existing boot warning.

variable "notifications_enabled" {
  description = "Inject the Resend notification channel into the worker. Requires the resend-api-key secret to be POPULATED first — an empty referenced secret fails task startup, not just notification delivery."
  type        = bool
  default     = false
}

variable "notification_from_email" {
  description = "From address for operational notifications (NOTIFICATION_FROM_EMAIL). Must be a verified Resend sender."
  type        = string
  default     = ""
}

variable "compliance_notify_recipient_email" {
  description = "Recipient for quarterly access-review notifications (COMPLIANCE_NOTIFY_RECIPIENT_EMAIL). Unset means an access review that finds something notifies nobody."
  type        = string
  default     = ""
}

variable "nightly_security_digest_recipient_email" {
  description = "Recipient for the nightly security digest (NIGHTLY_SECURITY_DIGEST_RECIPIENT_EMAIL). Unset means the digest is computed and discarded at INFO."
  type        = string
  default     = ""
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

variable "web_trusted_proxy_hop_count" {
  description = "Number of trusted reverse proxies in front of the web tier that append to X-Forwarded-For, injected as TRUSTED_PROXY_HOP_COUNT. Set to the real edge topology of this stack: CloudFront->ALB is 2, ALB-only is 1. Governs which XFF entry is trusted as the client IP for rate-limit keying; a client cannot influence entries at or right of the outermost trusted hop."
  type        = number
  default     = 1

  validation {
    condition     = var.web_trusted_proxy_hop_count >= 0 && var.web_trusted_proxy_hop_count <= 8
    error_message = "web_trusted_proxy_hop_count must be between 0 and 8."
  }
}

variable "tags" {
  description = "Tags applied to every ECS resource."
  type        = map(string)
  default     = {}
}
