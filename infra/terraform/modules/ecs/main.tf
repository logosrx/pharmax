# =============================================================================
# ECS module — Fargate cluster + three services.
#
# Services:
#   - web         (apps/web)         attached to ALB target group; autoscaling on CPU
#   - worker      (apps/worker)      polling drains; fixed count
#   - print-agent (apps/print-agent) polling print-agent; fixed count
#
# Secret injection:
#   Secrets are passed via `secrets =` (NOT `environment =`) so the secret
#   value never appears in `aws ecs describe-task-definition` or in the
#   ECS event stream. The execution role (created in iam module) has
#   permission to read these.
#
# The env-var schema (apps/web/src/server/env.ts, apps/worker/src/env.ts,
# apps/print-agent/src/env.ts) determines exactly which secrets to inject.
# =============================================================================

# ---- Cluster ----------------------------------------------------------------

resource "aws_ecs_cluster" "this" {
  name = "${var.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = var.container_insights_enabled ? "enabled" : "disabled"
  }

  tags = var.tags
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name = aws_ecs_cluster.this.name

  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    base              = 1
    weight            = 100
  }
}

# ---- Shared task security group --------------------------------------------
# A single SG for all ECS task ENIs. Ingress from the ALB SG only (web).
# Worker / print-agent never receive ingress traffic — they egress only.

resource "aws_security_group" "tasks" {
  name        = "${var.name_prefix}-ecs-tasks"
  description = "Pharmax ECS task ENIs — ingress from ALB only"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-ecs-tasks"
  })
}

resource "aws_security_group_rule" "tasks_ingress_alb_web" {
  type                     = "ingress"
  from_port                = var.web_container_port
  to_port                  = var.web_container_port
  protocol                 = "tcp"
  source_security_group_id = var.alb_security_group_id
  security_group_id        = aws_security_group.tasks.id
  description              = "Web traffic from ALB SG"
}

resource "aws_security_group_rule" "tasks_egress_all" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
  ipv6_cidr_blocks  = ["::/0"]
  security_group_id = aws_security_group.tasks.id
  description       = "Task egress to RDS, NAT, public APIs"
}

# ---- Log groups (per service) ----------------------------------------------

resource "aws_cloudwatch_log_group" "web" {
  name              = "/ecs/${var.name_prefix}/web"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn

  tags = merge(var.tags, {
    Service = "web"
  })
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${var.name_prefix}/worker"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn

  tags = merge(var.tags, {
    Service = "worker"
  })
}

resource "aws_cloudwatch_log_group" "print_agent" {
  name              = "/ecs/${var.name_prefix}/print-agent"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.logs_kms_key_arn

  tags = merge(var.tags, {
    Service = "print-agent"
  })
}

# ---- Secret -> env-var mapping ---------------------------------------------
#
# Format expected by ECS:
#   { name = "<ENV VAR>", valueFrom = "<SecretsManager ARN>" }

