output "apply_role_arn" {
  description = "ARN of the terraform-apply role. Set as the AWS_APPLY_ROLE_ARN_PROD (or _STAGING) repository variable in GitHub."
  value       = aws_iam_role.terraform_apply.arn
}

output "oidc_provider_arn" {
  description = "ARN of the GitHub OIDC provider in use (created here or passed in)."
  value       = local.oidc_provider_arn
}
