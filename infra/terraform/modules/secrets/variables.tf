variable "name_prefix" {
  description = "Prefix applied to every secret name."
  type        = string
}

variable "kms_key_arn" {
  description = "KMS CMK used to encrypt every secret."
  type        = string
}

variable "initial_values" {
  description = <<-EOT
    Optional map of logical-name -> initial secret value. Any key NOT present
    is created as an empty secret that must be populated out-of-band before
    the ECS task can boot. We recommend leaving this map empty so secrets
    never live in .tfvars files.
  EOT
  type        = map(string)
  sensitive   = true
  default     = {}
}

variable "recovery_in_days" {
  description = "Days to retain a deleted secret before permanent deletion. 7 for non-prod, 30 for prod."
  type        = number
  default     = 30

  validation {
    condition     = var.recovery_in_days >= 7 && var.recovery_in_days <= 30
    error_message = "recovery_in_days must be between 7 and 30 (AWS limit)."
  }
}

variable "rotation_lambda_arns" {
  description = <<-EOT
    Optional map of logical-secret-name -> rotation lambda ARN. When set,
    Secrets Manager rotates the secret on `var.rotation_interval_days`
    cadence by invoking the lambda. The lambda is created outside this
    module — see `docs/security/secrets-management.md`.
  EOT
  type        = map(string)
  default     = {}
}

variable "rotation_interval_days" {
  description = "How often (days) Secrets Manager invokes the rotation lambda for any secret with a lambda wired."
  type        = number
  default     = 90

  validation {
    condition     = var.rotation_interval_days >= 7 && var.rotation_interval_days <= 365
    error_message = "rotation_interval_days must be between 7 and 365."
  }
}

variable "tags" {
  description = "Tags to apply to every secret."
  type        = map(string)
  default     = {}
}
