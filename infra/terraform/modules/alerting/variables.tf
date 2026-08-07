variable "name_prefix" {
  description = "Resource name prefix (`pharmax-<env>-<region-short>`). Also the alarm-name prefix the topic policy scopes publishes to."
  type        = string
}

variable "aws_account_id" {
  description = "AWS account id. Used in the topic policy conditions (aws:SourceAccount and the alarm SourceArn pattern)."
  type        = string
}

variable "aws_region" {
  description = "AWS region. Used to build the alarm SourceArn pattern the topic policy accepts publishes from."
  type        = string
}

variable "kms_key_arn" {
  description = "ARN of the CMK that encrypts both topics — `module.kms.alerts_key_arn`. Its key policy must grant cloudwatch.amazonaws.com GenerateDataKey*/Decrypt or every publish fails."
  type        = string
}

# ---- Subscription endpoints ---------------------------------------------------
#
# NOTHING here may be committed. Not in `terraform.tfvars`, not as a variable
# default, not in a comment as an example. An on-call mailbox or a paging
# webhook URL is either directly sensitive (the webhook URL is a bearer
# credential — anyone holding it can inject fake pages) or it is personal
# contact data that has no business in git history forever.
#
# Supply path at apply time, in order of preference:
#
#   1. `TF_VAR_critical_https_subscriptions='["https://events.pagerduty.com/..."]'`
#      exported by the gated terraform-apply workflow from a GitHub
#      Environment secret.
#   2. A `-var-file` held outside the repository for a local operator apply.
#
# Both lists default to empty so `terraform validate` and a plan in a fresh
# clone work without any secret material. Empty means "topic exists, nobody
# is subscribed" — the `check` blocks in main.tf make that state loud.
#
# Terraform note: these are deliberately NOT marked `sensitive`. `for_each`
# rejects a sensitive collection, and iterating is what turns a list into one
# subscription per endpoint. The values therefore appear in plan output and
# state; treat both as sensitive artifacts (the S3 state bucket is already
# SSE-KMS + versioned, and plan output lives in the private Actions log).

variable "critical_email_subscriptions" {
  description = "Email endpoints subscribed to the CRITICAL topic. Each requires a human to click the AWS confirmation link before it delivers anything."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for e in var.critical_email_subscriptions : can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", e))])
    error_message = "critical_email_subscriptions entries must be email addresses."
  }
}

variable "warning_email_subscriptions" {
  description = "Email endpoints subscribed to the warning topic (shift-start mailbox / ticket-creating address)."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for e in var.warning_email_subscriptions : can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", e))])
    error_message = "warning_email_subscriptions entries must be email addresses."
  }
}

variable "critical_https_subscriptions" {
  description = "HTTPS endpoints subscribed to the CRITICAL topic — the paging provider's inbound webhook."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for e in var.critical_https_subscriptions : startswith(e, "https://")])
    error_message = "critical_https_subscriptions entries must be https:// URLs. Plain http would carry alarm detail in cleartext."
  }
}

variable "warning_https_subscriptions" {
  description = "HTTPS endpoints subscribed to the warning topic — a ticket-creating webhook."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for e in var.warning_https_subscriptions : startswith(e, "https://")])
    error_message = "warning_https_subscriptions entries must be https:// URLs. Plain http would carry alarm detail in cleartext."
  }
}

variable "tags" {
  description = "Tags applied to both topics."
  type        = map(string)
  default     = {}
}
