# =============================================================================
# Pharmax — prod / us-east-1 (PRIMARY). Full enterprise build.
# Shield Advanced is OFF (no subscription); flip on after subscribing.
# =============================================================================

project     = "pharmax"
environment = "prod"
region      = "us-east-1"

# ---- Network ----------------------------------------------------------------
vpc_cidr                     = "10.42.0.0/16"
availability_zone_count      = 3
nat_gateway_strategy         = "per_az"
vpc_flow_logs_retention_days = 365

# ---- ALB --------------------------------------------------------------------
acm_certificate_domain   = "*.pharmax.co"
alb_idle_timeout_seconds = 60

# ---- App config (injected into the web task) --------------------------------
support_email = "support@pharmax.co"
app_url       = "https://app.pharmax.co"

# ---- KMS --------------------------------------------------------------------
asymm_sign_key_spec = "ECC_NIST_P384"

# ---- Database (Aurora PostgreSQL) — provisioned writer + 1 reader -----------
aurora_capacity_mode = "provisioned"
aurora_reader_count  = 1
rds_instance_class   = "db.r6g.large"

rds_engine_version                      = "16.4"
rds_backup_retention_days               = 35
rds_deletion_protection                 = true
rds_performance_insights_retention_days = 731

# Aurora Global Database PRIMARY (DR secondary joins from us-west-2 later).
rds_global_cluster_role = "primary"

# Deprecated but retained for file validity.
rds_allocated_storage_gb     = 200
rds_max_allocated_storage_gb = 2000
rds_parameter_group_family   = "postgres16"
rds_multi_az                 = true

# ---- ECS --------------------------------------------------------------------
ecs_web_cpu              = 1024
ecs_web_memory           = 2048
ecs_web_desired_count    = 3
ecs_web_min_count        = 3
ecs_web_max_count        = 20
ecs_worker_cpu           = 1024
ecs_worker_memory        = 2048
ecs_worker_desired_count = 3
ecs_print_agent_cpu      = 512
ecs_print_agent_memory   = 1024
# 0 until a real pharmacy site exists. The agent resolves a specific
# workstation from the database at boot and needs a network path to a
# physical Zebra printer; a task in a private Fargate subnet has neither, so
# it crash-loops (2026-08-02). NOTE: the ECS service sets
# `ignore_changes = [desired_count]` so autoscaling and manual scaling can
# move it freely — meaning this value governs INITIAL creation only, and the
# running count must be changed with `aws ecs update-service`.
ecs_print_agent_desired_count  = 0
ecs_log_retention_days         = 365
ecs_container_insights_enabled = true

# ---- WAF / Alarms -----------------------------------------------------------
waf_rate_limit_per_5min = 2000

# Alerting. `enable_alerting = true` provisions the severity-split SNS topics
# (`pharmax-prod-ue1-alerts-critical` / `-alerts-warning`) and routes every
# alarm to one of them. This MUST stay true in production: with it off, all 15
# alarms evaluate correctly, transition to ALARM correctly, and notify nobody —
# which is what this stack shipped with until 2026-08-03.
# `pnpm check:alarm-actions` fails the build if it is turned off here.
enable_alerting = true

# Outside-in heartbeat canary (modules/synthetics): hits ${app_url}/api/health
# from outside the VPC every minute; failure pages via the critical topic. The
# only monitor that can see DNS/cert/CloudFront/WAF failures.
enable_synthetics = true

# ---- OpenTelemetry backend (Grafana Cloud) ------------------------------------
# OFF until the Grafana Cloud stack exists. Flip to true only after (in order):
#   1. the Grafana Cloud stack is created,
#   2. the `pharmax-prod-ue1/grafana-cloud-otlp-headers` secret holds the real
#      `Authorization=Basic <base64(instanceId:token)>` value, and
#   3. `otel_exporter_otlp_endpoint` below matches the stack's region-specific
#      OTLP gateway URL (the committed default is us-central; copy the exact
#      URL from the stack's "OpenTelemetry → Configure" page).
# Full procedure: docs/observability/grafana-cloud-otel-backend.md.
otel_backend_enabled = false
# otel_exporter_otlp_endpoint = "https://otlp-gateway-prod-us-east-0.grafana.net/otlp"

# The legacy single-topic override stays empty: the per-severity topics above
# supersede it. Setting it here would route every alarm — warning tier included
# — to whatever topic it names.
alarm_sns_topic_arn = ""

# Subscription endpoints are NOT set here, deliberately. They arrive as
# TF_VAR_alerting_critical_https_subscriptions (etc.) from the production
# GitHub Environment secrets at apply time; a paging webhook URL is a bearer
# credential and an on-call address is personal data. Neither belongs in git.
# After an apply, `terraform output alerting_critical_subscription_count`
# answers "would an alarm actually reach anyone?" — see
# docs/runbooks/alerting.md.

# ---- Audit archive ----------------------------------------------------------
audit_archive_retention_years         = 7
audit_archive_glacier_transition_days = 90

# ---- Security baseline (CloudTrail + Config + GuardDuty + Security Hub) ------
enable_security_baseline = true

# ---- Shield Advanced --------------------------------------------------------
# OFF: requires a paid account-level subscription. Flip to true AFTER
# subscribing in the console.
enable_shield_advanced = false

# ---- CloudFront -------------------------------------------------------------
enable_cloudfront              = true
cloudfront_origin_domain_name  = "origin.pharmax.co"
cloudfront_aliases             = ["app.pharmax.co"]
cloudfront_acm_certificate_arn = "arn:aws:acm:us-east-1:172800116354:certificate/bbb7ed5d-f9dd-424b-bf37-c973041bb3ba"
cloudfront_price_class         = "PriceClass_100"

# ---- ElastiCache (Redis) ----------------------------------------------------
enable_elasticache        = true
elasticache_node_type     = "cache.m7g.large"
elasticache_replica_count = 2
elasticache_multi_az      = true

# ---- CI/CD deploy role (GitHub Actions OIDC) --------------------------------
enable_cicd_deploy_role = true
cicd_github_repository  = "logosrx/pharmax"
cicd_github_environment = "production"

# ---- Restore-drill preflight role (GitHub Actions OIDC) ---------------------
# Read-only role for the quarterly DR drill's automated preflight. Scoped to
# rds:DescribeDBClusters on this stack's Aurora cluster + kms:DescribeKey on
# its storage CMK — nothing else. After apply, set the three repo variables
# from `terraform output restore_drill_*` (see docs/operations/production-deployment.md § 2.5).
enable_restore_drill_role = true
drill_github_repository   = "logosrx/pharmax"

tags = {
  CostCenter = "engineering-prod"
}
