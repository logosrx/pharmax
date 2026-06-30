variable "name_prefix" {
  description = "Prefix applied to role + policy names."
  type        = string
}

variable "aws_account_id" {
  description = "Account id (used in policy resources)."
  type        = string
}

variable "region" {
  description = "Region (used in CloudWatch Logs resource scoping and KMS ViaService conditions)."
  type        = string
}

variable "data_key_arn" {
  description = "ARN of the customer-managed KMS key for PHI envelope encryption (kms:GenerateDataKey + kms:Decrypt target)."
  type        = string
}

variable "search_key_arn" {
  description = "ARN of the GENERATE_VERIFY_MAC HMAC_256 key for blind-index search."
  type        = string
}

variable "asymm_sign_key_arn" {
  description = "ARN of the SIGN_VERIFY asymmetric KMS key for daily Merkle-root signing. Worker IAM role gets kms:Sign only — never kms:Verify or kms:Decrypt."
  type        = string
}

variable "audit_archive_key_arn" {
  description = "ARN of the dedicated audit-archive bucket CMK. Used for SSE-KMS roundtrip on Merkle-manifest writes."
  type        = string
}

variable "secrets_key_arn" {
  description = "ARN of the CMK used by Secrets Manager."
  type        = string
}

# Reserved — the root stack wires module.kms.logs_key_arn here so the IAM
# module can adopt log-group key policy later without an interface change.
# tflint-ignore: terraform_unused_declarations
variable "logs_key_arn" {
  description = "ARN of the CMK used by CloudWatch Logs. Reserved — log-group encryption is a CloudWatch service-side concern, not application IAM."
  type        = string
  default     = null
}

variable "documents_bucket_arn" {
  description = "ARN of the documents S3 bucket."
  type        = string
}

variable "audit_archive_bucket_arn" {
  description = "ARN of the audit archive S3 bucket."
  type        = string
}

variable "secret_arns" {
  description = "Map of logical-name -> Secrets Manager ARN. Used to scope GetSecretValue."
  type        = map(string)
}

variable "tags" {
  description = "Tags applied to every role / policy."
  type        = map(string)
  default     = {}
}
