output "secret_arns" {
  description = "Map of logical-name -> Secrets Manager ARN."
  value       = { for k, s in aws_secretsmanager_secret.this : k => s.arn }
}

output "database_password_secret_arn" {
  description = "Convenience output: ARN of the database master password secret."
  value       = aws_secretsmanager_secret.this["database-password"].arn
}

output "database_url_secret_arn" {
  description = "Convenience output: ARN of the DATABASE_URL secret."
  value       = aws_secretsmanager_secret.this["database-url"].arn
}
