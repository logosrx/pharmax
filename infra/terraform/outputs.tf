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

output "rds_cluster_id" {
  description = "Aurora cluster identifier. Used by runbooks and the CloudWatch DBClusterIdentifier dimension."
  value       = module.rds.cluster_id
}

output "rds_cluster_arn" {
  description = "Aurora cluster ARN. On the global PRIMARY stack, feed this to the secondary stack's rds_replication_source_identifier."
  value       = module.rds.cluster_arn
}

output "rds_global_cluster_id" {
  description = "Aurora Global Database id (null unless this stack is the global primary). Feed to the secondary stack's rds_global_cluster_identifier."
  value       = module.rds.global_cluster_id
}

output "rds_master_password" {
  description = "Generated master password for the global-primary Aurora cluster (null for standalone/secondary). Use with rds_master_username + rds_endpoint to assemble DATABASE_URL."
  value       = module.rds.master_password
  sensitive   = true
}

output "rds_endpoint" {
  description = "Aurora writer endpoint. Source for DATABASE_URL / DIRECT_URL. PHI-bearing — never bake into a client bundle."
  value       = module.rds.endpoint
  sensitive   = true
}

output "rds_reader_endpoint" {
  description = "Aurora reader endpoint (load-balances across readers). Source for REPORTING_DATABASE_URL. Falls back to the writer when no reader instance exists."
  value       = module.rds.reader_endpoint
  sensitive   = true
}

output "rds_port" {
  description = "Aurora port (5432 for Postgres)."
  value       = module.rds.port
}

output "rds_managed_master_user_secret_arn" {
  description = "ARN of the AWS-managed Aurora master-user secret. Read this to assemble the DATABASE_URL secret value (see README § Assembling DATABASE_URL)."
  value       = module.rds.managed_master_user_secret_arn
  sensitive   = true
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
  description = "Alias of the Merkle-root signing CMK. Set MERKLE_SIGNER_KMS_KEY_ID to this."
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

# ---- Shield Advanced --------------------------------------------------------

output "shield_alb_protection_id" {
  description = "Shield Advanced protection id for the ALB (null unless enable_shield_advanced = true)."
  value       = module.alb.shield_protection_id
}

output "shield_cloudfront_protection_id" {
  description = "Shield Advanced protection id for the CloudFront distribution (null unless enabled)."
  value       = try(module.cloudfront[0].shield_protection_id, null)
}

# ---- Security baseline ------------------------------------------------------

output "cloudtrail_arn" {
  description = "CloudTrail trail ARN (null unless the security baseline + CloudTrail are enabled)."
  value       = try(module.security_baseline[0].cloudtrail_arn, null)
}

output "cloudtrail_bucket_name" {
  description = "CloudTrail log bucket name (null unless enabled)."
  value       = try(module.security_baseline[0].cloudtrail_bucket_name, null)
}

output "guardduty_detector_id" {
  description = "GuardDuty detector id (null unless enabled)."
  value       = try(module.security_baseline[0].guardduty_detector_id, null)
}

output "config_recorder_name" {
  description = "AWS Config recorder name (null unless enabled)."
  value       = try(module.security_baseline[0].config_recorder_name, null)
}

# ---- CloudFront -------------------------------------------------------------

output "cloudfront_distribution_domain_name" {
  description = "CloudFront edge domain (null unless enable_cloudfront = true). Point the public app DNS at this."
  value       = try(module.cloudfront[0].distribution_domain_name, null)
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution id (null unless enable_cloudfront = true). Use for cache invalidations in the deploy pipeline."
  value       = try(module.cloudfront[0].distribution_id, null)
}

output "cloudfront_distribution_hosted_zone_id" {
  description = "CloudFront hosted zone id for Route53 ALIAS records (null unless enable_cloudfront = true)."
  value       = try(module.cloudfront[0].distribution_hosted_zone_id, null)
}

# ---- ElastiCache (Redis) ----------------------------------------------------

output "redis_primary_endpoint_address" {
  description = "Redis primary endpoint host (null unless enable_elasticache = true). Use in REDIS_URL: rediss://:<auth_token>@<this>:<port>."
  value       = try(module.elasticache[0].primary_endpoint_address, null)
}

output "redis_reader_endpoint_address" {
  description = "Redis reader endpoint host (null unless enable_elasticache = true; empty when no replicas)."
  value       = try(module.elasticache[0].reader_endpoint_address, null)
}

output "redis_port" {
  description = "Redis port (null unless enable_elasticache = true)."
  value       = try(module.elasticache[0].port, null)
}

output "redis_auth_token_secret_arn" {
  description = "ARN of the Secrets Manager secret holding the Redis AUTH token (null unless enable_elasticache = true). Read it to assemble REDIS_URL."
  value       = try(module.elasticache[0].auth_token_secret_arn, null)
}

# ---- CI/CD deploy role ------------------------------------------------------

output "cicd_deploy_role_arn" {
  description = "ARN of the GitHub Actions deploy role (null unless enable_cicd_deploy_role = true). Set as the AWS_DEPLOY_ROLE_ARN repo/Environment variable."
  value       = try(module.cicd_deploy[0].deploy_role_arn, null)
}

output "cicd_github_oidc_provider_arn" {
  description = "ARN of the GitHub OIDC provider in use (null unless enable_cicd_deploy_role = true). Pass to other working directories in the same account via cicd_oidc_provider_arn."
  value       = try(module.cicd_deploy[0].oidc_provider_arn, null)
}

# ---- Terraform-apply role ---------------------------------------------------

output "terraform_apply_role_arn" {
  description = "ARN of the GitHub Actions terraform-apply role (null unless enable_terraform_apply_role = true). Set as the AWS_APPLY_ROLE_ARN_PROD (or _STAGING) repository variable."
  value       = try(module.terraform_apply_role[0].apply_role_arn, null)
}
