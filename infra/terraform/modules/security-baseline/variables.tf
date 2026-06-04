variable "name_prefix" {
  description = "Prefix applied to resource names (pharmax-<env>-<region-short>)."
  type        = string
}

# ---- Per-service toggles ----------------------------------------------------

variable "enable_cloudtrail" {
  description = "Provision the multi-region CloudTrail management-event trail + its SSE-KMS S3 bucket."
  type        = bool
  default     = true
}

variable "enable_config" {
  description = "Provision the AWS Config recorder + delivery channel + S3 bucket."
  type        = bool
  default     = true
}

variable "enable_config_rules" {
  description = "Provision the high-value AWS-managed Config compliance rules (only when enable_config = true)."
  type        = bool
  default     = true
}

variable "enable_guardduty" {
  description = "Enable the GuardDuty detector."
  type        = bool
  default     = true
}

variable "enable_securityhub" {
  description = "Enable the Security Hub account aggregator."
  type        = bool
  default     = true
}

variable "securityhub_enable_fsbp" {
  description = "Subscribe to the AWS Foundational Security Best Practices standard (only when enable_securityhub = true)."
  type        = bool
  default     = true
}

# ---- Tuning -----------------------------------------------------------------

variable "cloudtrail_log_retention_days" {
  description = "Days to retain CloudTrail logs in S3 before expiry (after a 90-day Glacier transition). 7y HIPAA-aware default."
  type        = number
  default     = 2555
}

variable "guardduty_finding_publishing_frequency" {
  description = "GuardDuty finding publishing cadence (FIFTEEN_MINUTES | ONE_HOUR | SIX_HOURS)."
  type        = string
  default     = "SIX_HOURS"
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}
