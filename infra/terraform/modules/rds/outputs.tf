output "instance_id" {
  value = aws_db_instance.this.id
}

output "instance_arn" {
  value = aws_db_instance.this.arn
}

output "endpoint" {
  value = aws_db_instance.this.address
}

output "reader_endpoint" {
  description = "Reader endpoint. Only meaningful once a read replica is added."
  value       = aws_db_instance.this.address
}

output "port" {
  value = aws_db_instance.this.port
}

output "security_group_id" {
  value = aws_security_group.rds.id
}

output "managed_master_user_secret_arn" {
  description = "ARN of the AWS-managed master-user secret (created by manage_master_user_password)."
  value       = try(aws_db_instance.this.master_user_secret[0].secret_arn, null)
}

output "parameter_group_name" {
  value = aws_db_parameter_group.this.name
}
