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
# DENY > ALLOW. The default action on the bucket is no-action; these explicit
# DENY statements are the floor.
#
# `local.bucket_policy_denies` below — NOT this comment — is the authoritative
# enumeration. The `precondition` on `aws_s3_bucket_policy.this` fails the plan
# when the rendered policy's sids diverge from that map, so the two cannot
# drift apart silently. This matters because an earlier prose-only enumeration
# claimed a fourth DENY that was never implemented, and the gap survived every
# subsequent review of the file: the comment was updated, the code was not, and
# nothing compared them.
#
# We do NOT need a separate "principal must have kms:Encrypt" statement —
# the dedicated audit-archive CMK's resource policy already enumerates the
# allowed principals (account root + service principal s3.amazonaws.com),
# and a worker IAM grant adds `kms:GenerateDataKey` for the worker role
# only. A principal without kms:Encrypt on the CMK simply cannot encrypt
# the put-object data and the upload fails at the KMS layer.

locals {
  # sid => the exposure that statement closes.
  bucket_policy_denies = {
    DenyInsecureTransport = "Any non-TLS request."

    DenyUnEncryptedObjectUploads = "Any PUT not using SSE-KMS (no plain AES256 uploads)."

    DenyWrongKmsKey = "Any PUT targeting a CMK other than this bucket's dedicated CMK."

    # Per-object Object Lock headers OVERRIDE the bucket's default retention
    # rule. A PUT carrying `x-amz-object-lock-mode: GOVERNANCE` therefore
    # lands an object whose retention any holder of
    # `s3:BypassGovernanceRetention` can lift — deletable, in the one bucket
    # whose entire purpose is that nothing in it can be deleted. A PUT that
    # sends no Object Lock headers at all is unaffected: it inherits the
    # bucket default (COMPLIANCE), which is why the test below must be the
    # `IfExists` form.
    DenyNonComplianceObjectLockMode = "Any PUT naming an Object Lock mode other than COMPLIANCE."

    # Mode alone is not sufficient. `COMPLIANCE` with a retain-until date of
    # tomorrow is COMPLIANCE-mode for exactly one day, after which the object
    # is deletable by anyone with `s3:DeleteObject`. The floor is deliberately
    # below the bucket default so legitimate explicit-retention writers clear
    # it with a wide margin.
    DenyShortObjectLockRetention = "Any PUT whose requested retention is under the HIPAA six-year floor."
  }
}

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

  statement {
    sid     = "DenyNonComplianceObjectLockMode"
    effect  = "Deny"
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.this.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    # `StringNotEqualsIfExists`, NOT `StringNotEquals`. The plain form
    # evaluates to true when the key is absent, which would deny every
    # header-less PUT — including the Merkle-manifest and evidence-pack
    # writes that deliberately inherit the bucket's COMPLIANCE default.
    # The `IfExists` form denies only a PUT that names a mode AND names one
    # other than COMPLIANCE, which is exactly the GOVERNANCE downgrade.
    condition {
      test     = "StringNotEqualsIfExists"
      variable = "s3:object-lock-mode"
      values   = ["COMPLIANCE"]
    }
  }

  statement {
    sid     = "DenyShortObjectLockRetention"
    effect  = "Deny"
    actions = ["s3:PutObject"]
    resources = [
      "${aws_s3_bucket.this.arn}/*",
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    # Separate statement rather than a second condition on the mode DENY:
    # conditions within one statement are AND-ed, so combining them would
    # only deny a PUT that was BOTH non-COMPLIANCE AND short-retention. We
    # want either one to be refused on its own.
    #
    # `IfExists` again: absent the header the key is unset and the bucket
    # default (`retention_years`) applies.
    condition {
      test     = "NumericLessThanIfExists"
      variable = "s3:object-lock-remaining-retention-days"
      values   = [tostring(var.min_put_retention_days)]
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  bucket = aws_s3_bucket.this.id
  policy = data.aws_iam_policy_document.bucket.json

  lifecycle {
    # The enumeration in `local.bucket_policy_denies` is documentation that
    # the plan verifies. Add a statement without documenting it — or document
    # one without adding it, which is the failure this module actually
    # suffered — and the plan stops here.
    #
    # `sort(keys(...))`, not bare `keys(...)`: keys() on an object literal
    # returns a TUPLE, sort() returns a LIST, and Terraform's `==` is false
    # for equal elements of unequal types. The bare form made this
    # precondition unconditionally false — which no pipeline noticed,
    # because the drift job was silently skipping (AWS_DRIFT_ROLE_ARN
    # unset) and no reviewer-gated apply had run since it landed. sort()
    # normalises both sides to list(string); keys() is already ordered, so
    # the extra sort changes nothing but the type.
    precondition {
      condition = sort([
        for statement in jsondecode(data.aws_iam_policy_document.bucket.json).Statement :
        statement.Sid
      ]) == sort(keys(local.bucket_policy_denies))

      error_message = format(
        "Audit-archive bucket policy drift: rendered sids %v do not match the documented set %v in local.bucket_policy_denies.",
        sort([for s in jsondecode(data.aws_iam_policy_document.bucket.json).Statement : s.Sid]),
        sort(keys(local.bucket_policy_denies))
      )
    }
  }
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
