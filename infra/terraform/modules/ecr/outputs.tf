output "web_repository_url" {
  value = aws_ecr_repository.this["web"].repository_url
}

output "worker_repository_url" {
  value = aws_ecr_repository.this["worker"].repository_url
}

output "print_agent_repository_url" {
  value = aws_ecr_repository.this["print-agent"].repository_url
}

output "repository_arns" {
  value = { for k, r in aws_ecr_repository.this : k => r.arn }
}
