output "cloudtrail_arn" {
  description = "ARN of the CloudTrail trail (null when disabled)."
  value       = try(aws_cloudtrail.this[0].arn, null)
}

output "cloudtrail_bucket_name" {
  description = "Name of the CloudTrail log bucket (null when disabled)."
  value       = try(aws_s3_bucket.cloudtrail[0].id, null)
}

output "cloudtrail_kms_key_arn" {
  description = "ARN of the CloudTrail log-encryption CMK (null when disabled)."
  value       = try(aws_kms_key.cloudtrail[0].arn, null)
}

output "config_bucket_name" {
  description = "Name of the AWS Config delivery bucket (null when disabled)."
  value       = try(aws_s3_bucket.config[0].id, null)
}

output "config_recorder_name" {
  description = "Name of the AWS Config configuration recorder (null when disabled)."
  value       = try(aws_config_configuration_recorder.this[0].name, null)
}

output "guardduty_detector_id" {
  description = "GuardDuty detector id (null when disabled)."
  value       = try(aws_guardduty_detector.this[0].id, null)
}

output "securityhub_account_id" {
  description = "Security Hub account resource id (null when disabled)."
  value       = try(aws_securityhub_account.this[0].id, null)
}
