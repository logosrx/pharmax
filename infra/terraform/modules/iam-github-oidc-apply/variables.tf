variable "name_prefix" {
  description = "Prefix applied to the role name and to the IAM resource scoping (pharmax-<env>-<region-short>)."
  type        = string
}

variable "aws_account_id" {
  description = "Account id (used to construct the IAM resource ARNs the inline policy scopes to)."
  type        = string
}

variable "github_repository" {
  description = "GitHub repository in 'owner/repo' form that is allowed to assume the apply role."
  type        = string

  validation {
    condition     = can(regex("^[^/]+/[^/]+$", var.github_repository))
    error_message = "github_repository must be in 'owner/repo' form."
  }
}

variable "github_environments" {
  description = "Gated GitHub Environment names trusted to assume the role (e.g. [\"terraform-apply-prod-ue1\", \"terraform-apply-prod-uw2\"]). Each becomes an exact-match OIDC subject claim; the workflow's apply job must run inside one of these environments."
  type        = list(string)

  validation {
    condition     = length(var.github_environments) > 0
    error_message = "At least one GitHub Environment must be listed — an empty trust policy would make the role unassumable."
  }

  validation {
    condition     = alltrue([for e in var.github_environments : can(regex("^terraform-apply-", e))])
    error_message = "Every environment name must start with 'terraform-apply-' (the naming convention the workflow and runbook use)."
  }
}

variable "create_oidc_provider" {
  description = "Create the account-level GitHub OIDC provider here. Usually false — the cicd-deploy module owns the provider in accounts where it is enabled; pass its ARN via oidc_provider_arn instead."
  type        = bool
  default     = false
}

variable "oidc_provider_arn" {
  description = "ARN of an existing GitHub OIDC provider. Required when create_oidc_provider = false."
  type        = string
  default     = ""
}

variable "github_oidc_thumbprints" {
  description = "GitHub OIDC certificate thumbprints. Defaults to the two well-known GitHub values."
  type        = list(string)
  default = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fee",
  ]
}

variable "max_session_duration_seconds" {
  description = "Maximum role session duration. The apply job's timeout is 30 minutes, so the default 1h is comfortable headroom without leaving long-lived sessions around."
  type        = number
  default     = 3600
}

variable "tags" {
  description = "Tags applied to the role + OIDC provider."
  type        = map(string)
  default     = {}
}
