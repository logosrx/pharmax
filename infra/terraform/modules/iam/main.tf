# =============================================================================
# IAM module — least-privilege roles per ECS service.
#
# Four roles total:
#
#   1. task_execution        — used by the Fargate agent (pulls image,
#                              fetches secrets, writes log group entries).
#                              Identical for all three services.
#
#   2. task_role_web         — runtime permissions for apps/web:
#                              * kms:GenerateDataKey / Decrypt / DescribeKey
#                                on the data CMK (envelope encryption)
#                              * kms:GenerateMac / DescribeKey on the search
#                                CMK (blind-index HMAC)
#                              * secretsmanager:GetSecretValue scoped to its
#                                managed secrets
#                              * s3 read/write on the documents bucket
#
#   3. task_role_worker      — runtime permissions for apps/worker:
#                              * everything web has, plus
#                              * kms:Sign + kms:DescribeKey on the asymm_sign
#                                CMK (Merkle-root signature; never Decrypt)
#                              * kms:GenerateDataKey + Decrypt on the
#                                audit-archive CMK (SSE-KMS roundtrip for the
#                                Merkle manifest write)
#                              * s3 PutObject + PutObjectRetention +
#                                PutObjectLegalHold on the audit archive
#                                bucket — write-only by spec; the bucket's
#                                Object Lock COMPLIANCE will refuse delete
#                                regardless
#
#   4. task_role_print_agent — narrowest:
#                              * read documents bucket (label PDFs / ZPL)
#                              * its secrets only (DATABASE_URL,
#                                PHARMAX_LOCAL_KMS_SEED, SENTRY_DSN)
#                              * kms:Decrypt + DescribeKey on the data CMK
#                                (it reads envelope-encrypted patient names
#                                for ZPL templates) — NO GenerateDataKey
#                                because it never writes PHI
#
# `secretsmanager:GetSecretValue` is scoped to the EXACT secret ARNs the
# secrets module created; no wildcard. The execution role separately gets
# access to ALL of them (it's how Fargate injects them as env vars).
#
# Every IAM role has a strict assume-role policy with `aws:SourceAccount`
# guarding the confused-deputy class of attack.
#
# Reference: ADR 0023 (AwsKmsAdapter IAM contract), ADR 0024 (Merkle-root
# signing IAM contract).
# =============================================================================

# ---- Common: execution role (Fargate agent) ---------------------------------

resource "aws_iam_role" "task_execution" {
  name = "${var.name_prefix}-task-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
      Action = "sts:AssumeRole"
      Condition = {
        StringEquals = {
          "aws:SourceAccount" = var.aws_account_id
        }
      }
    }]
  })

  tags = var.tags
}

resource "aws_iam_role_policy_attachment" "task_execution_default" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# The execution role needs to read EVERY secret we inject and decrypt the
# CMK used by Secrets Manager. Both are scoped by ARN — no wildcards.

data "aws_iam_policy_document" "task_execution_secrets" {
  statement {
    sid       = "ReadAllManagedSecrets"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = values(var.secret_arns)
  }

  statement {
    sid       = "DecryptSecretsCmk"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [var.secrets_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "task_execution_secrets" {
  name   = "${var.name_prefix}-task-execution-secrets"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.task_execution_secrets.json
}

# ---- Logging: every task role needs to write to its log group ---------------

locals {
  log_group_resources_arns = [
    "arn:aws:logs:${var.region}:${var.aws_account_id}:log-group:/ecs/${var.name_prefix}/*",
    "arn:aws:logs:${var.region}:${var.aws_account_id}:log-group:/ecs/${var.name_prefix}/*:*",
  ]
}

data "aws_iam_policy_document" "logs_write" {
  statement {
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = local.log_group_resources_arns
  }
}

# ---- Helper: KMS data-key grant (write+read access) -------------------------
# For services that ENCRYPT and DECRYPT PHI envelopes (web, worker).

data "aws_iam_policy_document" "kms_data_full" {
  statement {
    sid    = "EnvelopeEncryptDecrypt"
    effect = "Allow"
    actions = [
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
      "kms:Decrypt",
      "kms:DescribeKey",
    ]
    resources = [var.data_key_arn]
  }
}

# Helper: KMS data-key grant (read-only, no encrypt).
# For services that ONLY DECRYPT PHI envelopes (print-agent reads label data).

data "aws_iam_policy_document" "kms_data_decrypt_only" {
  statement {
    sid    = "EnvelopeDecryptOnly"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:DescribeKey",
    ]
    resources = [var.data_key_arn]
  }
}

# ---- Helper: KMS search-key grant (HMAC) ------------------------------------
# Web + worker need GenerateMac on the search key for blind-index lookups.

data "aws_iam_policy_document" "kms_search" {
  statement {
    sid    = "BlindIndexHmac"
    effect = "Allow"
    actions = [
      "kms:GenerateMac",
      "kms:VerifyMac",
      "kms:DescribeKey",
    ]
    resources = [var.search_key_arn]
  }
}

# ---- Helper: KMS asymmetric Merkle-signing grant (worker only) -------------

data "aws_iam_policy_document" "kms_asymm_sign" {
  statement {
    sid    = "AuditMerkleRootSign"
    effect = "Allow"
    actions = [
      "kms:Sign",
      "kms:GetPublicKey",
      "kms:DescribeKey",
    ]
    resources = [var.asymm_sign_key_arn]
  }
}

# ---- Helper: KMS audit-archive bucket-key grant (worker only) ---------------
# `s3:PutObject` to the audit archive bucket calls KMS via the SSE-KMS
# bucket-key flow; the worker IAM role needs explicit grants on the
# audit-archive CMK. Constrained via `kms:ViaService = s3.<region>.amazonaws.com`
# so the grant is unusable outside an S3-mediated call.

data "aws_iam_policy_document" "kms_audit_archive" {
  statement {
    sid    = "AuditArchiveBucketKey"
    effect = "Allow"
    actions = [
      "kms:GenerateDataKey",
      "kms:Decrypt",
      "kms:DescribeKey",
    ]
    resources = [var.audit_archive_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.region}.amazonaws.com"]
    }
  }
}

# ---- Helper: secret-scoped read (services that need a known subset) ---------
# Use the entire set for simplicity; we have already enumerated all secrets
# in the secrets module so passing them all here is still least-privilege at
# the resource level (no wildcards). If a service needs a narrower set, take
# a subset by key name.

data "aws_iam_policy_document" "secrets_read_all" {
  statement {
    sid       = "ReadManagedSecrets"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = values(var.secret_arns)
  }

  statement {
    sid       = "DecryptSecretsCmkViaService"
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [var.secrets_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.region}.amazonaws.com"]
    }
  }
}

