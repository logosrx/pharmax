output "instance_arn" {
  description = "ARN of the IAM Identity Center instance in use."
  value       = local.instance_arn
}

output "identity_store_id" {
  description = "Identity store id backing the Identity Center instance."
  value       = local.identity_store_id
}

output "permission_set_arns" {
  description = "Map of permission-set short name → ARN."
  value       = { for name, ps in aws_ssoadmin_permission_set.this : name => ps.arn }
}
