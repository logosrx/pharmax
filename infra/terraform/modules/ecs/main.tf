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
  description = "Pharmax ECS task ENIs - ingress from ALB only"
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
#
# DATABASE_URL role split (defense-in-depth for RLS):
#   - web         -> `database-url`         (selects the RLS-subject
#                                            `pharmax_app` role)
#   - worker      -> `database-url-system`  (selects `pharmax_system`,
#   - print-agent -> `database-url-system`   BYPASSRLS — cross-tenant
#                                            claim drains)
# Wiring distinct secrets here makes it impossible to accidentally point
# the web tier at a BYPASSRLS role. `direct-url` (the migration/owner
# connection) is shared and never used for request-path queries.

locals {
  # REPORTING_DATABASE_URL (Aurora reader endpoint) is injected into web +
  # worker only when a reader is provisioned and the secret is populated.
  reporting_secret_env = var.enable_reporting_replica ? [
    { name = "REPORTING_DATABASE_URL", arn = var.secret_arns["reporting-database-url"] },
  ] : []

  # Grafana Cloud OTLP export (opt-in; web + worker only — the print-agent
  # runs at desired_count 0 until a physical site exists, and adding a boot
  # dependency to a service nobody exercises buys nothing). The endpoint is
  # not secret (plain env var); the headers value carries the gateway auth
  # token, so it rides the `secrets` block like every other credential.
  # `@pharmax/telemetry` reads both names verbatim — see
  # packages/telemetry/src/resolve-config.ts. OTEL_ENABLED needs no wiring:
  # it defaults to true when NODE_ENV=production.
  otel_env = var.otel_backend_enabled ? [
    { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = var.otel_exporter_otlp_endpoint },
  ] : []

  otel_secret_env = var.otel_backend_enabled ? [
    { name = "OTEL_EXPORTER_OTLP_HEADERS", arn = var.secret_arns["grafana-cloud-otlp-headers"] },
  ] : []

  web_secret_env = concat([
    { name = "DATABASE_URL", arn = var.secret_arns["database-url"] },
    { name = "DIRECT_URL", arn = var.secret_arns["direct-url"] },
    { name = "REDIS_URL", arn = var.secret_arns["redis-url"] },
    { name = "PHARMAX_LOCAL_KMS_SEED", arn = var.secret_arns["pharmax-local-kms-seed"] },
    { name = "STRIPE_SECRET_KEY", arn = var.secret_arns["stripe-secret-key"] },
    { name = "STRIPE_WEBHOOK_SECRET", arn = var.secret_arns["stripe-webhook-secret"] },
    { name = "EASYPOST_WEBHOOK_SECRET", arn = var.secret_arns["easypost-webhook-secret"] },
    # CLERK_SECRET_KEY / CLERK_WEBHOOK_SECRET /
    # NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY were injected here until
    # 2026-08-15. ADR-0030 retired Clerk and apps/web/src/server/env.ts
    # no longer declares any of them, so the container never read the
    # values — but every entry in this list is a BOOT dependency: the
    # execution role resolves it before the container starts, and an
    # empty secret fails the task with ResourceInitializationError and
    # an ~11-minute circuit-breaker rollback that names neither the
    # secret nor the cause (see the secret-value preflight in
    # .github/workflows/deploy.yml, and the 2026-08-01 worker rollout).
    # Since nobody repopulates a retired vendor's keys, these three were
    # a latent web-tier outage waiting on the Clerk vendor-decom
    # checklist. Dropping the reference is what removes that risk.
    #
    # The Secrets Manager entries themselves are deliberately LEFT in
    # modules/secrets/main.tf. Destroying them is a separate, sequenced
    # change: older task-definition revisions still reference them, and
    # those are what ECS rolls back to.
    { name = "SENTRY_DSN", arn = var.secret_arns["sentry-dsn"] },
  ], local.reporting_secret_env, local.otel_secret_env)

  worker_secret_env = concat([
    { name = "DATABASE_URL", arn = var.secret_arns["database-url-system"] },
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
  ], local.reporting_secret_env, local.otel_secret_env)

  print_agent_secret_env = [
    { name = "DATABASE_URL", arn = var.secret_arns["database-url-system"] },
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

      # SUPPORT_EMAIL + APP_URL are appended only when set (the app's prod boot
      # guard requires SUPPORT_EMAIL, and empty values would fail the Zod
      # email()/url() validation), so non-prod stacks that leave them blank
      # don't inject an invalid empty value.
      environment = concat([
        { name = "NODE_ENV", value = "production" },
        # Trust the Amazon RDS CA bundle baked into the image so Prisma 7's
        # verify-full TLS to RDS (force_ssl=1) succeeds (see Dockerfile).
        { name = "NODE_EXTRA_CA_CERTS", value = "/etc/pki/rds/global-bundle.pem" },
        { name = "PORT", value = tostring(var.web_container_port) },
        # Next.js standalone binds to `process.env.HOSTNAME`. The Dockerfile
        # sets HOSTNAME=0.0.0.0, but ECS injects the task's own hostname
        # (ip-10-x-x-x.ec2.internal) at runtime and that overrides the image
        # ENV — so the server bound to the ENI address alone and refused
        # loopback. /proc/net/tcp on a prod task showed a single listener on
        # 10.42.16.148:3000 with no 0.0.0.0:3000, and `wget
        # http://127.0.0.1:3000/api/health` returned "Connection refused".
        #
        # The container health check below dials localhost, so it could never
        # pass: every web task ran permanently UNHEALTHY, every rollout tripped
        # the circuit breaker ("tasks failed to start") even though the app was
        # serving fine, and ECS lost its ability to replace a genuinely wedged
        # task. It stayed invisible because the ALB dials the ENI address and
        # reported healthy, and `wait services-stable` does not require
        # healthStatus HEALTHY — so CI called the deploy a success.
        #
        # Setting it here (task-definition env beats image ENV) restores the
        # bind to all interfaces.
        { name = "HOSTNAME", value = "0.0.0.0" },
        { name = "PHARMAX_REGION", value = var.aws_region },
        { name = "AWS_REGION", value = var.aws_region },
        # Legacy alias — keep until packages/crypto/aws-kms-adapter.ts swaps to
        # AWS_KMS_DATA_KEY_ID end-to-end. Both values resolve to the same key.
        { name = "AWS_KMS_APP_KEY_ID", value = var.data_kms_key_alias },
        { name = "AWS_KMS_DATA_KEY_ID", value = var.data_kms_key_alias },
        { name = "AWS_KMS_SEARCH_KEY_ID", value = var.search_kms_key_alias },
        # Package-photo S3 storage. The app's production boot guard
        # refuses to start without BOTH (in-memory storage loses
        # captures across instances/redeploys) — see
        # apps/web/src/server/bootstrap.ts buildPackagePhotoStorage.
        { name = "S3_PACKAGE_PHOTOS_BUCKET", value = var.package_photos_bucket_name },
        { name = "S3_PACKAGE_PHOTOS_KMS_KEY_ID", value = var.package_photos_kms_key_alias },
        ],
        var.web_support_email != "" ? [{ name = "SUPPORT_EMAIL", value = var.web_support_email }] : [],
        var.web_app_url != "" ? [{ name = "APP_URL", value = var.web_app_url }] : [],
        local.otel_env,
      )

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

      environment = concat([
        { name = "NODE_ENV", value = "production" },
        { name = "PHARMAX_REGION", value = var.aws_region },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "AWS_KMS_APP_KEY_ID", value = var.data_kms_key_alias },
        { name = "AWS_KMS_DATA_KEY_ID", value = var.data_kms_key_alias },
        { name = "AWS_KMS_SEARCH_KEY_ID", value = var.search_kms_key_alias },
        # Trust the Amazon RDS CA bundle baked into the image so Prisma 7's
        # verify-full TLS to RDS (force_ssl=1) succeeds (see Dockerfile).
        { name = "NODE_EXTRA_CA_CERTS", value = "/etc/pki/rds/global-bundle.pem" },
        # Env-var names MUST match apps/worker/src/env.ts. The worker hard-
        # fails to boot in production if the nightly Merkle-root loop cannot
        # resolve its signer (MERKLE_SIGNER_KMS_KEY_ID) and Object-Lock
        # publisher (AUDIT_ARCHIVE_S3_BUCKET + AUDIT_ARCHIVE_S3_KMS_KEY_ID).
        # These were previously injected under non-matching names
        # (AWS_KMS_AUDIT_SIGN_KEY_ID / AUDIT_ARCHIVE_BUCKET /
        # AUDIT_ARCHIVE_KMS_KEY_ID), which the app never reads — see
        # daily-merkle-root-loop.ts buildMerkleSigner / buildMerklePublisher.
        { name = "MERKLE_SIGNER_KMS_KEY_ID", value = var.asymm_sign_kms_key_alias },
        { name = "AUDIT_ARCHIVE_S3_BUCKET", value = var.audit_archive_bucket_name },
        { name = "AUDIT_ARCHIVE_S3_KMS_KEY_ID", value = var.audit_archive_kms_key_alias },
        # Enables the package-photo orphan-object sweeper (lists
        # org/*/photo/upload/* and deletes objects with no backing
        # package_photo row). MUST match the web tier's bucket.
        { name = "S3_PACKAGE_PHOTOS_BUCKET", value = var.package_photos_bucket_name },
      ], local.otel_env)

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
        # Required by the print-agent production boot guard alongside the
        # data key (barcode blind-index verification uses the search CMK).
        # The IAM grant landed with "grant print-agent KMS search"
        # (9a78bbf); this env var is the missing half — without it the
        # task crash-loops at boot.
        { name = "AWS_KMS_SEARCH_KEY_ID", value = var.search_kms_key_alias },
        # Trust the Amazon RDS CA bundle baked into the image so Prisma 7's
        # verify-full TLS to RDS (force_ssl=1) succeeds (see Dockerfile).
        { name = "NODE_EXTRA_CA_CERTS", value = "/etc/pki/rds/global-bundle.pem" },
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
