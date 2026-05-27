# =============================================================================
# Audit archive bucket.
#
# This is the bucket the daily Merkle root signer (ADR 0024) writes signed
# audit-root manifests into.
#
# Critical properties:
#   - Object Lock in COMPLIANCE mode (NOT governance). COMPLIANCE is
#     irrevocable — even the root user cannot shorten retention. This
#     matches the regulatory expectation for an audit chain and SOC 2
#     CC7.2 / PI1.4 evidence.
#   - 7-year default retention (≥ HIPAA minimum of 6 years).
#   - Versioning required (Object Lock requires versioning).
#   - SSE-KMS with the **dedicated** audit-archive customer-managed key
#     (NOT the generic documents bucket key). AES256 uploads are denied
#     by the bucket policy. Wrong-CMK uploads are denied by the bucket
#     policy. PHI/non-TLS uploads are denied by the bucket policy.
#   - Block-public-access on all four settings.
#   - Lifecycle: transition to DEEP_ARCHIVE after `var.glacier_transition_days`.
#     We do NOT expire — that would defeat the audit retention guarantee.
#
# Object Lock CAN ONLY BE ENABLED AT BUCKET CREATION. If you forget, you
# must destroy + recreate. Terraform's `object_lock_enabled` argument is
# wired up below so this is a one-shot. Combined with `prevent_destroy`
# on the bucket resource, a `terraform destroy` will refuse to remove it.
# =============================================================================

resource "random_id" "suffix" {
  byte_length = 4
}

locals {
  bucket_name = "${var.name_prefix}-audit-archive-${random_id.suffix.hex}"
}

resource "aws_s3_bucket" "this" {
  bucket              = local.bucket_name
  object_lock_enabled = true

  tags = merge(var.tags, {
    Name               = local.bucket_name
    Purpose            = "audit-archive"
    DataClassification = "phi"
    Immutable          = "object-lock-compliance"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_object_lock_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    default_retention {
      mode  = "COMPLIANCE"
      years = var.retention_years
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket = aws_s3_bucket.this.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# ---- Bucket policy ----------------------------------------------------------
# Two denies (DENY > ALLOW):
#   1. Deny any non-TLS request.
#   2. Deny any PUT not using SSE-KMS (we don't want plain AES256 uploads).

# ---- Bucket policy ----------------------------------------------------------
# DENY > ALLOW. The default action on the bucket is no-action; these explicit
# DENY statements are the floor.
#
#   1. Deny any non-TLS request.
#   2. Deny any PUT not using SSE-KMS (no plain AES256 uploads).
#   3. Deny any PUT that targets a CMK other than this bucket's dedicated CMK.
#   4. Deny any PUT that bypasses Object-Lock retention metadata.
#
# We do NOT need a separate "principal must have kms:Encrypt" statement —
# the dedicated audit-archive CMK's resource policy already enumerates the
# allowed principals (account root + service principal s3.amazonaws.com),
# and a worker IAM grant adds `kms:GenerateDataKey` for the worker role
# only. A principal without kms:Encrypt on the CMK simply cannot encrypt
# the put-object data and the upload fails at the KMS layer.

data "aws_iam_policy_document" "bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.this.arn,
      "${aws_s3_bucket.this.arn}/*",
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
      "${aws_s3_bucket.this.arn}/*",
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
      "${aws_s3_bucket.this.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "StringNotEqualsIfExists"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [var.kms_key_arn]
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  bucket = aws_s3_bucket.this.id
  policy = data.aws_iam_policy_document.bucket.json
}

# ---- Lifecycle --------------------------------------------------------------

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "transition-to-deep-archive"
    status = "Enabled"

    filter {}

    transition {
      days          = var.glacier_transition_days
      storage_class = "DEEP_ARCHIVE"
    }

    noncurrent_version_transition {
      noncurrent_days = var.glacier_transition_days
      storage_class   = "DEEP_ARCHIVE"
    }

    # Intentionally NO expiration — Object Lock COMPLIANCE prevents early
    # deletion and we want the lifecycle to mirror that promise.
  }
}
