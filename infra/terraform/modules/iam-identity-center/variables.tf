variable "name_prefix" {
  description = "Prefix applied to permission set names (e.g. 'pharmax')."
  type        = string
  default     = "pharmax"
}

variable "permission_sets" {
  description = <<-EOT
    Map of permission sets to create. Key = short name (used in the resource
    name `<name_prefix>-<key>`). Each value:
      - description         human-readable purpose
      - session_duration    ISO-8601 duration (e.g. PT1H, PT4H, PT8H)
      - managed_policy_arns AWS-managed policy ARNs to attach
      - require_mfa         attach the deny-without-MFA inline policy
  EOT
  type = map(object({
    description         = string
    session_duration    = string
    managed_policy_arns = list(string)
  }))

  default = {
    Administrator = {
      description         = "Full administrative access. Short session; MFA enforced at IdC sign-in."
      session_duration    = "PT1H"
      managed_policy_arns = ["arn:aws:iam::aws:policy/AdministratorAccess"]
    }
    Engineer = {
      description         = "Day-to-day engineering access (no IAM/org changes)."
      session_duration    = "PT8H"
      managed_policy_arns = ["arn:aws:iam::aws:policy/PowerUserAccess"]
    }
    ReadOnly = {
      description         = "Read-only access for support / triage."
      session_duration    = "PT8H"
      managed_policy_arns = ["arn:aws:iam::aws:policy/ReadOnlyAccess"]
    }
    Billing = {
      description         = "Billing console + cost management."
      session_duration    = "PT4H"
      managed_policy_arns = ["arn:aws:iam::aws:policy/job-function/Billing"]
    }
    SecurityAudit = {
      description         = "Security configuration review (read-only across services)."
      session_duration    = "PT8H"
      managed_policy_arns = ["arn:aws:iam::aws:policy/SecurityAudit"]
    }
  }
}

variable "account_assignments" {
  description = <<-EOT
    Group → permission set → account assignments. Each entry references an
    EXISTING IdC group by display name (looked up in the identity store).
    Leave empty to define permission sets first and add assignments later.
  EOT
  type = list(object({
    permission_set_name = string
    group_display_name  = string
    account_id          = string
  }))
  default = []
}

variable "tags" {
  description = "Tags applied to each permission set."
  type        = map(string)
  default     = {}
}
