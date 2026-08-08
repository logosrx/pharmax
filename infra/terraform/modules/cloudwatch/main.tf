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
#   - Custom: AuditChainIntegrityFailure > 0 (daily verifier loop emits this)
#   - Custom: outbox backlog (depth / oldest age / DEAD count; the worker's
#     outbox-backlog-probe loop emits these every ~60s)
#
# Aurora has no FreeStorageSpace metric (storage auto-scales), so we watch
# FreeableMemory on the writer instead. AuroraReplicaLag is reported in
# milliseconds at the cluster level.
#
# ---- Severity routing --------------------------------------------------------
#
# Alarms route to one of TWO topics from `modules/alerting`, never to one
# shared topic:
#
#   critical → pages a human now. Reserved for loss of availability, a
#              data-integrity break, or a capacity cliff that is minutes
#              away from becoming either.
#   warning  → ticket / mailbox read at shift start. Degradation and
#              capacity-planning signals, where the honest answer to "what
#              would the on-call engineer do about this at 03:00?" is
#              "look at a dashboard and go back to bed".
#
# Every alarm below opens with a `# severity:` line stating which tier it
# routes to and why. That comment is load-bearing, not decoration:
# `scripts/check-alarm-actions.ts` (`pnpm check:alarm-actions`) fails the
# build if an alarm is missing one, if it disagrees with the actions the
# alarm actually sets, or if an alarm can be declared with an empty action
# list in production. The regression this repository already shipped once —
# 16 correct alarms wired to `alarm_sns_topic_arn = ""` — cannot recur
# silently.
#
# Fallback: when a severity topic ARN is empty the module falls back to the
# legacy single-topic `alarm_sns_topic_arn`, and when that is empty too the
# action list is empty — the alarm still evaluates and its state is visible
# in CloudWatch, it just notifies nobody. That is the intended posture for
# dev and for a first apply in a virgin account; the CI guard is what keeps
# it from being the posture in production.
# =============================================================================

locals {
  critical_topic_arn = var.critical_alarm_sns_topic_arn != "" ? var.critical_alarm_sns_topic_arn : var.alarm_sns_topic_arn
  warning_topic_arn  = var.warning_alarm_sns_topic_arn != "" ? var.warning_alarm_sns_topic_arn : var.alarm_sns_topic_arn

  critical_alarm_actions = local.critical_topic_arn != "" ? [local.critical_topic_arn] : []
  warning_alarm_actions  = local.warning_topic_arn != "" ? [local.warning_topic_arn] : []
}

