variable "name_prefix" {
  description = "Prefix applied to the bucket name."
  type        = string
}

variable "kms_key_arn" {
  description = "CMK used for SSE-KMS on every object."
  type        = string
}

variable "retention_years" {
  description = "Object Lock COMPLIANCE default retention. HIPAA-aware default is 7 (>= 6 required)."
  type        = number
  default     = 7

  validation {
    condition     = var.retention_years >= 6
    error_message = "HIPAA-aware retention must be at least 6 years."
  }
}

variable "min_put_retention_days" {
  description = <<-EOT
    Floor, in days, on the Object Lock retain-until date a PUT is allowed to
    request explicitly. Enforced by the DenyShortObjectLockRetention statement.

    Deliberately BELOW the bucket default (`retention_years`) rather than equal
    to it: a writer that sets retention explicitly computes a retain-until date
    from its own clock, and S3 evaluates the remaining-days condition key from
    the request. Pinning the floor at the default would put every legitimate
    write on a rounding boundary. The statement exists to refuse a one-day
    window, not to re-state the default. Default 2190 = the HIPAA six-year
    minimum, leaving a full year of margin under the seven-year default.
  EOT
  type        = number
  default     = 2190

  validation {
    condition     = var.min_put_retention_days >= 2190
    error_message = "The retention floor must be at least 2190 days (six years) to stay HIPAA-aware."
  }
}

variable "glacier_transition_days" {
  description = "Days after which objects transition to Glacier Deep Archive."
  type        = number
  default     = 90
}

variable "tags" {
  description = "Tags applied to the bucket."
  type        = map(string)
  default     = {}
}
