variable "name_prefix" {
  description = "Resource name prefix."
  type        = string
}

variable "aws_region" {
  description = "AWS region (dashboard uses it explicitly)."
  type        = string
}

variable "alarm_sns_topic_arn" {
  description = "SNS topic ARN to notify on alarm. Empty disables actions (the alarm still records to the metric)."
  type        = string
  default     = ""
}

variable "rds_cluster_id" {
  description = "Aurora cluster identifier (DBClusterIdentifier dimension) — used for cluster-level metrics like AuroraReplicaLag."
  type        = string
}

variable "rds_instance_id" {
  description = "Aurora writer instance id (DBInstanceIdentifier dimension) — used for per-instance metrics: CPU, connections, freeable memory."
  type        = string
}

variable "alb_arn_suffix" {
  description = "ALB arn_suffix (the part after `loadbalancer/`)."
  type        = string
}

variable "alb_target_group_web_arn_suffix" {
  description = "Web target group arn_suffix."
  type        = string
}

variable "ecs_cluster_name" {
  description = "ECS cluster name (Container Insights namespace)."
  type        = string
}

variable "ecs_service_web_name" {
  description = "Web service name."
  type        = string
}

variable "ecs_service_worker_name" {
  description = "Worker service name."
  type        = string
}

variable "ecs_service_print_agent_name" {
  description = "Print-agent service name."
  type        = string
}

variable "rds_cpu_threshold_percent" {
  description = "RDS CPU alarm threshold."
  type        = number
  default     = 80
}

variable "rds_freeable_memory_low_threshold_bytes" {
  description = <<-EOT
    Alarm if Aurora FreeableMemory on the writer drops below this many bytes.
    Aurora storage auto-scales (no FreeStorageSpace metric to watch), so memory
    pressure on the writer is the meaningful capacity signal. Default 1 GiB;
    tune relative to the instance class RAM (or ACU ceiling for serverless).
  EOT
  type        = number
  default     = 1073741824
}

variable "rds_replica_lag_threshold_ms" {
  description = "AuroraReplicaLag alarm threshold in milliseconds (Aurora reports replica lag in ms). Default 30000 (30s)."
  type        = number
  default     = 30000
}

variable "rds_connection_threshold" {
  description = "RDS connection count alarm threshold."
  type        = number
  default     = 200
}

variable "alb_5xx_threshold_percent" {
  description = "Alarm if 5xx rate > this percent of total requests."
  type        = number
  default     = 1
}

variable "alb_target_response_time_p99_seconds" {
  description = "Alarm if p99 target response time exceeds this."
  type        = number
  default     = 2
}

variable "tags" {
  description = "Tags applied to alarms."
  type        = map(string)
  default     = {}
}

variable "custom_metric_namespace" {
  description = "Namespace for app-emitted custom metrics (audit chain integrity)."
  type        = string
  default     = "Pharmax/Audit"
}

variable "audit_chain_failure_metric_name" {
  description = "Metric name the nightly verifyAuditChain job emits on failure."
  type        = string
  default     = "AuditChainIntegrityFailure"
}