# ---- RDS alarms -------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "rds_cpu_high" {
  # severity: warning — writer CPU pressure without user-visible impact yet; the
  # 03:00 levers (resize the instance class) need a human-approved apply anyway,
  # and the cliff it leads to is covered by the connection + memory alarms.
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

  alarm_actions = local.warning_alarm_actions
  ok_actions    = local.warning_alarm_actions

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "rds_freeable_memory_low" {
  # severity: critical — a writer below this much freeable memory is minutes from
  # swapping and then from an unplanned failover that drops every in-flight
  # transaction mid-dispense. A human can kill the offending workload or fail
  # over deliberately; both beat finding out from a pharmacist.
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

  alarm_actions = local.critical_alarm_actions
  ok_actions    = local.critical_alarm_actions

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "rds_replica_lag" {
  # severity: warning — the reader only backs REPORTING_DATABASE_URL, so lag means
  # stale reports, not failed dispensing. If the lag is caused by writer overload,
  # the writer's own critical alarms are the ones that should wake someone.
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

  alarm_actions = local.warning_alarm_actions
  ok_actions    = local.warning_alarm_actions

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "rds_connections_high" {
  # severity: critical — connection exhaustion refuses NEW connections, which takes
  # out web and worker together and looks like a total outage. There is a real
  # 03:00 lever: terminate idle-in-transaction sessions, or restart the service
  # that is leaking them.
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

  alarm_actions = local.critical_alarm_actions
  ok_actions    = local.critical_alarm_actions

  tags = var.tags
}

# ---- ECS alarms (per service) ----------------------------------------------

locals {
  ecs_services = {
    web         = var.ecs_service_web_name
    worker      = var.ecs_service_worker_name
    print_agent = var.ecs_service_print_agent_name
  }

  # Availability alarms are split by severity, so they live in two resources
  # rather than one for_each over all three services. web and worker down is an
  # outage; the print agent is a business-hours function (see each resource).
  ecs_services_paging_availability = {
    web    = var.ecs_service_web_name
    worker = var.ecs_service_worker_name
  }
}

resource "aws_cloudwatch_metric_alarm" "ecs_cpu_high" {
  for_each = local.ecs_services

  # severity: warning — web autoscales on CPU (min 3 / max 20), so sustained CPU is
  # the scaling policy working, and for worker/print-agent it is a capacity-planning
  # signal. If it degrades into an outage, the 5xx and running-count alarms page.
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

  alarm_actions = local.warning_alarm_actions
  ok_actions    = local.warning_alarm_actions

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "ecs_memory_high" {
  for_each = local.ecs_services

  # severity: warning — a task that actually exhausts its memory is killed and
  # replaced, which surfaces on the running-count alarm; at 85% the useful action
  # is a task-definition memory bump, which is a change, not an incident.
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

  alarm_actions = local.warning_alarm_actions
  ok_actions    = local.warning_alarm_actions

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "ecs_running_count_low" {
  for_each = local.ecs_services_paging_availability

  # severity: critical — zero running tasks IS the outage. No web means no
  # pharmacist can type, verify, or ship; no worker means the event-outbox drain,
  # label rendering, notifications, and SLA timers all stop while orders keep
  # arriving. `treat_missing_data = breaching` is deliberate: a service whose
  # metric disappears is not a service that is fine.
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

  alarm_actions = local.critical_alarm_actions
  ok_actions    = local.critical_alarm_actions

  tags = var.tags
}

# The print agent gets its own resource because it is the one service where
# "no tasks running" is neither an outage nor, today, even abnormal:
# `ecs_print_agent_desired_count = 0` in prod until a real pharmacy site
# exists, and Container Insights reports 0 (or nothing) for a service with no
# tasks. Wiring that to any topic would have produced a permanently-firing
# alarm on day one, and a permanently-firing alarm teaches people to filter the
# whole feed. So it is created only when the stack intends the agent to be
# running, and it notifies the warning tier: printing is a business-hours
# function, and the morning shift reads the warning mailbox before it touches a
# vial.
#
# CAVEAT for whoever scales this service: the ECS service sets
# `ignore_changes = [desired_count]`, so scaling with `aws ecs update-service`
# does NOT create this alarm. Raise `ecs_print_agent_desired_count` in the
# env-region tfvars in the same change, or the print agent runs unwatched.
resource "aws_cloudwatch_metric_alarm" "ecs_print_agent_running_low" {
  count = var.print_agent_running_alarm_enabled ? 1 : 0

  # severity: warning — a dead print agent stops label printing, which stops
  # dispensing during business hours, but there is nothing for a human to do with
  # it at 03:00 in a closed pharmacy.
  alarm_name          = "${var.name_prefix}-ecs-print-agent-running-low"
  alarm_description   = "ECS print-agent has fewer running tasks than desired. No printing means no vial labels."
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
    ServiceName = var.ecs_service_print_agent_name
  }

  alarm_actions = local.warning_alarm_actions
  ok_actions    = local.warning_alarm_actions

  tags = var.tags
}

# ---- ALB alarms ------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "alb_5xx_rate" {
  # severity: critical — this is the alarm that says "the people using the system
  # are getting errors right now". Above 1% of requests, orders are failing to save
  # and verifications are failing to record; the levers (roll back the release, scale
  # the service) are exactly what an on-call engineer is for.
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

  alarm_actions = local.critical_alarm_actions
  ok_actions    = local.critical_alarm_actions

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "alb_target_response_p99" {
  # severity: warning — p99 over 2s for 15 minutes is a slow, annoying pharmacy, not
  # a stopped one: the workflow still completes and nothing is lost. Paging on a
  # latency percentile is how a rotation learns to ignore its pager; if latency
  # turns into failure, the 5xx alarm is the one that fires.
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

  alarm_actions = local.warning_alarm_actions
  ok_actions    = local.warning_alarm_actions

  tags = var.tags
}

# ---- Custom: audit chain integrity ----------------------------------------
#
# The worker's daily audit-chain verifier loop publishes this metric after
# every run (`AUDIT_CHAIN_FAILURE_METRIC` in
# apps/worker/src/security/audit-chain-verifier-loop.ts): orgsFailed on a
# break, 0 on a clean run. The alarm fires on ANY non-zero value in a single
# period.

resource "aws_cloudwatch_metric_alarm" "audit_chain_integrity_failure" {
  # severity: critical — a break in the audit chain is either a bug corrupting the
  # record of who did what to a prescription, or someone editing it. Both are worse
  # the longer they run unobserved, and the first response (freeze the affected
  # tenant's chain, capture forensics) is time-sensitive even at 03:00.
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

  alarm_actions = local.critical_alarm_actions
  ok_actions    = local.critical_alarm_actions

  tags = var.tags
}

# ---- Custom: event outbox backlog ------------------------------------------
#
# The worker's outbox-backlog-probe loop (apps/worker/src/metrics/
# outbox-backlog-probe.ts) publishes three metrics to
# `var.worker_metric_namespace` every ~60s:
#
#   OutboxUndispatchedDepth            PENDING + FAILED rows
#   OutboxOldestUndispatchedAgeSeconds age of the oldest such row (0 = none)
#   OutboxDeadDepth                    DEAD rows awaiting admin replay
#
# Why the outbox gets its own alarms when the worker already has
# running-count paging: every command's side effects — shipping
# notifications, billing materialization, partner webhook fan-out,
# label dispatch — ride the outbox. The running-count alarm catches a
# dead worker; nothing else catches a LIVE worker whose drainer has
# stopped making progress (poison row, lock pile-up, wedged handler).
# Oldest-row age is the honest progress signal: a healthy drainer
# cannot let it grow, and a row's full retry ladder tops out around
# two hours, so a sustained hour-old row means the async half of the
# platform is down while the console looks fine.

resource "aws_cloudwatch_metric_alarm" "outbox_oldest_age_high" {
  # severity: warning — a 15-minute-old undispatched row means some side effect is
  # already 15 minutes late (usually one failing handler riding the retry ladder).
  # Degradation, not an outage; the critical stall alarm below covers the cliff.
  # `treat_missing_data = breaching` is deliberate and load-bearing: the probe
  # publishing nothing means the worker is down (already paging via running-count)
  # or the probe/publisher is broken — and a silently non-emitting metric is
  # exactly the "monitoring configured but disconnected" failure this repo has
  # shipped once already. Three empty 5-minute periods absorb a normal deploy gap.
  alarm_name          = "${var.name_prefix}-outbox-oldest-age-high"
  alarm_description   = "Oldest undispatched event_outbox row is older than ${var.outbox_oldest_age_warning_threshold_seconds}s — side effects are running late. See RUNBOOK 'Outbox drain stuck or backed up'."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "OutboxOldestUndispatchedAgeSeconds"
  namespace           = var.worker_metric_namespace
  period              = 300
  statistic           = "Maximum"
  threshold           = var.outbox_oldest_age_warning_threshold_seconds
  treat_missing_data  = "breaching"

  alarm_actions = local.warning_alarm_actions
  ok_actions    = local.warning_alarm_actions

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "outbox_stalled" {
  # severity: critical — an hour-old undispatched row outlives any legitimate retry
  # wait, so the drainer has stopped making progress while orders keep committing:
  # shipping releases, billing, notifications, and webhook fan-out are all silently
  # queued behind it. That is a loss of availability for the asynchronous half of
  # the platform, and the response (find the wedged row/handler, restart the
  # worker) is time-sensitive even at 03:00. Missing data is NOT breaching here:
  # a dead worker already pages via running-count, and a broken probe raises the
  # warning-tier age alarm above — double-paging the same cause helps nobody.
  alarm_name          = "${var.name_prefix}-outbox-stalled"
  alarm_description   = "Oldest undispatched event_outbox row exceeded ${var.outbox_stalled_threshold_seconds}s — the outbox drainer is not making progress. See RUNBOOK 'Outbox drain stuck or backed up'."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "OutboxOldestUndispatchedAgeSeconds"
  namespace           = var.worker_metric_namespace
  period              = 300
  statistic           = "Maximum"
  threshold           = var.outbox_stalled_threshold_seconds
  treat_missing_data  = "notBreaching"

  alarm_actions = local.critical_alarm_actions
  ok_actions    = local.critical_alarm_actions

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "outbox_dead_rows" {
  # severity: warning — a DEAD row is a load-bearing side effect the platform has
  # permanently missed (the drainer never replays DEAD); it stays wrong until an
  # admin re-publish, but it is not getting MORE wrong by the minute, and the
  # 03:00 response would be "read the lastError, replay in the morning". The
  # alarm holds ALARM state until the replay happens, which is honest: the
  # mailbox owner should keep seeing it until someone acts.
  alarm_name          = "${var.name_prefix}-outbox-dead-rows"
  alarm_description   = "event_outbox has DEAD rows — side effects permanently missed until an admin replay. See RUNBOOK 'Outbox drain stuck or backed up'."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "OutboxDeadDepth"
  namespace           = var.worker_metric_namespace
  period              = 300
  statistic           = "Maximum"
  threshold           = 0
  treat_missing_data  = "notBreaching"

  alarm_actions = local.warning_alarm_actions
  ok_actions    = local.warning_alarm_actions

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
      },
      {
        type   = "metric"
        x      = 12
        y      = 12
        width  = 12
        height = 6
        properties = {
          title  = "Event outbox backlog (custom)"
          region = var.aws_region
          stat   = "Maximum"
          period = 300
          metrics = [
            [var.worker_metric_namespace, "OutboxOldestUndispatchedAgeSeconds"],
            [var.worker_metric_namespace, "OutboxUndispatchedDepth"],
            [var.worker_metric_namespace, "OutboxDeadDepth"]
          ]
        }
      }
    ]
  })
}
