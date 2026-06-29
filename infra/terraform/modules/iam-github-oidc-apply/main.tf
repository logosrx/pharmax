# =============================================================================
# iam-github-oidc-apply — GitHub Actions OIDC role for the approval-gated
# terraform-apply workflow (.github/workflows/terraform-apply.yml).
#
# Closes the "apply-role provisioned by Terraform" polish item from
# docs/operations/production-deployment.md § 8: the role's trust policy and
# permissions now live in version control rather than an operator's shell
# history.
#
# What this provisions:
#
#   1. (Optional) the account-level GitHub Actions OIDC identity provider.
#      In an account where the cicd-deploy module already owns the provider,
#      leave `create_oidc_provider = false` (the default) and pass the
#      existing ARN — the root composition does this automatically when
#      both modules are enabled in the same working directory.
#
#   2. The terraform-apply role, trusted ONLY for exact
#      `repo:<owner>/<repo>:environment:<name>` subject claims — one per
#      gated GitHub Environment (e.g. terraform-apply-prod-ue1). Note
#      StringEquals, not StringLike: the apply role is the most powerful
#      OIDC principal in the account, so the trust boundary is exact-match,
#      no wildcards. A workflow job that omits the `environment:` key (and
#      therefore bypasses the required-reviewer approval) fails OIDC
#      federation at the STS step. This is the defense-in-depth layer on
#      top of the workflow-level gate.
#
#   3. Permissions: the AWS-managed PowerUserAccess policy (everything
#      except IAM/account management) PLUS a narrow inline IAM policy:
#        - read-only iam:Get*/List* on * (terraform plan reads IAM broadly)
#        - IAM write actions ONLY on `<name_prefix>-*` roles / policies /
#          instance profiles (the names this stack provisions)
#        - write on the GitHub OIDC provider resource (the stack manages it)
#        - iam:PassRole ONLY for `<name_prefix>-*` roles, and only to
#          AWS service principals
#        - iam:CreateServiceLinkedRole (RDS / ECS / ElastiCache / GuardDuty
#          create SLRs on first use)
#
# Chicken-and-egg note: this module cannot provision the role used for the
# FIRST apply in a virgin account — that one is operator-driven per the
# runbook § 3. Once the first apply has run (creating this role), routine
# applies move to the CI path and this module keeps the role's definition
# under review.
# =============================================================================

locals {
  # Exact subject claims, one per gated GitHub Environment.
  subject_claims = [
    for env in var.github_environments :
    "repo:${var.github_repository}:environment:${env}"
  ]

  oidc_provider_arn = var.create_oidc_provider ? one(aws_iam_openid_connect_provider.github[*].arn) : var.oidc_provider_arn
}

# ---- GitHub Actions OIDC identity provider (optional) ----------------------

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 1 : 0

  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = var.github_oidc_thumbprints

  tags = var.tags
}

# ---- Trust policy -----------------------------------------------------------

data "aws_iam_policy_document" "assume" {
  statement {
    sid     = "GitHubActionsOidcTerraformApply"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # StringEquals (exact), deliberately NOT StringLike: the apply role is
    # the most powerful OIDC principal in the account. Each value names one
    # gated GitHub Environment; there is no wildcard surface.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.subject_claims
    }
  }
}

resource "aws_iam_role" "terraform_apply" {
  name                 = "${var.name_prefix}-gha-terraform-apply"
  description          = "GitHub Actions OIDC role for the approval-gated terraform-apply workflow. Assumable ONLY from the gated GitHub Environment(s)."
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  max_session_duration = var.max_session_duration_seconds

  tags = var.tags
}

# ---- Permissions ------------------------------------------------------------

