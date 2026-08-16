variable "name_prefix" {
  description = "Resource name prefix (e.g. pharmax-prod-ue1)."
  type        = string
}

variable "heartbeat_url" {
  description = <<-EOT
    Full public URL the heartbeat canary requests, e.g.
    `https://app.pharmax.co/api/health`. Must be HTTPS and publicly
    reachable — the canary runs OUTSIDE the VPC on purpose, so it sees
    what a pharmacist's browser sees (DNS, CloudFront/WAF, ALB, ECS),
    not what a task inside the private subnets sees.
  EOT
  type        = string

  validation {
    condition     = can(regex("^https://", var.heartbeat_url))
    error_message = "heartbeat_url must be a full https:// URL. If it is empty or relative, the root composition was enabled without app_url being set."
  }
}

variable "schedule_expression" {
  description = "Canary schedule. rate(1 minute) — the alarm below averages SuccessPercent over 5-minute periods, so a slower rate weakens the signal."
  type        = string
  default     = "rate(1 minute)"
}

variable "runtime_version" {
  description = <<-EOT
    Synthetics runtime for the canary. syn-nodejs-puppeteer-17.0 is the
    latest published runtime as of 2026-08; AWS deprecates old runtimes on
    a schedule (see the Synthetics runtime support policy), so expect to
    bump this. The canary script uses the `@aws/synthetics-puppeteer`
    namespace introduced in 13.1 — do not set this below 13.1.
  EOT
  type        = string
  default     = "syn-nodejs-puppeteer-17.0"
}

variable "canary_timeout_seconds" {
  description = "Per-run timeout. The health endpoint answers in milliseconds; 60s is generous headroom for cold starts."
  type        = number
  default     = 60
}

variable "artifact_retention_days" {
  description = "Days to keep canary artifacts (HAR files, logs, screenshots) in the artifacts bucket before lifecycle expiry."
  type        = number
  default     = 31
}

variable "alarm_evaluation_periods" {
  description = "Consecutive 5-minute periods of failed runs before the alarm fires. 2 = pages after ~10 minutes of failures."
  type        = number
  default     = 2
}

variable "critical_alarm_sns_topic_arn" {
  description = <<-EOT
    SNS topic ARN for alarms that page a human — `module.alerting.critical_topic_arn`.
    Empty falls back to `alarm_sns_topic_arn`, and if that is empty too the alarm
    evaluates but notifies nobody (acceptable outside production only). Same
    contract as `modules/cloudwatch`.
  EOT
  type        = string
  default     = ""
}

variable "warning_alarm_sns_topic_arn" {
  description = <<-EOT
    SNS topic ARN for warning-tier alarms — `module.alerting.warning_topic_arn`.
    Declared for parity with `modules/cloudwatch` (and because
    `scripts/check-alarm-actions.ts` requires both severity action lists to
    exist in any file that declares alarms); the heartbeat alarm itself is
    critical-tier.
  EOT
  type        = string
  default     = ""
}

variable "alarm_sns_topic_arn" {
  description = "LEGACY single-topic fallback, mirroring `modules/cloudwatch`. Prefer the per-severity variables."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
  default     = {}
}
