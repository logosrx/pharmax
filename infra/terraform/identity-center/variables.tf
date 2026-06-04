variable "region" {
  description = "Region where the IAM Identity Center instance lives (a single region per org)."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]+$", var.region))
    error_message = "region must look like a real AWS region code, e.g. us-east-1."
  }
}

variable "project" {
  description = "Project slug for tagging."
  type        = string
  default     = "pharmax"
}

variable "name_prefix" {
  description = "Prefix applied to permission set names."
  type        = string
  default     = "pharmax"
}

variable "account_assignments" {
  description = <<-EOT
    Group → permission set → account assignments. Each entry references an
    EXISTING IdC group by display name. Empty by default so you can apply the
    permission sets first, then add assignments once groups exist.
  EOT
  type = list(object({
    permission_set_name = string
    group_display_name  = string
    account_id          = string
  }))
  default = []
}

variable "tags" {
  description = "Extra tags merged onto the provider default tags."
  type        = map(string)
  default     = {}
}
