output "deploy_role_arn" {
  description = "ARN of the GitHub Actions deploy role. Set this as the repo/Environment variable AWS_DEPLOY_ROLE_ARN."
  value       = aws_iam_role.deploy.arn
}

output "oidc_provider_arn" {
  description = "ARN of the GitHub OIDC provider in use (created here or passed in)."
  value       = local.oidc_provider_arn
}

output "schema_check_role_arn" {
  description = "ARN of the read-only schema-drift checker role. Set this as the repo variable AWS_SCHEMA_CHECK_ROLE_ARN."
  value       = try(aws_iam_role.schema_check[0].arn, null)
}
