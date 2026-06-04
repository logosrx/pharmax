# =============================================================================
# CI/CD deploy module — GitHub Actions OIDC role for the source → ECR → ECS
# pipeline (.github/workflows/deploy.yml).
#
# What this provisions:
#
#   1. (Optional) the account-level GitHub Actions OIDC identity provider
#      (token.actions.githubusercontent.com). It is account-global, so when
#      multiple env-region working directories share one AWS account, EXACTLY
#      ONE of them must set `create_oidc_provider = true`; the others set it to
#      false and pass the existing `oidc_provider_arn`.
#
#   2. A least-privilege deploy role assumed via OIDC, trusted ONLY for the
#      configured GitHub repository + environment/branch subject claims. The
#      role can:
#        - authenticate to ECR and push/pull ONLY the pharmax/* repos
#        - register a new task-definition revision and update ONLY the three
#          pharmax ECS services on the pharmax cluster
#        - iam:PassRole ONLY the task execution + three task roles, and only
#          to ecs-tasks.amazonaws.com
#
# It deliberately holds NO Create*/Delete* infrastructure permissions — image
# rollout only. Infra changes stay operator-driven through a separate role
# (mirrors the read-only drift role pattern in terraform-drift.yml).
#
# Notes on AWS resource-level permission gaps (these MUST be "*"):
#   - ecs:RegisterTaskDefinition and ecs:DescribeTaskDefinition do not support
#     resource-level scoping.
#   - ecr:GetAuthorizationToken is an account-wide action.
# =============================================================================

locals {
  # GitHub OIDC subject claims this role will trust. Precedence:
  #   1. explicit override list, else
  #   2. a single environment-scoped claim (recommended; pairs with a GitHub
  #      Environment that has required reviewers), else
  #   3. the main-branch ref claim.
  subject_claims = length(var.github_subject_claims) > 0 ? var.github_subject_claims : (
    var.github_environment != "" ?
    ["repo:${var.github_repository}:environment:${var.github_environment}"] :
    ["repo:${var.github_repository}:ref:refs/heads/main"]
  )

  # `one(...)` over the splat is null-safe when count = 0 (avoids the
  # index-out-of-range that a bare [0] would raise even in the untaken
  # branch of the conditional).
  oidc_provider_arn = var.create_oidc_provider ? one(aws_iam_openid_connect_provider.github[*].arn) : var.oidc_provider_arn

  cluster_name  = "${var.name_prefix}-cluster"
  service_names = ["web", "worker", "print-agent"]

  service_arns = [
    for s in local.service_names :
    "arn:aws:ecs:${var.region}:${var.aws_account_id}:service/${local.cluster_name}/${var.name_prefix}-${s}"
  ]
}

# ---- GitHub Actions OIDC identity provider (optional) ----------------------

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 1 : 0

  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  # GitHub's OIDC certificate thumbprints. AWS no longer verifies these for
  # well-known IdPs, but the argument is still required by the resource.
  thumbprint_list = var.github_oidc_thumbprints

  tags = var.tags
}

# ---- Trust policy ----------------------------------------------------------

data "aws_iam_policy_document" "assume" {
  statement {
    sid     = "GitHubActionsOidc"
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

    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = local.subject_claims
    }
  }
}

resource "aws_iam_role" "deploy" {
  name                 = "${var.name_prefix}-gha-deploy"
  description          = "GitHub Actions OIDC role: build + push images to ECR and roll out the pharmax ECS services."
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  max_session_duration = 3600

  tags = var.tags
}

# ---- Permissions -----------------------------------------------------------

data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "EcrAuth"
    effect    = "Allow"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid    = "EcrPushPull"
    effect = "Allow"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
    ]
    resources = var.ecr_repository_arns
  }

  # RegisterTaskDefinition + DescribeTaskDefinition do not support
  # resource-level permissions — AWS requires "*".
  statement {
    sid    = "EcsTaskDefinition"
    effect = "Allow"
    actions = [
      "ecs:RegisterTaskDefinition",
      "ecs:DescribeTaskDefinition",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "EcsServiceDeploy"
    effect = "Allow"
    actions = [
      "ecs:DescribeServices",
      "ecs:UpdateService",
    ]
    resources = local.service_arns
  }

  # The deploy role registers task definitions that reference the task
  # execution + task roles, so it must be allowed to pass exactly those
  # roles — and only to ECS.
  statement {
    sid       = "PassTaskRoles"
    effect    = "Allow"
    actions   = ["iam:PassRole"]
    resources = var.passrole_role_arns

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy"
  role   = aws_iam_role.deploy.id
  policy = data.aws_iam_policy_document.deploy.json
}
