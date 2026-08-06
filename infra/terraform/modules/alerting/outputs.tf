output "critical_topic_arn" {
  description = "ARN of the CRITICAL (paging) topic. Feed to the cloudwatch module's critical_alarm_sns_topic_arn."
  value       = aws_sns_topic.critical.arn
}

output "warning_topic_arn" {
  description = "ARN of the warning (ticket / mailbox) topic. Feed to the cloudwatch module's warning_alarm_sns_topic_arn."
  value       = aws_sns_topic.warning.arn
}

output "critical_topic_name" {
  description = "Name of the CRITICAL topic (for console lookup and the runbook)."
  value       = aws_sns_topic.critical.name
}

output "warning_topic_name" {
  description = "Name of the warning topic."
  value       = aws_sns_topic.warning.name
}

output "critical_subscription_count" {
  description = "How many endpoints are subscribed to the CRITICAL topic. Zero means alarms page nobody — see the check block in main.tf."
  value       = length(var.critical_email_subscriptions) + length(var.critical_https_subscriptions)
}

output "warning_subscription_count" {
  description = "How many endpoints are subscribed to the warning topic."
  value       = length(var.warning_email_subscriptions) + length(var.warning_https_subscriptions)
}