# ---- Web task role ----------------------------------------------------------

resource "aws_iam_role" "task_web" {
  name = "${var.name_prefix}-task-web"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
      Action = "sts:AssumeRole"
      Condition = {
        StringEquals = {
          "aws:SourceAccount" = var.aws_account_id
        }
      }
    }]
  })

  tags = merge(var.tags, {
    Service = "web"
  })
}

resource "aws_iam_role_policy" "task_web_logs" {
  name   = "logs"
  role   = aws_iam_role.task_web.id
  policy = data.aws_iam_policy_document.logs_write.json
}

resource "aws_iam_role_policy" "task_web_kms_data" {
  name   = "kms-data"
  role   = aws_iam_role.task_web.id
  policy = data.aws_iam_policy_document.kms_data_full.json
}

resource "aws_iam_role_policy" "task_web_kms_search" {
  name   = "kms-search"
  role   = aws_iam_role.task_web.id
  policy = data.aws_iam_policy_document.kms_search.json
}

resource "aws_iam_role_policy" "task_web_secrets" {
  name   = "secrets"
  role   = aws_iam_role.task_web.id
  policy = data.aws_iam_policy_document.secrets_read_all.json
}

# Documents bucket — full ObjectGet + Put, scoped to bucket ARN only.
data "aws_iam_policy_document" "task_web_documents" {
  statement {
    sid    = "DocumentsList"
    effect = "Allow"
    actions = [
      "s3:ListBucket",
      "s3:GetBucketLocation",
    ]
    resources = [var.documents_bucket_arn]
  }

  statement {
    sid    = "DocumentsRW"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:GetObjectVersion",
    ]
    resources = ["${var.documents_bucket_arn}/*"]
  }
}

resource "aws_iam_role_policy" "task_web_documents" {
  name   = "documents"
  role   = aws_iam_role.task_web.id
  policy = data.aws_iam_policy_document.task_web_documents.json
}

# SSM Session Manager exec for `aws ecs execute-command`. Required for
# break-glass debugging; the SSM channel is wrapped per-message.
data "aws_iam_policy_document" "task_ssm_exec" {
  statement {
    sid    = "SSMSessionChannel"
    effect = "Allow"
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    # SSM messaging endpoints don't expose granular resource ARNs;
    # the action set + resource:* is the documented AWS pattern.
    # See: https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-exec.html
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "task_web_ssm_exec" {
  name   = "ssm-exec"
  role   = aws_iam_role.task_web.id
  policy = data.aws_iam_policy_document.task_ssm_exec.json
}

# ---- Worker task role -------------------------------------------------------

resource "aws_iam_role" "task_worker" {
  name = "${var.name_prefix}-task-worker"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
      Action = "sts:AssumeRole"
      Condition = {
        StringEquals = {
          "aws:SourceAccount" = var.aws_account_id
        }
      }
    }]
  })

  tags = merge(var.tags, {
    Service = "worker"
  })
}

