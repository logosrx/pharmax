output "dashboard_name" {
  value = aws_cloudwatch_dashboard.this.dashboard_name
}

output "alarm_names" {
  value = concat(
    [
      aws_cloudwatch_metric_alarm.rds_cpu_high.alarm_name,
      aws_cloudwatch_metric_alarm.rds_storage_low.alarm_name,
      aws_cloudwatch_metric_alarm.rds_replica_lag.alarm_name,
      aws_cloudwatch_metric_alarm.rds_connections_high.alarm_name,
      aws_cloudwatch_metric_alarm.alb_5xx_rate.alarm_name,
      aws_cloudwatch_metric_alarm.alb_target_response_p99.alarm_name,
      aws_cloudwatch_metric_alarm.audit_chain_integrity_failure.alarm_name
    ],
    [for a in aws_cloudwatch_metric_alarm.ecs_cpu_high : a.alarm_name],
    [for a in aws_cloudwatch_metric_alarm.ecs_memory_high : a.alarm_name],
    [for a in aws_cloudwatch_metric_alarm.ecs_running_count_low : a.alarm_name]
  )
}
