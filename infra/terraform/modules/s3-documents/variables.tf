variable "name_prefix" {
  description = "Prefix applied to the bucket name."
  type        = string
}

variable "kms_key_arn" {
  description = "CMK used for SSE-KMS on every object."
  type        = string
}

variable "purpose" {
  description = "Bucket purpose slug — lands in the bucket name (`<prefix>-<purpose>-<suffix>`) and the Purpose tag. The module's properties (SSE-KMS, versioning, TLS-only, no Object Lock) suit any deletable PHI object family, e.g. `documents` or `package-photos`."
  type        = string
  default     = "documents"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.purpose))
    error_message = "purpose must be a lowercase kebab-case slug (S3 bucket-name safe)."
  }
}

variable "noncurrent_expiration_days" {
  description = "Days to retain noncurrent versions before expiring (versioning still on)."
  type        = number
  default     = 365
}

variable "abort_multipart_days" {
  description = "Days after which incomplete multipart uploads are aborted."
  type        = number
  default     = 7
}

variable "tags" {
  description = "Tags applied to the bucket."
  type        = map(string)
  default     = {}
}
