variable "name_prefix" {
  description = "Prefix applied to the bucket name."
  type        = string
}

variable "kms_key_arn" {
  description = "CMK used for SSE-KMS on every object."
  type        = string
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
