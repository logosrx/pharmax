# =============================================================================
# KMS module outputs.
#
# Naming convention:
#   - `<purpose>_key_arn`   — full ARN of the CMK
#   - `<purpose>_key_alias` — alias name (preferred for env-var injection so a
#                             rotation event doesn't change the value seen by
#                             the application)
#
# Backward-compatibility outputs (`s3_*`, `app_phi_*`) are emitted so
# pre-existing root-output / iam-module references resolve unchanged.
# =============================================================================

# ---- RDS --------------------------------------------------------------------

output "rds_key_arn" {
  description = "ARN of the CMK used for RDS storage encryption."
  value       = aws_kms_key.rds.arn
}

output "rds_key_alias" {
  description = "Alias of the RDS storage CMK."
  value       = aws_kms_alias.rds.name
}

# ---- Documents bucket -------------------------------------------------------

output "documents_key_arn" {
  description = "ARN of the CMK used for the documents S3 bucket SSE-KMS."
  value       = aws_kms_key.documents.arn
}

output "documents_key_alias" {
  description = "Alias of the documents-bucket CMK."
  value       = aws_kms_alias.documents.name
}

output "s3_key_arn" {
  description = "DEPRECATED — alias for documents_key_arn. Pre-existing references resolve unchanged."
  value       = aws_kms_key.documents.arn
}

output "s3_key_alias" {
  description = "DEPRECATED — alias for documents_key_alias."
  value       = aws_kms_alias.documents.name
}

# ---- Audit-archive bucket ---------------------------------------------------

output "audit_archive_key_arn" {
  description = "ARN of the CMK used by the Object-Lock COMPLIANCE audit archive bucket. Distinct from the documents bucket key."
  value       = aws_kms_key.audit_archive.arn
}

output "audit_archive_key_alias" {
  description = "Alias of the audit-archive CMK."
  value       = aws_kms_alias.audit_archive.name
}

# ---- Secrets Manager --------------------------------------------------------

output "secrets_key_arn" {
  description = "ARN of the CMK used for Secrets Manager encryption."
  value       = aws_kms_key.secrets.arn
}

output "secrets_key_alias" {
  description = "Alias of the Secrets Manager CMK."
  value       = aws_kms_alias.secrets.name
}

# ---- PHI envelope (data) ----------------------------------------------------

output "data_key_arn" {
  description = "ARN of the data CMK — target of `kms:GenerateDataKey` / `kms:Decrypt` from AwsKmsAdapter."
  value       = aws_kms_key.data.arn
}

output "data_key_alias" {
  description = "Alias of the data CMK. Configure AWS_KMS_DATA_KEY_ID with this alias so rotation does not require an env-var change."
  value       = aws_kms_alias.data.name
}

output "app_phi_key_arn" {
  description = "DEPRECATED — alias for data_key_arn. Pre-existing references resolve unchanged."
  value       = aws_kms_key.data.arn
}

output "app_phi_key_alias" {
  description = "DEPRECATED — alias for data_key_alias."
  value       = aws_kms_alias.data.name
}

# ---- Search (HMAC blind index) ----------------------------------------------

output "search_key_arn" {
  description = "ARN of the GENERATE_VERIFY_MAC HMAC_256 search CMK — target of `kms:GenerateMac` from AwsKmsAdapter."
  value       = aws_kms_key.search.arn
}

output "search_key_alias" {
  description = "Alias of the search CMK. Configure AWS_KMS_SEARCH_KEY_ID with this alias."
  value       = aws_kms_alias.search.name
}

# ---- Asymmetric Merkle-root signing -----------------------------------------

output "asymm_sign_key_arn" {
  description = "ARN of the SIGN_VERIFY asymmetric CMK used by the daily Merkle-root signer."
  value       = aws_kms_key.asymm_sign.arn
}

output "asymm_sign_key_alias" {
  description = "Alias of the Merkle-root signing CMK."
  value       = aws_kms_alias.asymm_sign.name
}

# ---- CloudWatch Logs --------------------------------------------------------

output "logs_key_arn" {
  description = "ARN of the CMK used for CloudWatch Logs encryption."
  value       = aws_kms_key.logs.arn
}

output "logs_key_alias" {
  description = "Alias of the CloudWatch Logs CMK."
  value       = aws_kms_alias.logs.name
}
