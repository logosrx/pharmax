# =============================================================================
# CloudWatch module — alarms + dashboard.
#
# Alarm coverage (per spec; Aurora PostgreSQL metrics):
#   - Aurora writer CPU > 80%               (DBInstanceIdentifier)
#   - Aurora writer FreeableMemory low      (DBInstanceIdentifier)
#   - Aurora replica lag > threshold (ms)   (DBClusterIdentifier)
#   - Aurora writer connection count > threshold (DBInstanceIdentifier)
#   - ECS unhealthy task count > 0 (per service)
#   - ALB 5xx rate > 1%
#   - ALB target response time p99 > 2s
#   - Custom: AuditChainIntegrityFailure > 0 (nightly job emits this)
#
# Aurora has no FreeStorageSpace metric (storage auto-scales), so we watch
# FreeableMemory on the writer instead. AuroraReplicaLag is reported in
# milliseconds at the cluster level.
#
# All alarms send to a single SNS topic (parameterized). If the topic ARN
# is empty, the alarm still fires (the metric/state is visible in
# CloudWatch) but no notification is dispatched.
# =============================================================================

locals {
  alarm_actions = var.alarm_sns_topic_arn != "" ? [var.alarm_sns_topic_arn] : []
}

# ---- RDS alarms -------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "rds_cpu_high" {
  alarm_name          = "${var.name_prefix}-rds-cpu-high"
  alarm_description   = "RDS CPU exceeded ${var.rds_cpu_threshold_percent}% for 10 minutes."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = var.rds_cpu_threshold_percent
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = var.rds_instance_id
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "rds_freeable_memory_low" {
  alarm_name          = "${var.name_prefix}-rds-freeable-memory-low"
  alarm_description   = "Aurora writer FreeableMemory dropped below ${var.rds_freeable_memory_low_threshold_bytes} bytes."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "FreeableMemory"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = var.rds_freeable_memory_low_threshold_bytes
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = var.rds_instance_id
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "rds_replica_lag" {
  alarm_name          = "${var.name_prefix}-rds-replica-lag"
  alarm_description   = "Aurora replica lag exceeded ${var.rds_replica_lag_threshold_ms} ms."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "AuroraReplicaLag"
  namespace           = "AWS/RDS"
  period              = 60
  statistic           = "Maximum"
  threshold           = var.rds_replica_lag_threshold_ms
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBClusterIdentifier = var.rds_cluster_id
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "rds_connections_high" {
  alarm_name          = "${var.name_prefix}-rds-connections-high"
  alarm_description   = "RDS DatabaseConnections > ${var.rds_connection_threshold}."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "DatabaseConnections"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = var.rds_connection_threshold
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = var.rds_instance_id
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions

  tags = var.tags
}

# ---- ECS alarms (per service) ----------------------------------------------

locals {
  ecs_services = {
    web         = var.ecs_service_web_name
    worker      = var.ecs_service_worker_name
    print_agent = var.ecs_service_print_agent_name
  }
}

resource "aws_cloudwatch_metric_alarm" "ecs_cpu_high" {
  for_each = local.ecs_services

  alarm_name          = "${var.name_prefix}-ecs-${each.key}-cpu-high"
  alarm_description   = "ECS ${each.key} CPU > 80% sustained."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 300
  statistic           = "Average"
  threshold           = 80
  treat_missing_data  = "notBreaching"

  dimensions = {
    ClusterName = var.ecs_cluster_name
    ServiceName = each.value
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "ecs_memory_high" {
  for_each = local.ecs_services

  alarm_name          = "${var.name_prefix}-ecs-${each.key}-mem-high"
  alarm_description   = "ECS ${each.key} memory > 85% sustained."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "MemoryUtilization"
  namespace           = "AWS/ECS"
  period              = 300
  statistic           = "Average"
  threshold           = 85
  treat_missing_data  = "notBreaching"

  dimensions = {
    ClusterName = var.ecs_cluster_name
    ServiceName = each.value
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "ecs_running_count_low" {
  for_each = local.ecs_services

  alarm_name          = "${var.name_prefix}-ecs-${each.key}-running-low"
  alarm_description   = "ECS ${each.key} has fewer running tasks than desired (proxy for 'unhealthy count > 0')."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 2
  metric_name         = "RunningTaskCount"
  namespace           = "ECS/ContainerInsights"
  period              = 60
  statistic           = "Minimum"
  threshold           = 1
  treat_missing_data  = "breaching"

  dimensions = {
    ClusterName = var.ecs_cluster_name
    ServiceName = each.value
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions

  tags = var.tags
}

# ---- ALB alarms ------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "alb_5xx_rate" {
  alarm_name          = "${var.name_prefix}-alb-5xx-rate"
  alarm_description   = "ALB target 5xx rate > ${var.alb_5xx_threshold_percent}%."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  threshold           = var.alb_5xx_threshold_percent
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "rate"
    expression  = "(IF(requests > 0, errors / requests * 100, 0))"
    label       = "5xx percent of requests"
    return_data = true
  }

  metric_query {
    id = "requests"
    metric {
      metric_name = "RequestCount"
      namespace   = "AWS/ApplicationELB"
      period      = 300
      stat        = "Sum"
      dimensions = {
        LoadBalancer = var.alb_arn_suffix
      }
    }
  }

  metric_query {
    id = "errors"
    metric {
      metric_name = "HTTPCode_Target_5XX_Count"
      namespace   = "AWS/ApplicationELB"
      period      = 300
      stat        = "Sum"
      dimensions = {
        LoadBalancer = var.alb_arn_suffix
      }
    }
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "alb_target_response_p99" {
  alarm_name          = "${var.name_prefix}-alb-target-p99"
  alarm_description   = "ALB target response time p99 exceeded ${var.alb_target_response_time_p99_seconds}s."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "TargetResponseTime"
  namespace           = "AWS/ApplicationELB"
  period              = 300
  extended_statistic  = "p99"
  threshold           = var.alb_target_response_time_p99_seconds
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = var.alb_arn_suffix
    TargetGroup  = var.alb_target_group_web_arn_suffix
  }

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions

  tags = var.tags
}

# ---- Custom: audit chain integrity ----------------------------------------
#
# Placeholder: when the nightly `verifyAuditChain` job (Tier 3) finds a break
# it emits 1 to this metric; otherwise 0. The alarm fires on ANY non-zero
# value in a single period. The metric must already be emitted from the
# worker — the alarm is just a consumer.

resource "aws_cloudwatch_metric_alarm" "audit_chain_integrity_failure" {
  alarm_name          = "${var.name_prefix}-audit-chain-integrity"
  alarm_description   = "Audit chain integrity check reported a break. SEV1 - see RUNBOOK 'Audit chain integrity check'."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = var.audit_chain_failure_metric_name
  namespace           = var.custom_metric_namespace
  period              = 300
  statistic           = "Sum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  alarm_actions = local.alarm_actions
  ok_actions    = local.alarm_actions

  tags = var.tags
}

# ---- Dashboard -------------------------------------------------------------

resource "aws_cloudwatch_dashboard" "this" {
  dashboard_name = "${var.name_prefix}-overview"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Aurora PostgreSQL"
          region = var.aws_region
          stat   = "Average"
          period = 300
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", var.rds_instance_id],
            [".", "DatabaseConnections", ".", "."],
            [".", "FreeableMemory", ".", "."],
            ["AWS/RDS", "AuroraReplicaLag", "DBClusterIdentifier", var.rds_cluster_id]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "ALB"
          region = var.aws_region
          stat   = "Sum"
          period = 300
          metrics = [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", var.alb_arn_suffix],
            [".", "HTTPCode_Target_5XX_Count", ".", "."],
            [".", "HTTPCode_Target_4XX_Count", ".", "."],
            ["...", { stat = "p99", label = "TargetResponseTime p99" }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 24
        height = 6
        properties = {
          title  = "ECS services"
          region = var.aws_region
          stat   = "Average"
          period = 300
          metrics = [
            ["AWS/ECS", "CPUUtilization", "ClusterName", var.ecs_cluster_name, "ServiceName", var.ecs_service_web_name],
            ["...", var.ecs_service_worker_name],
            ["...", var.ecs_service_print_agent_name],
            ["AWS/ECS", "MemoryUtilization", "ClusterName", var.ecs_cluster_name, "ServiceName", var.ecs_service_web_name],
            ["...", var.ecs_service_worker_name],
            ["...", var.ecs_service_print_agent_name]
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "Audit chain integrity (custom)"
          region = var.aws_region
          stat   = "Sum"
          period = 300
          metrics = [
            [var.custom_metric_namespace, var.audit_chain_failure_metric_name]
          ]
        }
      }
    ]
  })
}
