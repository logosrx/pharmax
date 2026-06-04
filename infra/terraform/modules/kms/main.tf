# =============================================================================
# KMS module — eight customer-managed keys.
#
# Why eight separate keys (not one):
#   - Blast radius. Compromise of (say) the logs key does not leak PHI.
#   - Auditability. CloudTrail "Decrypt" entries on the data key SHOULD only
#     appear for ECS task roles doing PHI work; mixing with logs traffic
#     makes that signal useless.
#   - Lifecycle. The documents key rotates differently from the secrets key
#     (which is tied to manual secret rotations).
#   - Separation of usage. AWS KMS forbids mixing key usages on a single
#     key — the symmetric data key (ENCRYPT_DECRYPT), the HMAC search key
#     (GENERATE_VERIFY_MAC), and the asymmetric audit-signing key (SIGN_VERIFY)
#     MUST be distinct keys.
#
# All keys have an alias and a tight resource policy that grants account
# root the ability to administer (so the operator can manage the key) and
# explicit service principals where required (CloudWatch Logs, S3, RDS).
# Application-level grants (kms:GenerateDataKey / Decrypt / GenerateMac /
# Sign) are attached separately by the iam module via aws_iam_role_policy
# resources, NOT via the key resource policy — this keeps the key policies
# stable across task-role churn and keeps the principal enumeration narrow
# (no Principal: *).
#
# Rotation:
#   - Symmetric ENCRYPT_DECRYPT keys (rds, secrets, data, audit_archive,
#     documents, logs): annual automatic rotation.
#   - HMAC keys (search): NOT auto-rotatable by AWS; app-level re-key.
#   - Asymmetric SIGN_VERIFY keys (asymm_sign): NOT rotatable by AWS;
#     application-level rotation procedure documented in the runbook.
#
# Reference: ADR 0023 (AwsKmsAdapter), ADR 0024 (Merkle-root signing),
# `docs/security/encryption-overview.md`, `docs/security/secrets-management.md`.
# =============================================================================

# ----- shared key-policy doc generators --------------------------------------
# Every key starts with the same shell policy: account root can administer
# (with strict KMS via-service condition where applicable). Service-principal
# grants are layered on a per-key basis.

data "aws_iam_policy_document" "key_admin" {
  statement {
    sid    = "EnableRootAdmin"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.aws_account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }
}

data "aws_iam_policy_document" "key_admin_with_logs" {
  source_policy_documents = [data.aws_iam_policy_document.key_admin.json]

  statement {
    sid    = "AllowCloudWatchLogsUse"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["logs.amazonaws.com"]
    }

    actions = [
      "kms:Encrypt*",
      "kms:Decrypt*",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:Describe*",
    ]
    resources = ["*"]

    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:*:${var.aws_account_id}:*"]
    }
  }
}

# Audit-archive key: only S3 (for SSE-KMS bucket-key roundtrip) and the
# account root may interact at the service-principal layer. Worker IAM role
# gets explicit kms:GenerateDataKey + kms:Decrypt grants in the iam module.
data "aws_iam_policy_document" "key_admin_with_s3_audit" {
  source_policy_documents = [data.aws_iam_policy_document.key_admin.json]

  statement {
    sid    = "AllowS3ServiceForAuditArchive"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }

    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.aws_account_id]
    }
  }
}

# ---- 1. RDS storage key ------------------------------------------------------

resource "aws_kms_key" "rds" {
  description             = "Pharmax RDS storage encryption (${var.name_prefix})"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.key_admin.json

  tags = merge(var.tags, {
    Purpose            = "rds-storage"
    DataClassification = "phi"
  })
}

resource "aws_kms_alias" "rds" {
  name          = "alias/${var.name_prefix}-rds"
  target_key_id = aws_kms_key.rds.id
}

# ---- 2. Documents bucket SSE-KMS key ----------------------------------------

resource "aws_kms_key" "documents" {
  description             = "Pharmax S3 documents SSE-KMS (${var.name_prefix})"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.key_admin.json

  tags = merge(var.tags, {
    Purpose            = "s3-documents-sse-kms"
    DataClassification = "phi"
  })
}

resource "aws_kms_alias" "documents" {
  name          = "alias/${var.name_prefix}-documents"
  target_key_id = aws_kms_key.documents.id
}

# Backward-compatibility alias name (`<prefix>-s3`) — pre-existing references
# will still resolve. Safe to remove once no consumer references the old name.
resource "aws_kms_alias" "documents_legacy_s3" {
  name          = "alias/${var.name_prefix}-s3"
  target_key_id = aws_kms_key.documents.id
}

# ---- 3. Audit-archive bucket SSE-KMS key ------------------------------------
#
# Distinct from the documents key because:
#   - The audit-archive bucket holds SIGNED MERKLE ROOTS (PHI-free per
#     ADR 0024) under Object Lock COMPLIANCE.
#   - Worker IAM gets WRITE access here but never to documents (and vice
#     versa for web). Splitting the keys lets us audit kms:Decrypt on each
#     key in CloudTrail with a clear "who decrypted what".
#   - Key compromise on documents must not retroactively re-encrypt audit
#     archive objects with a known-bad key.

resource "aws_kms_key" "audit_archive" {
  description             = "Pharmax S3 audit-archive SSE-KMS (${var.name_prefix}) — Object Lock COMPLIANCE bucket"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.key_admin_with_s3_audit.json

  tags = merge(var.tags, {
    Purpose   = "s3-audit-archive-sse-kms"
    Immutable = "object-lock-compliance"
  })
}

