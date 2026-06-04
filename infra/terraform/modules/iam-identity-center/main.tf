# =============================================================================
# IAM Identity Center module — workforce SSO + MFA-enforced permission sets.
#
# This governs how ENGINEERS / OPERATORS access the AWS accounts (console +
# CLI), NOT how patients/operators authenticate to the Pharmax app (that is
# Clerk). It implements the "IAM least privilege + MFA/SSO" control:
#
#   - Permission sets (Administrator, Engineer, ReadOnly, Billing,
#     SecurityAudit) with bounded session durations and AWS-managed policies.
#   - MFA enforced at the IdC sign-in layer (Settings → Authentication →
#     require MFA). NOTE: we do NOT add an `aws:MultiFactorAuthPresent` deny
#     policy — that key is unreliable for IdC federated sessions and would
#     lock the role out entirely. See the "MFA enforcement" note below.
#   - Account assignments mapping IdC groups → permission sets → target
#     accounts (optional; supply once your groups exist).
#
# SINGLETON / LOCATION: IAM Identity Center is an AWS Organizations service
# with ONE instance per org, managed from the management or delegated-admin
# account in a single region. This module is meant to be applied from THAT
# account via the dedicated `infra/terraform/identity-center` root — NOT from
# the per-workload-region stacks. The instance itself must be enabled once in
# the console/Organizations (Terraform cannot create the instance); this
# module discovers it via `aws_ssoadmin_instances`.
# =============================================================================

data "aws_ssoadmin_instances" "this" {}

locals {
  instance_arn      = tolist(data.aws_ssoadmin_instances.this.arns)[0]
  identity_store_id = tolist(data.aws_ssoadmin_instances.this.identity_store_ids)[0]

  # Flatten permission_set × managed_policy_arn → one attachment per pair.
  managed_attachments = merge([
    for ps_name, ps in var.permission_sets : {
      for arn in ps.managed_policy_arns : "${ps_name}|${arn}" => {
        permission_set = ps_name
        policy_arn     = arn
      }
    }
  ]...)

  # Account assignments keyed for for_each stability.
  assignments = {
    for a in var.account_assignments :
    "${a.permission_set_name}|${a.group_display_name}|${a.account_id}" => a
  }
}

# ---- Permission sets --------------------------------------------------------

resource "aws_ssoadmin_permission_set" "this" {
  for_each = var.permission_sets

  name             = "${var.name_prefix}-${each.key}"
  description      = each.value.description
  instance_arn     = local.instance_arn
  session_duration = each.value.session_duration

  tags = var.tags
}

resource "aws_ssoadmin_managed_policy_attachment" "this" {
  for_each = local.managed_attachments

  instance_arn       = local.instance_arn
  managed_policy_arn = each.value.policy_arn
  permission_set_arn = aws_ssoadmin_permission_set.this[each.value.permission_set].arn
}

# ---- MFA enforcement --------------------------------------------------------
#
# MFA is enforced at the IAM Identity Center SIGN-IN layer (Settings →
# Authentication → "require MFA"), which is the supported mechanism for IdC.
#
# We deliberately do NOT attach a deny-unless-`aws:MultiFactorAuthPresent`
# inline policy: that key is the IAM-user pattern and is NOT reliably present
# in IdC federated role sessions, so a `BoolIfExists ... = false` deny matches
# the (absent) key and locks the role out of EVERYTHING (CLI/Terraform included).
# The sign-in MFA requirement already guarantees every session is MFA-backed.

# ---- Account assignments (group → permission set → account) -----------------

data "aws_identitystore_group" "assigned" {
  for_each = local.assignments

  identity_store_id = local.identity_store_id

  alternate_identifier {
    unique_attribute {
      attribute_path  = "DisplayName"
      attribute_value = each.value.group_display_name
    }
  }
}

resource "aws_ssoadmin_account_assignment" "this" {
  for_each = local.assignments

  instance_arn       = local.instance_arn
  permission_set_arn = aws_ssoadmin_permission_set.this[each.value.permission_set_name].arn

  principal_id   = data.aws_identitystore_group.assigned[each.key].group_id
  principal_type = "GROUP"

  target_id   = each.value.account_id
  target_type = "AWS_ACCOUNT"
}
