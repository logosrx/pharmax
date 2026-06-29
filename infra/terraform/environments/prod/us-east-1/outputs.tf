output "vpc_id" { value = module.stack.vpc_id }
output "alb_dns_name" { value = module.stack.alb_dns_name }
output "alb_zone_id" { value = module.stack.alb_zone_id }

output "rds_endpoint" {
  value     = module.stack.rds_endpoint
  sensitive = true
}
output "rds_reader_endpoint" {
  value     = module.stack.rds_reader_endpoint
  sensitive = true
}
output "rds_port" { value = module.stack.rds_port }

output "ecr_web_repository_url" { value = module.stack.ecr_web_repository_url }
output "ecr_worker_repository_url" { value = module.stack.ecr_worker_repository_url }
output "ecr_print_agent_repository_url" { value = module.stack.ecr_print_agent_repository_url }
output "ecs_cluster_name" { value = module.stack.ecs_cluster_name }

output "kms_data_key_arn" { value = module.stack.kms_data_key_arn }
output "kms_data_key_alias" { value = module.stack.kms_data_key_alias }
output "kms_search_key_arn" { value = module.stack.kms_search_key_arn }
output "kms_search_key_alias" { value = module.stack.kms_search_key_alias }
output "kms_asymm_sign_key_arn" { value = module.stack.kms_asymm_sign_key_arn }
output "kms_asymm_sign_key_alias" { value = module.stack.kms_asymm_sign_key_alias }
output "kms_audit_archive_key_arn" { value = module.stack.kms_audit_archive_key_arn }
output "kms_audit_archive_key_alias" { value = module.stack.kms_audit_archive_key_alias }
output "kms_rds_key_arn" { value = module.stack.kms_rds_key_arn }
output "kms_documents_key_arn" { value = module.stack.kms_documents_key_arn }
output "kms_secrets_key_arn" { value = module.stack.kms_secrets_key_arn }
output "kms_logs_key_arn" { value = module.stack.kms_logs_key_arn }

output "s3_documents_bucket_name" { value = module.stack.s3_documents_bucket_name }
output "s3_audit_archive_bucket_name" { value = module.stack.s3_audit_archive_bucket_name }

output "secret_arns" { value = module.stack.secret_arns }
output "database_password_secret_arn" {
  value     = module.stack.database_password_secret_arn
  sensitive = true
}

output "ecs_task_role_web_arn" { value = module.stack.ecs_task_role_web_arn }
output "ecs_task_role_worker_arn" { value = module.stack.ecs_task_role_worker_arn }
output "ecs_task_role_print_agent_arn" { value = module.stack.ecs_task_role_print_agent_arn }

# ---- CloudFront -------------------------------------------------------------
output "cloudfront_distribution_domain_name" { value = module.stack.cloudfront_distribution_domain_name }
output "cloudfront_distribution_id" { value = module.stack.cloudfront_distribution_id }
output "cloudfront_distribution_hosted_zone_id" { value = module.stack.cloudfront_distribution_hosted_zone_id }

# ---- ElastiCache ------------------------------------------------------------
output "redis_primary_endpoint_address" { value = module.stack.redis_primary_endpoint_address }
output "redis_reader_endpoint_address" { value = module.stack.redis_reader_endpoint_address }
output "redis_port" { value = module.stack.redis_port }
output "redis_auth_token_secret_arn" {
  value     = module.stack.redis_auth_token_secret_arn
  sensitive = true
}

# ---- CI/CD deploy role ------------------------------------------------------
output "cicd_deploy_role_arn" { value = module.stack.cicd_deploy_role_arn }
output "cicd_github_oidc_provider_arn" { value = module.stack.cicd_github_oidc_provider_arn }

# ---- Terraform-apply role ----------------------------------------------------
output "terraform_apply_role_arn" { value = module.stack.terraform_apply_role_arn }

# ---- Aurora Global Database -------------------------------------------------
output "rds_cluster_arn" { value = module.stack.rds_cluster_arn }
output "rds_global_cluster_id" { value = module.stack.rds_global_cluster_id }
output "rds_master_password" {
  value     = module.stack.rds_master_password
  sensitive = true
}
