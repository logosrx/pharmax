variable "name_prefix" {
  description = "Resource name prefix."
  type        = string
}

variable "aws_region" {
  description = "AWS region (dashboard uses it explicitly)."
  type        = string
}

variable "critical_alarm_sns_topic_arn" {
  description = <<-EOT
    SNS topic ARN for alarms that page a human — `module.alerting.critical_topic_arn`.
    Empty falls back to `alarm_sns_topic_arn`, and if that is empty too the alarm
    evaluates but notifies nobody. Production MUST set this;
    `pnpm check:alarm-actions` enforces the wiring.
  EOT
  type        = string
  default     = ""
}

variable "warning_alarm_sns_topic_arn" {
  description = <<-EOT
    SNS topic ARN for alarms that file a ticket / land in the shift mailbox —
    `module.alerting.warning_topic_arn`. Same empty-string fallback as the critical
    topic.
  EOT
  type        = string
  default     = ""
}

variable "alarm_sns_topic_arn" {
  description = <<-EOT
    LEGACY single-topic ARN, used as the fallback for both severities when the
    per-severity ARNs above are empty. Retained so a non-prod stack that already
    sets one topic keeps working, and so "empty means no action" stays the dev
    default. New wiring should set the per-severity variables instead: routing
    every alarm to one topic is what makes a pager ignorable.
  EOT
  type        = string
  default     = ""
}

variable "print_agent_running_alarm_enabled" {
  description = <<-EOT
    Whether to create the print-agent availability alarm. Set false when the stack
    intends the print agent to run zero tasks (prod today: no physical pharmacy site
    yet, `ecs_print_agent_desired_count = 0`) — otherwise the alarm is permanently in
    ALARM and trains everyone to ignore the feed. The root composition derives this
    from the desired count.
  EOT
  type        = bool
  default     = true
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

variable "worker_metric_namespace" {
  description = <<-EOT
    Namespace for worker-emitted operational metrics (outbox backlog probe).
    Mirrors WORKER_METRIC_NAMESPACE in apps/worker/src/metrics/outbox-backlog-probe.ts
    — change both together or the outbox alarms watch an empty namespace.
  EOT
  type        = string
  default     = "Pharmax/Worker"
}

variable "outbox_oldest_age_warning_threshold_seconds" {
  description = <<-EOT
    Warning when the oldest undispatched event_outbox row exceeds this age.
    Default 900 (15 min): a healthy drainer clears a row in seconds, and a
    single failing handler reaches ~16 minutes of cumulative backoff by retry
    attempt 6 — so 15 sustained minutes means a real, persistent problem
    without firing on the first couple of retries.
  EOT
  type        = number
  default     = 900
}

variable "outbox_stalled_threshold_seconds" {
  description = <<-EOT
    Critical (pages) when the oldest undispatched event_outbox row exceeds this
    age. Default 3600 (1h): the full retry ladder for one row spans ~2h with the
    longest single wait being 64 minutes, so an hour-old row is either dying (a
    state worth a page on its own) or the drainer has stopped making progress
    entirely and every side effect on the platform is queued behind it.
  EOT
  type        = number
  default     = 3600
}
