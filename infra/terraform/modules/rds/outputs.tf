output "cluster_id" {
  description = "Aurora cluster identifier (the DBClusterIdentifier CloudWatch dimension)."
  value       = aws_rds_cluster.this.cluster_identifier
}

output "cluster_arn" {
  value = aws_rds_cluster.this.arn
}

output "endpoint" {
  description = "Writer (primary) endpoint. PHI-bearing — never bake into a client bundle."
  value       = aws_rds_cluster.this.endpoint
}

output "reader_endpoint" {
  description = "Reader endpoint — load-balances across reader instances. Source for REPORTING_DATABASE_URL. Falls back to the writer when reader_count = 0."
  value       = aws_rds_cluster.this.reader_endpoint
}

output "port" {
  value = aws_rds_cluster.this.port
}

output "security_group_id" {
  value = aws_security_group.rds.id
}

output "writer_instance_id" {
  description = "Identifier of the writer instance (index 0) — the DBInstanceIdentifier CloudWatch dimension for CPU/memory/connections."
  value       = aws_rds_cluster_instance.this[0].identifier
}

output "instance_ids" {
  description = "All cluster instance identifiers (writer first, then readers)."
  value       = [for i in aws_rds_cluster_instance.this : i.identifier]
}

output "has_reader" {
  description = "True when at least one reader instance exists (real reader endpoint available)."
  value       = var.reader_count > 0
}

output "managed_master_user_secret_arn" {
  description = "ARN of the AWS-managed master-user secret (created by manage_master_user_password). Read this to assemble DATABASE_URL."
  value       = try(aws_rds_cluster.this.master_user_secret[0].secret_arn, null)
}

output "cluster_parameter_group_name" {
  value = aws_rds_cluster_parameter_group.this.name
}

output "global_cluster_id" {
  description = "Aurora Global Database cluster identifier (set only when global_cluster_role = primary). Feed this to the secondary stack's rds_global_cluster_identifier."
  value       = try(aws_rds_global_cluster.this[0].id, null)
}

output "master_password" {
  description = "Generated master password for a global-PRIMARY cluster (null for standalone, which uses the managed secret, and for secondary, which inherits). Use to assemble DATABASE_URL."
  value       = try(random_password.master[0].result, null)
  sensitive   = true
}
