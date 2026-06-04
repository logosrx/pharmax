output "primary_endpoint_address" {
  description = "Primary (write) endpoint host. Use in REDIS_URL: rediss://:<auth_token>@<this>:<port>."
  value       = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "reader_endpoint_address" {
  description = "Reader endpoint host (load-balances across replicas). Empty when replica_count = 0."
  value       = aws_elasticache_replication_group.this.reader_endpoint_address
}

output "port" {
  description = "Redis port."
  value       = aws_elasticache_replication_group.this.port
}

output "replication_group_id" {
  description = "ElastiCache replication group id."
  value       = aws_elasticache_replication_group.this.id
}

output "security_group_id" {
  description = "Security group id fronting the Redis nodes."
  value       = aws_security_group.this.id
}

output "auth_token_secret_arn" {
  description = "ARN of the Secrets Manager secret holding the Redis AUTH token. Read it to assemble REDIS_URL."
  value       = aws_secretsmanager_secret.auth_token.arn
}
