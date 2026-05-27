# =============================================================================
# Pharmax — root outputs.
#
# These are the values external tooling needs:
#   - Deploy scripts (image tag updates, ECS service deploys).
#   - On-call runbooks (RDS endpoint, KMS aliases for break-glass).
#   - The AwsKmsAdapter wiring step (`AWS_KMS_DATA_KEY_ID`,
#     `AWS_KMS_SEARCH_KEY_ID`, `AWS_KMS_AUDIT_SIGN_KEY_ID`).
#   - Worker initialization (`AUDIT_ARCHIVE_BUCKET`).
#   - Compliance evidence (KMS ARNs the auditor scopes their CloudTrail
#     queries against).
#
# Everything else stays internal to the modules.
# =============================================================================

output "vpc_id" {
  description = "Primary VPC id."
  value       = module.network.vpc_id
}

output "alb_dns_name" {
  description = "DNS name of the ALB. Point your Route53 A-ALIAS record at this."
  value       = module.alb.alb_dns_name
}

output "alb_zone_id" {
  description = "Route53 zone id for the ALB (used for A-ALIAS records)."
  value       = module.alb.alb_zone_id
}

output "rds_endpoint" {
  description = "RDS primary endpoint. PHI-bearing — never bake into a client bundle."
  value       = module.rds.endpoint
  sensitive   = true
}

output "rds_reader_endpoint" {
  description = "RDS reader endpoint (only useful once a read replica is added)."
  value       = module.rds.reader_endpoint
  sensitive   = true
}

output "rds_port" {
  description = "RDS port (5432 for Postgres)."
  value       = module.rds.port
}

output "ecr_web_repository_url" {
  description = "ECR repository url for the web image."
  value       = module.ecr.web_repository_url
}

output "ecr_worker_repository_url" {
  description = "ECR repository url for the worker image."
  value       = module.ecr.worker_repository_url
}

output "ecr_print_agent_repository_url" {
  description = "ECR repository url for the print-agent image."
  value       = module.ecr.print_agent_repository_url
}

output "ecs_cluster_name" {
  description = "ECS cluster name (also the Container Insights namespace)."
  value       = module.ecs.cluster_name
}

# ---- KMS keys ---------------------------------------------------------------
# These are the values the apps need at runtime.

output "kms_data_key_arn" {
  description = "ARN of the data CMK — `kms:GenerateDataKey` / `kms:Decrypt` target for AwsKmsAdapter."
  value       = module.kms.data_key_arn
}

output "kms_data_key_alias" {
  description = "Alias of the data CMK. Set AWS_KMS_DATA_KEY_ID to this so KMS rotation does not require an env-var change."
  value       = module.kms.data_key_alias
}

output "kms_search_key_arn" {
  description = "ARN of the GENERATE_VERIFY_MAC HMAC_256 search CMK."
  value       = module.kms.search_key_arn
}

output "kms_search_key_alias" {
  description = "Alias of the search CMK. Set AWS_KMS_SEARCH_KEY_ID to this."
  value       = module.kms.search_key_alias
}

output "kms_asymm_sign_key_arn" {
  description = "ARN of the asymmetric SIGN_VERIFY CMK used by the daily Merkle-root signer."
  value       = module.kms.asymm_sign_key_arn
}

output "kms_asymm_sign_key_alias" {
  description = "Alias of the Merkle-root signing CMK. Set AWS_KMS_AUDIT_SIGN_KEY_ID to this."
  value       = module.kms.asymm_sign_key_alias
}

output "kms_audit_archive_key_arn" {
  description = "ARN of the audit-archive bucket SSE-KMS CMK."
  value       = module.kms.audit_archive_key_arn
}

output "kms_audit_archive_key_alias" {
  description = "Alias of the audit-archive CMK."
  value       = module.kms.audit_archive_key_alias
}

output "kms_rds_key_arn" {
  description = "ARN of the KMS key used for RDS storage encryption."
  value       = module.kms.rds_key_arn
}

output "kms_documents_key_arn" {
  description = "ARN of the KMS key used for the documents S3 bucket SSE-KMS."
  value       = module.kms.documents_key_arn
}

output "kms_secrets_key_arn" {
  description = "ARN of the KMS key used for Secrets Manager."
  value       = module.kms.secrets_key_arn
}

output "kms_logs_key_arn" {
  description = "ARN of the KMS key used for CloudWatch Logs encryption."
  value       = module.kms.logs_key_arn
}

# Deprecated alias outputs — preserved so existing tooling that grepped for
# `app_phi` / `s3_key` keeps resolving until callers migrate.

output "kms_app_phi_key_arn" {
  description = "DEPRECATED — use kms_data_key_arn."
  value       = module.kms.data_key_arn
}

output "kms_app_phi_key_alias" {
  description = "DEPRECATED — use kms_data_key_alias."
  value       = module.kms.data_key_alias
}

output "kms_s3_key_arn" {
  description = "DEPRECATED — use kms_documents_key_arn."
  value       = module.kms.documents_key_arn
}

# ---- S3 ---------------------------------------------------------------------

output "s3_documents_bucket_name" {
  description = "Bucket name for prescription documents / labels."
  value       = module.s3_documents.bucket_name
}

output "s3_documents_bucket_arn" {
  description = "Bucket ARN for prescription documents / labels."
  value       = module.s3_documents.bucket_arn
}

output "s3_audit_archive_bucket_name" {
  description = "Bucket name for the Merkle audit archive (Object Lock COMPLIANCE, retention configured by `audit_archive_retention_years`)."
  value       = module.s3_audit_archive.bucket_name
}

output "s3_audit_archive_bucket_arn" {
  description = "Bucket ARN for the Merkle audit archive."
  value       = module.s3_audit_archive.bucket_arn
}

# ---- Secrets Manager --------------------------------------------------------

output "secret_arns" {
  description = "Map of logical-name -> Secrets Manager ARN, for each managed secret."
  value       = module.secrets.secret_arns
}

output "database_password_secret_arn" {
  description = "ARN of the secret holding the RDS master password. Rotate via Secrets Manager rotation."
  value       = module.secrets.database_password_secret_arn
  sensitive   = true
}

# ---- IAM --------------------------------------------------------------------

output "ecs_task_role_web_arn" {
  description = "Task role used by the web ECS service."
  value       = module.iam.task_role_web_arn
}

output "ecs_task_role_worker_arn" {
  description = "Task role used by the worker ECS service."
  value       = module.iam.task_role_worker_arn
}

output "ecs_task_role_print_agent_arn" {
  description = "Task role used by the print-agent ECS service."
  value       = module.iam.task_role_print_agent_arn
}
