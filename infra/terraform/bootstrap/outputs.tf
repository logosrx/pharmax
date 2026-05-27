output "state_bucket_name" {
  description = "Name of the S3 bucket holding Terraform state. Plug this into each env-region's backend.tf as `bucket = `."
  value       = aws_s3_bucket.state.id
}

output "state_bucket_arn" {
  description = "ARN of the state bucket."
  value       = aws_s3_bucket.state.arn
}

output "lock_table_name" {
  description = "Name of the DynamoDB lock table. Plug into each backend.tf as `dynamodb_table = `."
  value       = aws_dynamodb_table.lock.name
}

output "state_kms_key_arn" {
  description = "ARN of the CMK encrypting state. Plug into each backend.tf as `kms_key_id = `."
  value       = aws_kms_key.state.arn
}

output "state_kms_key_alias" {
  description = "Alias of the state CMK."
  value       = aws_kms_alias.state.name
}
