output "apply_role_arn" {
  description = "ARN of the terraform-apply role. Set as the AWS_APPLY_ROLE_ARN_PROD (or _STAGING) repository variable in GitHub."
  value       = aws_iam_role.terraform_apply.arn
}

output "plan_role_arn" {
  description = "ARN of the read-only terraform-plan role. Set as the AWS_PLAN_ROLE_ARN_PROD (or _STAGING) repository variable in GitHub — the terraform-apply workflow's plan job assumes it."
  value       = aws_iam_role.terraform_plan.arn
}

output "oidc_provider_arn" {
  description = "ARN of the GitHub OIDC provider in use (created here or passed in)."
  value       = local.oidc_provider_arn
}
