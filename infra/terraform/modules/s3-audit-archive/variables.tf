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
