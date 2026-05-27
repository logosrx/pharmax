variable "project" {
  description = "Project slug. Pinned to 'pharmax' by default."
  type        = string
  default     = "pharmax"
}

variable "environment" {
  description = "Logical environment this state bucket holds (dev, staging, prod, prod-usw2)."
  type        = string
}

variable "region" {
  description = "Region the bootstrap resources live in. State buckets MUST be regional and SHOULD live in the same region as the workload they describe to avoid cross-region availability dependencies."
  type        = string
}

variable "account_suffix" {
  description = <<-EOT
    Short, account-distinguishing string appended to the state bucket name
    so the same env name does not collide if Pharmax is ever deployed to a
    second AWS account. Use a 6-12 character alphanumeric string — typically
    the last 6 characters of the account id, or a project-specific suffix.
  EOT
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{2,18}$", var.account_suffix))
    error_message = "account_suffix must be 3-19 chars lowercase alphanumeric / hyphens."
  }
}

variable "lock_table_billing_mode" {
  description = "DynamoDB billing mode for the lock table. Pay per request is right for low-volume Terraform locking."
  type        = string
  default     = "PAY_PER_REQUEST"
}

variable "object_lock_governance_retention_days" {
  description = <<-EOT
    Days of GOVERNANCE-mode Object Lock on the state bucket. GOVERNANCE
    (NOT COMPLIANCE) is intentional: a state-file rollback during an
    incident may require lifting retention with the right IAM permission.
    COMPLIANCE would make that impossible. Default 7 days — long enough
    to detect tamper, short enough to recover.
  EOT
  type        = number
  default     = 7
}

variable "tags" {
  description = "Tags applied to every bootstrap resource."
  type        = map(string)
  default     = {}
}