resource "aws_kms_alias" "audit_archive" {
  name          = "alias/${var.name_prefix}-audit-archive"
  target_key_id = aws_kms_key.audit_archive.id
}

# ---- 4. Secrets Manager key -------------------------------------------------

resource "aws_kms_key" "secrets" {
  description             = "Pharmax Secrets Manager (${var.name_prefix})"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.key_admin.json

  tags = merge(var.tags, {
    Purpose = "secrets-manager"
  })
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/${var.name_prefix}-secrets"
  target_key_id = aws_kms_key.secrets.id
}

# ---- 5. Data (PHI envelope) key ---------------------------------------------
#
# This is THE key the `AwsKmsAdapter` in `packages/crypto/aws-kms-adapter.ts`
# calls via `kms:GenerateDataKey` to mint per-field DEKs and `kms:Decrypt` to
# unwrap them on read. ECS task roles (web + worker + print-agent) get
# narrowly-scoped permissions to this exact key in the iam module.
#
# Reference: ADR 0023 — AwsKmsAdapter for production PHI envelope encryption.

resource "aws_kms_key" "data" {
  description             = "Pharmax PHI envelope encryption (${var.name_prefix}) — AwsKmsAdapter data key"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.key_admin.json

  tags = merge(var.tags, {
    Purpose            = "app-phi-envelope-data-key"
    DataClassification = "phi"
    HipaaScope         = "in-scope"
  })
}

resource "aws_kms_alias" "data" {
  name          = "alias/${var.name_prefix}-data"
  target_key_id = aws_kms_key.data.id
}

# Backward-compatibility alias for the old `app-phi` name; existing env vars
# (`AWS_KMS_APP_KEY_ID = alias/<prefix>-app-phi`) keep resolving without a
# code change.
resource "aws_kms_alias" "data_legacy_app_phi" {
  name          = "alias/${var.name_prefix}-app-phi"
  target_key_id = aws_kms_key.data.id
}

# ---- 6. Search (blind-index HMAC) key ---------------------------------------
#
# The HMAC primitive backing `deriveSearchKey` in
# `packages/crypto/aws-kms-adapter.ts`. AWS KMS GENERATE_VERIFY_MAC keys
# (HMAC_256 spec) are a distinct usage class from ENCRYPT_DECRYPT keys —
# AWS will reject `kms:GenerateMac` against a regular symmetric key.
#
# Reference: ADR 0023 — search key under HKDF/HMAC-SHA-256 semantics.

resource "aws_kms_key" "search" {
  description              = "Pharmax blind-index HMAC (${var.name_prefix}) — AwsKmsAdapter search key"
  deletion_window_in_days  = 30
  key_usage                = "GENERATE_VERIFY_MAC"
  customer_master_key_spec = "HMAC_256"
  # NOTE: AWS KMS does NOT support automatic rotation for HMAC keys
  # (EnableKeyRotation → UnsupportedOperationException). Rotation is the
  # application-level re-key procedure documented in the runbook.
  policy = data.aws_iam_policy_document.key_admin.json

  tags = merge(var.tags, {
    Purpose            = "app-phi-blind-index-search-key"
    DataClassification = "phi"
    HipaaScope         = "in-scope"
  })
}

resource "aws_kms_alias" "search" {
  name          = "alias/${var.name_prefix}-search"
  target_key_id = aws_kms_key.search.id
}

# ---- 7. Asymmetric Merkle-root signing key ----------------------------------
#
# `MerkleRootSigner` (`packages/security/src/merkle/sign-merkle-root.ts`)
# signs daily per-tenant Merkle roots so an auditor can verify the chain
# without trusting the application or its DB. The application has
# `kms:Sign` ONLY — never `kms:Decrypt` or anything that could be used to
# forge new manifests.
#
# `key_usage = SIGN_VERIFY`. Asymmetric KMS keys are NOT rotatable by AWS
# (rotation = generate a new key and re-key); rotation procedure is in
# `docs/RUNBOOK.md` § Rotating the Merkle-signing key.
#
# Reference: ADR 0024 — Daily Merkle root signing and evidence.

resource "aws_kms_key" "asymm_sign" {
  description              = "Pharmax Merkle-root signing (${var.name_prefix}) — daily audit manifest signature"
  deletion_window_in_days  = 30
  key_usage                = "SIGN_VERIFY"
  customer_master_key_spec = var.asymm_sign_key_spec
  policy                   = data.aws_iam_policy_document.key_admin.json
  # NOTE: enable_key_rotation cannot be set on asymmetric keys.

  tags = merge(var.tags, {
    Purpose    = "audit-merkle-root-signing"
    Immutable  = "evidence"
    HipaaScope = "in-scope"
  })
}

resource "aws_kms_alias" "asymm_sign" {
  name          = "alias/${var.name_prefix}-asymm-sign"
  target_key_id = aws_kms_key.asymm_sign.id
}

# ---- 8. CloudWatch Logs key -------------------------------------------------
#
# Encrypts every CloudWatch Log Group across the stack (VPC flow logs,
# ECS container logs, RDS exports). CloudWatch needs the explicit
# service-principal grant to write encrypted entries.

resource "aws_kms_key" "logs" {
  description             = "Pharmax CloudWatch Logs (${var.name_prefix})"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.key_admin_with_logs.json

  tags = merge(var.tags, {
    Purpose = "cloudwatch-logs"
  })
}

resource "aws_kms_alias" "logs" {
  name          = "alias/${var.name_prefix}-logs"
  target_key_id = aws_kms_key.logs.id
}