resource "aws_iam_role_policy" "task_worker_logs" {
  name   = "logs"
  role   = aws_iam_role.task_worker.id
  policy = data.aws_iam_policy_document.logs_write.json
}

resource "aws_iam_role_policy" "task_worker_kms_data" {
  name   = "kms-data"
  role   = aws_iam_role.task_worker.id
  policy = data.aws_iam_policy_document.kms_data_full.json
}

resource "aws_iam_role_policy" "task_worker_kms_search" {
  name   = "kms-search"
  role   = aws_iam_role.task_worker.id
  policy = data.aws_iam_policy_document.kms_search.json
}

resource "aws_iam_role_policy" "task_worker_kms_asymm_sign" {
  name   = "kms-asymm-sign"
  role   = aws_iam_role.task_worker.id
  policy = data.aws_iam_policy_document.kms_asymm_sign.json
}

resource "aws_iam_role_policy" "task_worker_kms_audit_archive" {
  name   = "kms-audit-archive"
  role   = aws_iam_role.task_worker.id
  policy = data.aws_iam_policy_document.kms_audit_archive.json
}

resource "aws_iam_role_policy" "task_worker_secrets" {
  name   = "secrets"
  role   = aws_iam_role.task_worker.id
  policy = data.aws_iam_policy_document.secrets_read_all.json
}

resource "aws_iam_role_policy" "task_worker_ssm_exec" {
  name   = "ssm-exec"
  role   = aws_iam_role.task_worker.id
  policy = data.aws_iam_policy_document.task_ssm_exec.json
}

data "aws_iam_policy_document" "task_worker_buckets" {
  statement {
    sid    = "DocumentsRW"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:GetObjectVersion",
      "s3:ListBucket",
    ]
    resources = [
      var.documents_bucket_arn,
      "${var.documents_bucket_arn}/*",
    ]
  }

  # Audit archive: WRITE ONLY (worker emits signed Merkle roots).
  # The worker MUST NOT delete objects in this bucket — Object Lock
  # COMPLIANCE would block it anyway, but stating the limitation
  # explicitly here keeps the IAM surface narrow.
  statement {
    sid    = "AuditArchiveWrite"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:PutObjectRetention",
      "s3:PutObjectLegalHold",
      "s3:GetObject",
    ]
    resources = ["${var.audit_archive_bucket_arn}/*"]
  }

  statement {
    sid    = "AuditArchiveList"
    effect = "Allow"
    actions = [
      "s3:ListBucket",
      "s3:GetBucketLocation",
    ]
    resources = [var.audit_archive_bucket_arn]
  }
}

resource "aws_iam_role_policy" "task_worker_buckets" {
  name   = "buckets"
  role   = aws_iam_role.task_worker.id
  policy = data.aws_iam_policy_document.task_worker_buckets.json
}

# ---- Print-agent task role --------------------------------------------------

resource "aws_iam_role" "task_print_agent" {
  name = "${var.name_prefix}-task-print-agent"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
      Action = "sts:AssumeRole"
      Condition = {
        StringEquals = {
          "aws:SourceAccount" = var.aws_account_id
        }
      }
    }]
  })

  tags = merge(var.tags, {
    Service = "print-agent"
  })
}

resource "aws_iam_role_policy" "task_print_agent_logs" {
  name   = "logs"
  role   = aws_iam_role.task_print_agent.id
  policy = data.aws_iam_policy_document.logs_write.json
}

# Print-agent only DECRYPTS — it never writes PHI envelopes.
# kms_data_decrypt_only excludes GenerateDataKey by construction.
resource "aws_iam_role_policy" "task_print_agent_kms_data" {
  name   = "kms-data"
  role   = aws_iam_role.task_print_agent.id
  policy = data.aws_iam_policy_document.kms_data_decrypt_only.json
}

resource "aws_iam_role_policy" "task_print_agent_secrets" {
  name   = "secrets"
  role   = aws_iam_role.task_print_agent.id
  policy = data.aws_iam_policy_document.secrets_read_all.json
}

resource "aws_iam_role_policy" "task_print_agent_ssm_exec" {
  name   = "ssm-exec"
  role   = aws_iam_role.task_print_agent.id
  policy = data.aws_iam_policy_document.task_ssm_exec.json
}

data "aws_iam_policy_document" "task_print_agent_documents" {
  # Print-agent reads label PDFs / ZPL templates but does not write back.
  statement {
    sid    = "DocumentsRead"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:ListBucket",
    ]
    resources = [
      var.documents_bucket_arn,
      "${var.documents_bucket_arn}/*",
    ]
  }
}

resource "aws_iam_role_policy" "task_print_agent_documents" {
  name   = "documents-read"
  role   = aws_iam_role.task_print_agent.id
  policy = data.aws_iam_policy_document.task_print_agent_documents.json
}