# PowerUserAccess: everything except IAM / Organizations / account
# management. Covers the S3 state bucket, the DynamoDB lock table, and
# every resource type the stack's modules provision (VPC, RDS, KMS, S3,
# ECS, ECR, ALB, WAF, CloudWatch, Secrets Manager, ElastiCache, ...).
resource "aws_iam_role_policy_attachment" "power_user" {
  role       = aws_iam_role.terraform_apply.name
  policy_arn = "arn:aws:iam::aws:policy/PowerUserAccess"
}

# Narrow IAM supplement — PowerUserAccess excludes IAM by design, but the
# stack's iam / cicd-deploy / security-baseline modules manage roles and
# policies, so the apply role needs scoped IAM write.
data "aws_iam_policy_document" "iam_supplement" {
  # terraform plan reads IAM broadly (data sources + state refresh).
  statement {
    sid    = "IamReadOnly"
    effect = "Allow"
    actions = [
      "iam:Get*",
      "iam:List*",
    ]
    resources = ["*"]
  }

  # Write ONLY on the names this stack provisions.
  statement {
    sid    = "IamWriteStackScoped"
    effect = "Allow"
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:UpdateRole",
      "iam:UpdateRoleDescription",
      "iam:UpdateAssumeRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PutRolePermissionsBoundary",
      "iam:DeleteRolePermissionsBoundary",
      "iam:CreatePolicy",
      "iam:DeletePolicy",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicyVersion",
      "iam:SetDefaultPolicyVersion",
      "iam:TagPolicy",
      "iam:UntagPolicy",
      "iam:CreateInstanceProfile",
      "iam:DeleteInstanceProfile",
      "iam:AddRoleToInstanceProfile",
      "iam:RemoveRoleFromInstanceProfile",
      "iam:TagInstanceProfile",
      "iam:UntagInstanceProfile",
    ]
    resources = [
      "arn:aws:iam::${var.aws_account_id}:role/${var.name_prefix}-*",
      "arn:aws:iam::${var.aws_account_id}:policy/${var.name_prefix}-*",
      "arn:aws:iam::${var.aws_account_id}:instance-profile/${var.name_prefix}-*",
    ]
  }

  # The stack manages the account-level GitHub OIDC provider (via the
  # cicd-deploy module or this one), so plan/apply must be able to
  # read + update + tag it.
  statement {
    sid    = "IamOidcProvider"
    effect = "Allow"
    actions = [
      "iam:CreateOpenIDConnectProvider",
      "iam:DeleteOpenIDConnectProvider",
      "iam:UpdateOpenIDConnectProviderThumbprint",
      "iam:AddClientIDToOpenIDConnectProvider",
      "iam:RemoveClientIDFromOpenIDConnectProvider",
      "iam:TagOpenIDConnectProvider",
      "iam:UntagOpenIDConnectProvider",
    ]
    resources = [
      "arn:aws:iam::${var.aws_account_id}:oidc-provider/token.actions.githubusercontent.com",
    ]
  }

  # PassRole only for stack-named roles, and only to AWS services
  # (flow logs → vpc-flow-logs, task roles → ecs-tasks, config recorder
  # → config, etc.). Never to another IAM principal.
  statement {
    sid       = "PassStackRolesToAwsServices"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::${var.aws_account_id}:role/${var.name_prefix}-*"]

    condition {
      test     = "StringLike"
      variable = "iam:PassedToService"
      values   = ["*.amazonaws.com"]
    }
  }

  # First-use service-linked roles (RDS, ECS, ElastiCache, GuardDuty,
  # Shield, ...). AWS names these itself under aws-service-role/.
  statement {
    sid       = "CreateServiceLinkedRoles"
    effect    = "Allow"
    actions   = ["iam:CreateServiceLinkedRole"]
    resources = ["arn:aws:iam::${var.aws_account_id}:role/aws-service-role/*"]
  }
}

resource "aws_iam_role_policy" "iam_supplement" {
  name   = "iam-supplement"
  role   = aws_iam_role.terraform_apply.id
  policy = data.aws_iam_policy_document.iam_supplement.json
}
