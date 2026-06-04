variable "name_prefix" {
  description = "Prefix applied to role names. Matches the rest of the stack (pharmax-<env>-<region-short>)."
  type        = string
}

variable "aws_account_id" {
  description = "Account id (used to construct ECS service ARNs)."
  type        = string
}

variable "region" {
  description = "Region (used to construct ECS service ARNs)."
  type        = string
}

variable "github_repository" {
  description = "GitHub repository in 'owner/repo' form that is allowed to assume the deploy role."
  type        = string

  validation {
    condition     = can(regex("^[^/]+/[^/]+$", var.github_repository))
    error_message = "github_repository must be in 'owner/repo' form."
  }
}

variable "github_environment" {
  description = "GitHub Environment name to scope the OIDC subject claim to (recommended; pairs with required-reviewer protection). Ignored when github_subject_claims is set."
  type        = string
  default     = ""
}

variable "github_subject_claims" {
  description = "Explicit override for the trusted OIDC 'sub' claims (StringLike). When empty, derived from github_environment or the main branch."
  type        = list(string)
  default     = []
}

variable "create_oidc_provider" {
  description = "Create the account-level GitHub OIDC provider. Set true in EXACTLY ONE working directory per AWS account; false elsewhere (and pass oidc_provider_arn)."
  type        = bool
  default     = true
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

variable "ecr_repository_arns" {
  description = "ECR repository ARNs the deploy role may push to (the pharmax web/worker/print-agent repos)."
  type        = list(string)
}

variable "passrole_role_arns" {
  description = "Task execution + task role ARNs the deploy role may iam:PassRole to ECS."
  type        = list(string)
}

variable "tags" {
  description = "Tags applied to the role + OIDC provider."
  type        = map(string)
  default     = {}
}
