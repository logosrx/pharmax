# =============================================================================
# Pharmax — IAM Identity Center root.
#
# A STANDALONE root (like `bootstrap/`), applied ONCE from the AWS
# Organizations management or delegated-admin account in the region where the
# IAM Identity Center instance lives. It is NOT part of the per-workload-region
# composition (IdC is an org-level singleton).
#
# Prerequisites (one-time, console / Organizations — Terraform cannot do them):
#   1. Enable IAM Identity Center for the organization.
#   2. Choose the identity source (IdC store, or an external IdP via SAML/SCIM).
#   3. Turn on the MFA sign-in prompt in IdC settings ("Authentication" →
#      require MFA). This module adds a deny-without-MFA inline policy on top
#      as defense-in-depth, but the sign-in prompt is configured there.
#
# This root then provisions the permission sets, their MFA-enforcing inline
# policies, and (optionally) group→account assignments.
# =============================================================================

provider "aws" {
  region = var.region

  default_tags {
    tags = merge(var.tags, {
      Project     = var.project
      ManagedBy   = "terraform"
      Application = "pharmax"
      Compliance  = "hipaa+soc2"
      Purpose     = "iam-identity-center"
    })
  }
}

module "identity_center" {
  source = "../modules/iam-identity-center"

  name_prefix         = var.name_prefix
  account_assignments = var.account_assignments
}
