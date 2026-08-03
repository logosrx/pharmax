locals {
  critical_alarm_names = concat(
    [
      aws_cloudwatch_metric_alarm.rds_freeable_memory_low.alarm_name,
      aws_cloudwatch_metric_alarm.rds_connections_high.alarm_name,
      aws_cloudwatch_metric_alarm.alb_5xx_rate.alarm_name,
      aws_cloudwatch_metric_alarm.audit_chain_integrity_failure.alarm_name,
    ],
    [for a in aws_cloudwatch_metric_alarm.ecs_running_count_low : a.alarm_name]
  )

  warning_alarm_names = concat(
    [
      aws_cloudwatch_metric_alarm.rds_cpu_high.alarm_name,
      aws_cloudwatch_metric_alarm.rds_replica_lag.alarm_name,
      aws_cloudwatch_metric_alarm.alb_target_response_p99.alarm_name,
    ],
    [for a in aws_cloudwatch_metric_alarm.ecs_cpu_high : a.alarm_name],
    [for a in aws_cloudwatch_metric_alarm.ecs_memory_high : a.alarm_name],
    [for a in aws_cloudwatch_metric_alarm.ecs_print_agent_running_low : a.alarm_name]
  )
}

output "dashboard_name" {
  value = aws_cloudwatch_dashboard.this.dashboard_name
}

output "critical_alarm_names" {
  description = "Alarms routed to the paging topic. Cross-check against docs/runbooks/alerting.md § Critical tier."
  value       = local.critical_alarm_names
}

output "warning_alarm_names" {
  description = "Alarms routed to the warning topic (ticket / shift mailbox)."
  value       = local.warning_alarm_names
}

output "alarm_names" {
  description = "Every alarm this module creates, both tiers."
  value       = concat(local.critical_alarm_names, local.warning_alarm_names)
}
