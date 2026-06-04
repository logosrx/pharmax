output "deploy_role_arn" {
  description = "ARN of the GitHub Actions deploy role. Set this as the repo/Environment variable AWS_DEPLOY_ROLE_ARN."
  value       = aws_iam_role.deploy.arn
}

output "oidc_provider_arn" {
  description = "ARN of the GitHub OIDC provider in use (created here or passed in)."
  value       = local.oidc_provider_arn
}
