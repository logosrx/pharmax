# =============================================================================
# Schema-drift checker role — read-only, unattended, main-branch only.
# =============================================================================
#
# .github/workflows/schema-drift.yml runs `prisma migrate status` nightly to
# assert that the schema satisfies the migrations baked into the image that is
# actually serving traffic. It exists because production once ran a month
# behind its schema (29 migrations, oldest 2026-07-10) with nothing to say so.
#
# It cannot reuse the deploy role. That role is trusted only for
# `repo:<repo>:environment:<env>`, and the production Environment requires a
# human reviewer — correct for a deploy, fatal for a nightly cron, which would
# sit pending until someone approved it and would therefore be ignored within a
# week. Adding a ref-based claim to the deploy role instead would let any
# workflow on main assume full deploy privileges with no approval, trading the
# entire production gate for a status check. Neither is acceptable.
#
# So this is a second, much smaller role trusted on the main-branch ref, with
# no environment gate and no ability to change anything: it can describe the
# worker service, run the worker task definition (whose command the workflow
# overrides with a read-only `migrate status`), and read that task's log
# output. It cannot update a service, register a task definition, push an
# image, or read a secret's value.
#
# The residual risk is honest: RunTask on the worker family means this role can
# start a worker-shaped task with an arbitrary command override, inheriting the
# worker task role. That is the same authority the deploy role already needs
# for the migration gate, and it is the minimum required to reach a database
# that lives in a private subnet. It is bounded to one task family in one
# cluster.

data "aws_iam_policy_document" "schema_check_assume" {
  count = var.enable_schema_check_role ? 1 : 0

  statement {
    sid     = "GitHubActionsOidcMainBranch"
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

    # Scheduled workflows always run on the default branch, so the ref claim
    # is the tightest subject available for an unattended job.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:ref:refs/heads/main"]
    }
  }
}

data "aws_iam_policy_document" "schema_check" {
  count = var.enable_schema_check_role ? 1 : 0

  # Resolves which task definition the worker service is currently running,
  # and the subnets/security groups to place the status task in.
  statement {
    sid       = "DescribeWorkerService"
    effect    = "Allow"
    actions   = ["ecs:DescribeServices"]
    resources = ["arn:aws:ecs:${var.region}:${var.aws_account_id}:service/${local.cluster_name}/${var.name_prefix}-worker"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = ["arn:aws:ecs:${var.region}:${var.aws_account_id}:cluster/${local.cluster_name}"]
    }
  }

  # DescribeTaskDefinition does not support resource-level permissions, so
  # `*` is the only expressible form. It returns task-definition metadata
  # (image, log group, secret ARNs) and never a secret's value.
  statement {
    sid       = "DescribeTaskDefinitionMetadata"
    effect    = "Allow"
    actions   = ["ecs:DescribeTaskDefinition"]
    resources = ["*"]
  }

  statement {
    sid    = "RunSchemaStatusTask"
    effect = "Allow"
    actions = [
      "ecs:RunTask",
      "ecs:DescribeTasks",
    ]
    resources = [
      "arn:aws:ecs:${var.region}:${var.aws_account_id}:task-definition/${var.name_prefix}-worker:*",
      "arn:aws:ecs:${var.region}:${var.aws_account_id}:task/${local.cluster_name}/*",
    ]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = ["arn:aws:ecs:${var.region}:${var.aws_account_id}:cluster/${local.cluster_name}"]
    }
  }

  # `migrate status` reports through stdout, so its log stream is the result.
  statement {
    sid       = "ReadSchemaStatusTaskLogs"
    effect    = "Allow"
    actions   = ["logs:GetLogEvents"]
    resources = ["arn:aws:logs:${var.region}:${var.aws_account_id}:log-group:/ecs/${var.name_prefix}/worker:*"]
  }

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

resource "aws_iam_role" "schema_check" {
  count = var.enable_schema_check_role ? 1 : 0

  name                 = "${var.name_prefix}-gha-schema-check"
  description          = "GitHub Actions OIDC role: read-only nightly `prisma migrate status` against the running worker task definition."
  assume_role_policy   = data.aws_iam_policy_document.schema_check_assume[0].json
  max_session_duration = 3600
  tags                 = var.tags
}

resource "aws_iam_role_policy" "schema_check" {
  count = var.enable_schema_check_role ? 1 : 0

  name   = "schema-check"
  role   = aws_iam_role.schema_check[0].id
  policy = data.aws_iam_policy_document.schema_check[0].json
}