locals {
  web_secret_env = [
    { name = "DATABASE_URL", arn = var.secret_arns["database-url"] },
    { name = "DIRECT_URL", arn = var.secret_arns["direct-url"] },
    { name = "REDIS_URL", arn = var.secret_arns["redis-url"] },
    { name = "PHARMAX_LOCAL_KMS_SEED", arn = var.secret_arns["pharmax-local-kms-seed"] },
    { name = "STRIPE_SECRET_KEY", arn = var.secret_arns["stripe-secret-key"] },
    { name = "STRIPE_WEBHOOK_SECRET", arn = var.secret_arns["stripe-webhook-secret"] },
    { name = "EASYPOST_WEBHOOK_SECRET", arn = var.secret_arns["easypost-webhook-secret"] },
    { name = "CLERK_SECRET_KEY", arn = var.secret_arns["clerk-secret-key"] },
    { name = "CLERK_WEBHOOK_SECRET", arn = var.secret_arns["clerk-webhook-secret"] },
    { name = "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", arn = var.secret_arns["next-public-clerk-publishable-key"] },
    { name = "SENTRY_DSN", arn = var.secret_arns["sentry-dsn"] },
  ]

  worker_secret_env = [
    { name = "DATABASE_URL", arn = var.secret_arns["database-url"] },
    { name = "DIRECT_URL", arn = var.secret_arns["direct-url"] },
    { name = "REDIS_URL", arn = var.secret_arns["redis-url"] },
    { name = "PHARMAX_LOCAL_KMS_SEED", arn = var.secret_arns["pharmax-local-kms-seed"] },
    { name = "STRIPE_SECRET_KEY", arn = var.secret_arns["stripe-secret-key"] },
    { name = "EASYPOST_API_KEY", arn = var.secret_arns["easypost-api-key"] },
    { name = "FEDEX_CLIENT_ID", arn = var.secret_arns["fedex-client-id"] },
    { name = "FEDEX_CLIENT_SECRET", arn = var.secret_arns["fedex-client-secret"] },
    { name = "UPS_CLIENT_ID", arn = var.secret_arns["ups-client-id"] },
    { name = "UPS_CLIENT_SECRET", arn = var.secret_arns["ups-client-secret"] },
    { name = "SENTRY_DSN", arn = var.secret_arns["sentry-dsn"] },
  ]

  print_agent_secret_env = [
    { name = "DATABASE_URL", arn = var.secret_arns["database-url"] },
    { name = "DIRECT_URL", arn = var.secret_arns["direct-url"] },
    { name = "PHARMAX_LOCAL_KMS_SEED", arn = var.secret_arns["pharmax-local-kms-seed"] },
    { name = "SENTRY_DSN", arn = var.secret_arns["sentry-dsn"] },
  ]
}

# ---- Web task definition ---------------------------------------------------

resource "aws_ecs_task_definition" "web" {
  family                   = "${var.name_prefix}-web"
  cpu                      = var.web_cpu
  memory                   = var.web_memory
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = var.task_execution_role_arn
  task_role_arn            = var.task_role_web_arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = "web"
      image     = "${var.ecr_web_repository_url}:${var.ecr_web_image_tag}"
      essential = true

      portMappings = [
        {
          containerPort = var.web_container_port
          hostPort      = var.web_container_port
          protocol      = "tcp"
        }
      ]

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "PORT", value = tostring(var.web_container_port) },
        { name = "PHARMAX_REGION", value = var.aws_region },
        { name = "AWS_REGION", value = var.aws_region },
        # Legacy alias — keep until packages/crypto/aws-kms-adapter.ts swaps to
        # AWS_KMS_DATA_KEY_ID end-to-end. Both values resolve to the same key.
        { name = "AWS_KMS_APP_KEY_ID", value = var.data_kms_key_alias },
        { name = "AWS_KMS_DATA_KEY_ID", value = var.data_kms_key_alias },
        { name = "AWS_KMS_SEARCH_KEY_ID", value = var.search_kms_key_alias },
      ]

      secrets = [for s in local.web_secret_env : {
        name      = s.name
        valueFrom = s.arn
      }]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.web.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "web"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "wget -q --spider http://localhost:${var.web_container_port}${var.web_health_check_path} || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }

      readonlyRootFilesystem = false
      stopTimeout            = 30
    }
  ])

  tags = merge(var.tags, { Service = "web" })
}

resource "aws_ecs_service" "web" {
  name                              = "${var.name_prefix}-web"
  cluster                           = aws_ecs_cluster.this.id
  task_definition                   = aws_ecs_task_definition.web.arn
  desired_count                     = var.web_desired_count
  launch_type                       = "FARGATE"
  platform_version                  = "LATEST"
  health_check_grace_period_seconds = 60
  enable_execute_command            = true

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = var.alb_target_group_web_arn
    container_name   = "web"
    container_port   = var.web_container_port
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100

  tags = merge(var.tags, { Service = "web" })

  lifecycle {
    ignore_changes = [desired_count, task_definition]
  }
}

# ---- Web autoscaling -------------------------------------------------------

resource "aws_appautoscaling_target" "web" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.web.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.web_min_count
  max_capacity       = var.web_max_count
}

