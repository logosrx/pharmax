variable "name_prefix" {
  description = "Prefix applied to the role name (pharmax-<env>-<region-short>)."
  type        = string
}

variable "github_repository" {
  description = "GitHub repository in 'owner/repo' form that is allowed to assume the preflight role."
  type        = string

  validation {
    condition     = can(regex("^[^/]+/[^/]+$", var.github_repository))
    error_message = "github_repository must be in 'owner/repo' form."
  }
}

variable "github_ref" {
  description = "Git ref the drill workflow runs on, e.g. 'refs/heads/main'. Scheduled runs always use the default branch; this becomes both the OIDC subject claim and the @ref half of the job_workflow_ref claim."
  type        = string
  default     = "refs/heads/main"
}

variable "workflow_path" {
  description = "Repo-relative path of the workflow file allowed to assume the role. Pins the trust to the drill workflow specifically, so another workflow on the same branch cannot borrow this role's AWS access."
  type        = string
  default     = ".github/workflows/restore-drill.yml"
}

variable "source_cluster_arns" {
  description = "ARNs of the Aurora cluster(s) the drill restores FROM. rds:DescribeDBClusters is scoped to exactly these."
  type        = list(string)

  validation {
    condition     = length(var.source_cluster_arns) > 0
    error_message = "At least one source cluster ARN is required — an empty list would make the preflight fail with AccessDenied."
  }
}

variable "kms_key_arns" {
  description = "ARNs of the CMK(s) encrypting the source cluster's storage. kms:DescribeKey is scoped to exactly these."
  type        = list(string)

  validation {
    condition     = length(var.kms_key_arns) > 0
    error_message = "At least one CMK ARN is required — the preflight's KMS health check would otherwise fail with AccessDenied."
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
  description = "Maximum role session duration. The preflight job's timeout is 10 minutes; the AWS minimum of 1h is the floor."
  type        = number
  default     = 3600
}

variable "tags" {
  description = "Tags applied to the role + OIDC provider."
  type        = map(string)
  default     = {}
}
