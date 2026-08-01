# =============================================================================
# iam-github-oidc-drill — GitHub Actions OIDC role for the restore-drill
# workflow's READ-ONLY preflight phase (.github/workflows/restore-drill.yml).
#
# Why this exists:
#
#   The quarterly drill workflow always opens its tracking issue, but the
#   automated preflight — "are the backups actually restorable to a recent
#   point in time?" — only runs when a read-only AWS role is configured.
#   Without it the workflow posts "Automated preflight: skipped" every
#   quarter and the restorability signal stays manual (i.e. discovered on
#   drill day, which is exactly the wrong time to discover it).
#
#   This module puts that role in version control instead of an operator's
#   shell history, mirroring iam-github-oidc-apply.
#
# What this provisions:
#
#   1. (Optional) the account-level GitHub Actions OIDC identity provider.
#      Usually false — the cicd-deploy module already owns the provider in
#      accounts where it is enabled, and the root composition passes that
#      ARN through automatically.
#
#   2. A role whose permissions are exactly the two read-only API calls the
#      preflight phase of scripts/operations/run-restore-drill.ts makes:
#        - rds:DescribeDBClusters on the source cluster (backup retention +
#          LatestRestorableTime)
#        - kms:DescribeKey on the storage CMK (Enabled / ENCRYPT_DECRYPT /
#          SYMMETRIC_DEFAULT)
#      Nothing else. No restore, no create, no delete, no data-plane read of
#      any kind — this role cannot reach PHI even if its token leaked. The
#      destructive provision / restore / teardown phases stay operator-driven
#      by design (docs/operations/restore-drill.md § 5).
#
# Trust boundary:
#
#   The drill workflow runs on a schedule (and workflow_dispatch) on the
#   default branch, with no GitHub Environment, so its OIDC subject is the
#   branch ref. Two exact-match conditions pin it down:
#
#     sub              = repo:<owner>/<repo>:ref:<ref>
#     job_workflow_ref = <owner>/<repo>/<workflow path>@<ref>
#
#   The second is the load-bearing one: `sub` alone would let ANY workflow on
#   the default branch assume this role, whereas job_workflow_ref names the
#   specific workflow file. A new workflow added to the repo cannot borrow
#   the drill's AWS access without an IAM change reviewed here.
# =============================================================================

locals {
  oidc_provider_arn = var.create_oidc_provider ? one(aws_iam_openid_connect_provider.github[*].arn) : var.oidc_provider_arn

  subject_claim = "repo:${var.github_repository}:ref:${var.github_ref}"

  # GitHub sets job_workflow_ref to "<owner>/<repo>/<path>@<ref>" for the
  # workflow file that owns the job.
  job_workflow_ref = "${var.github_repository}/${var.workflow_path}@${var.github_ref}"
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
    sid     = "GitHubActionsOidcRestoreDrillPreflight"
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

    # Exact ref subject (no wildcard): a fork or feature-branch dispatch
    # produces a different subject and is denied.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [local.subject_claim]
    }

    # ...and only from the drill workflow file itself.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:job_workflow_ref"
      values   = [local.job_workflow_ref]
    }
  }
}

resource "aws_iam_role" "drill_preflight" {
  name                 = "${var.name_prefix}-gha-restore-drill-preflight"
  description          = "GitHub Actions OIDC role for the restore-drill workflow's read-only preflight. rds:DescribeDBClusters + kms:DescribeKey on the drill's source cluster and CMK; nothing else."
  assume_role_policy   = data.aws_iam_policy_document.assume.json
  max_session_duration = var.max_session_duration_seconds

  tags = var.tags
}

# ---- Permissions ------------------------------------------------------------

data "aws_iam_policy_document" "preflight" {
  # BackupRetentionPeriod >= 35 and LatestRestorableTime >= the requested
  # restore point. Resource-scoped to the source cluster ARN — RDS supports
  # resource-level permissions on DescribeDBClusters.
  statement {
    sid       = "DescribeSourceCluster"
    effect    = "Allow"
    actions   = ["rds:DescribeDBClusters"]
    resources = var.source_cluster_arns
  }

  # CMK health. The script passes the alias as the KeyId; IAM authorizes the
  # call against the underlying key ARN, so no alias resource is needed.
  statement {
    sid       = "DescribeStorageCmk"
    effect    = "Allow"
    actions   = ["kms:DescribeKey"]
    resources = var.kms_key_arns
  }
}

resource "aws_iam_role_policy" "preflight" {
  name   = "restore-drill-preflight"
  role   = aws_iam_role.drill_preflight.id
  policy = data.aws_iam_policy_document.preflight.json
}