resource "aws_appautoscaling_policy" "web_cpu" {
  name               = "${var.name_prefix}-web-cpu"
  service_namespace  = aws_appautoscaling_target.web.service_namespace
  resource_id        = aws_appautoscaling_target.web.resource_id
  scalable_dimension = aws_appautoscaling_target.web.scalable_dimension
  policy_type        = "TargetTrackingScaling"

  target_tracking_scaling_policy_configuration {
    target_value       = var.web_cpu_target_utilization_percent
    scale_in_cooldown  = 60
    scale_out_cooldown = 30

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

# ---- Worker task definition + service --------------------------------------

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name_prefix}-worker"
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = var.task_execution_role_arn
  task_role_arn            = var.task_role_worker_arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = "worker"
      image     = "${var.ecr_worker_repository_url}:${var.ecr_worker_image_tag}"
      essential = true

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "PHARMAX_REGION", value = var.aws_region },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "AWS_KMS_APP_KEY_ID", value = var.data_kms_key_alias },
        { name = "AWS_KMS_DATA_KEY_ID", value = var.data_kms_key_alias },
        { name = "AWS_KMS_SEARCH_KEY_ID", value = var.search_kms_key_alias },
        { name = "AWS_KMS_AUDIT_SIGN_KEY_ID", value = var.asymm_sign_kms_key_alias },
        { name = "AUDIT_ARCHIVE_BUCKET", value = var.audit_archive_bucket_name },
        { name = "AUDIT_ARCHIVE_KMS_KEY_ID", value = var.audit_archive_kms_key_alias },
      ]

      secrets = [for s in local.worker_secret_env : {
        name      = s.name
        valueFrom = s.arn
      }]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.worker.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "worker"
        }
      }

      # The worker is a polling drain — there is no socket to ping, but a
      # node-side liveness file or signal would be the cleanest signal.
      # For now we let ECS rely on the process exit code.
      healthCheck = {
        command     = ["CMD-SHELL", "test -f /tmp/pharmax-worker-alive || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }

      readonlyRootFilesystem = false
      stopTimeout            = 30
    }
  ])

  tags = merge(var.tags, { Service = "worker" })
}

resource "aws_ecs_service" "worker" {
  name                   = "${var.name_prefix}-worker"
  cluster                = aws_ecs_cluster.this.id
  task_definition        = aws_ecs_task_definition.worker.arn
  desired_count          = var.worker_desired_count
  launch_type            = "FARGATE"
  platform_version       = "LATEST"
  enable_execute_command = true

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100

  tags = merge(var.tags, { Service = "worker" })

  lifecycle {
    ignore_changes = [desired_count, task_definition]
  }
}

# ---- Print-agent task definition + service ---------------------------------

resource "aws_ecs_task_definition" "print_agent" {
  family                   = "${var.name_prefix}-print-agent"
  cpu                      = var.print_agent_cpu
  memory                   = var.print_agent_memory
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = var.task_execution_role_arn
  task_role_arn            = var.task_role_print_agent_arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = "print-agent"
      image     = "${var.ecr_print_agent_repository_url}:${var.ecr_print_agent_image_tag}"
      essential = true

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "PHARMAX_REGION", value = var.aws_region },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "AWS_KMS_APP_KEY_ID", value = var.data_kms_key_alias },
        { name = "AWS_KMS_DATA_KEY_ID", value = var.data_kms_key_alias },
      ]

      secrets = [for s in local.print_agent_secret_env : {
        name      = s.name
        valueFrom = s.arn
      }]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.print_agent.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "print-agent"
        }
      }

      healthCheck = {
        command     = ["CMD-SHELL", "test -f /tmp/pharmax-print-agent-alive || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }

      readonlyRootFilesystem = false
      stopTimeout            = 30
    }
  ])

  tags = merge(var.tags, { Service = "print-agent" })
}

resource "aws_ecs_service" "print_agent" {
  name                   = "${var.name_prefix}-print-agent"
  cluster                = aws_ecs_cluster.this.id
  task_definition        = aws_ecs_task_definition.print_agent.arn
  desired_count          = var.print_agent_desired_count
  launch_type            = "FARGATE"
  platform_version       = "LATEST"
  enable_execute_command = true

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  deployment_maximum_percent         = 200
  deployment_minimum_healthy_percent = 100

  tags = merge(var.tags, { Service = "print-agent" })

  lifecycle {
    ignore_changes = [desired_count, task_definition]
  }
}
