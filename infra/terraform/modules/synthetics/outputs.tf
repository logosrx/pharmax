output "canary_name" {
  description = "Name of the heartbeat canary (truncated to the 21-char canary limit)."
  value       = aws_synthetics_canary.heartbeat.name
}

output "canary_arn" {
  description = "ARN of the heartbeat canary."
  value       = aws_synthetics_canary.heartbeat.arn
}

output "artifacts_bucket" {
  description = "Bucket holding canary run artifacts (HAR files, logs)."
  value       = aws_s3_bucket.artifacts.bucket
}

output "heartbeat_alarm_name" {
  description = "Name of the canary-failure alarm (critical tier)."
  value       = aws_cloudwatch_metric_alarm.heartbeat_failed.alarm_name
}

output "execution_role_arn" {
  description = "IAM role the canary Lambda executes as."
  value       = aws_iam_role.canary.arn
}
