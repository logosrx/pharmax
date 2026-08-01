output "role_arn" {
  description = "ARN of the read-only restore-drill preflight role. Set as the AWS_DRILL_ROLE_ARN repository variable in GitHub."
  value       = aws_iam_role.drill_preflight.arn
}

output "role_name" {
  description = "Name of the read-only restore-drill preflight role."
  value       = aws_iam_role.drill_preflight.name
}

output "oidc_provider_arn" {
  description = "ARN of the GitHub OIDC provider in use (created here or passed in)."
  value       = local.oidc_provider_arn
}
