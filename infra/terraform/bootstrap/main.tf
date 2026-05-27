# =============================================================================
# Pharmax — Terraform backend bootstrap.
#
# Creates the resources Terraform itself needs BEFORE any per-env-region
# stack can use a remote backend:
#
#   1. An S3 bucket for state files. Versioning, SSE-KMS, public-access
#      block, GOVERNANCE-mode Object Lock, and TLS-only bucket policy.
#   2. A DynamoDB lock table for state locking.
#   3. A customer-managed KMS key encrypting the state bucket and the
#      lock table.
#
# Run ONCE per AWS account per region you intend to host backends in.
# This module is itself bootstrapped LOCALLY (no remote backend) — its
# state is committed via the operator's own machine + 1Password vault on
# initial setup, then migrated to the remote backend it just created if
# desired. See the README for the migration recipe.
#
# Why GOVERNANCE not COMPLIANCE on Object Lock:
#   COMPLIANCE is irrevocable. State files are NOT auditor evidence; they
#   are operational artifacts and may need to be rolled back during a
#   recovery event (a misapplied apply, a stuck plan). GOVERNANCE lets a
#   privileged operator with `s3:BypassGovernanceRetention` lift a lock
#   when explicitly necessary. The audit-archive bucket — which IS
#   evidence — uses COMPLIANCE; the state bucket does not.
# =============================================================================

provider "aws" {
  region = var.region

  default_tags {
    tags = merge(var.tags, {
      Project     = var.project
      Environment = var.environment
      Region      = var.region
      ManagedBy   = "terraform"
      Application = "pharmax"
      Compliance  = "hipaa+soc2"
      Purpose     = "terraform-state-backend"
    })
  }
}

data "aws_caller_identity" "current" {}

locals {
  # Bucket: pharmax-tfstate-<env>-<account-suffix> (unique-by-env+account).
  state_bucket_name = "${var.project}-tfstate-${var.environment}-${var.account_suffix}"
  lock_table_name   = "${var.project}-tfstate-locks-${var.environment}"
  cmk_alias         = "alias/${var.project}-tfstate-${var.environment}"
}

# ---- KMS key for state encryption ------------------------------------------

data "aws_iam_policy_document" "state_cmk" {
  statement {
    sid    = "EnableRootAdmin"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }
}

resource "aws_kms_key" "state" {
  description             = "Pharmax Terraform state encryption (${var.environment})"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.state_cmk.json
}

resource "aws_kms_alias" "state" {
  name          = local.cmk_alias
  target_key_id = aws_kms_key.state.id
}

# ---- State bucket ----------------------------------------------------------

resource "aws_s3_bucket" "state" {
  bucket              = local.state_bucket_name
  object_lock_enabled = true

  tags = {
    Name    = local.state_bucket_name
    Purpose = "terraform-state"
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.state.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    default_retention {
      mode = "GOVERNANCE"
      days = var.object_lock_governance_retention_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.state]
}

# Bucket policy: deny non-TLS, require SSE-KMS with this CMK on every PUT.
data "aws_iam_policy_document" "state_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.state.arn,
      "${aws_s3_bucket.state.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid     = "DenyUnEncryptedObjectUploads"
    effect  = "Deny"
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.state.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "StringNotEquals"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }

  statement {
    sid     = "DenyWrongKmsKey"
    effect  = "Deny"
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.state.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "StringNotEqualsIfExists"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [aws_kms_key.state.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state_bucket.json
}

# ---- DynamoDB lock table ---------------------------------------------------

resource "aws_dynamodb_table" "lock" {
  name         = local.lock_table_name
  billing_mode = var.lock_table_billing_mode
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.state.arn
  }

  point_in_time_recovery {
    enabled = true
  }

  deletion_protection_enabled = true
}
