output "instance_arn" {
  description = "ARN of the IAM Identity Center instance."
  value       = module.identity_center.instance_arn
}

output "identity_store_id" {
  description = "Identity store id backing the instance."
  value       = module.identity_center.identity_store_id
}

output "permission_set_arns" {
  description = "Map of permission-set short name → ARN."
  value       = module.identity_center.permission_set_arns
}
