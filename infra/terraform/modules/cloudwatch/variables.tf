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

variable "rds_instance_id" {
  description = "RDS instance id for dimension lookup."
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

variable "rds_storage_low_threshold_bytes" {
  description = <<-EOT
    Alarm if FreeStorageSpace drops below this many bytes. Default 20 GB.
    RDS storage autoscaling raises the ceiling, so an absolute floor is
    more honest than a percent-of-allocated comparison (the denominator
    moves out from under you). Tune to ~10-20% of typical allocated size.
  EOT
  type        = number
  default     = 21474836480
}

variable "rds_replica_lag_threshold_seconds" {
  description = "Replica lag alarm threshold."
  type        = number
  default     = 60
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
