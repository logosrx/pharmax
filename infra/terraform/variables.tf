# =============================================================================
# Pharmax — root input variables.
#
# Every value that varies between dev / staging / prod / region lives here.
# Module inputs are derived from these so we never pass a raw region / account
# id down the tree. The .tfvars files under environments/<env>/<region>/
# supply the concrete values per env-region tuple.
# =============================================================================

# ---- Identity ---------------------------------------------------------------

variable "project" {
  description = "Project slug used to prefix every resource name. Keep lowercase + hyphens."
  type        = string
  default     = "pharmax"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.project))
    error_message = "project must be lowercase alphanumeric + hyphens, 2-31 chars, starting with a letter."
  }
}

variable "environment" {
  description = "Environment short name (dev, staging, prod). Drives sizing, retention, alarming."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "region" {
  description = "AWS region for ALL resources in this stack. One stack = one region."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]+$", var.region))
    error_message = "region must look like a real AWS region code, e.g. us-east-1."
  }
}

variable "tags" {
  description = "Extra tags applied to every resource (merged on top of computed defaults)."
  type        = map(string)
  default     = {}
}

# ---- Network ----------------------------------------------------------------

variable "vpc_cidr" {
  description = "Primary VPC CIDR block. Must be a /16 with enough room for N AZ x 3 tiers."
  type        = string
  default     = "10.40.0.0/16"
}

variable "availability_zone_count" {
  description = "Number of AZs to span (subnets are created in each)."
  type        = number
  default     = 3

  validation {
    condition     = var.availability_zone_count >= 2 && var.availability_zone_count <= 4
    error_message = "availability_zone_count must be between 2 and 4."
  }
}

variable "nat_gateway_strategy" {
  description = "single = one NAT (cheap, dev); per_az = one NAT per AZ (HA, prod)."
  type        = string
  default     = "per_az"

  validation {
    condition     = contains(["single", "per_az"], var.nat_gateway_strategy)
    error_message = "nat_gateway_strategy must be 'single' or 'per_az'."
  }
}

variable "vpc_flow_logs_retention_days" {
  description = "CloudWatch Logs retention for VPC flow logs."
  type        = number
  default     = 90
}

# ---- ALB / DNS --------------------------------------------------------------

variable "acm_certificate_domain" {
  description = "Domain name of the ACM certificate that the ALB HTTPS listener will use. The cert must already exist in this region; the ALB module looks it up via data block."
  type        = string
}

variable "alb_idle_timeout_seconds" {
  description = "ALB idle timeout. Keep below the longest streaming request (default 60s is fine for Next.js)."
  type        = number
  default     = 60
}

# ---- KMS --------------------------------------------------------------------

variable "asymm_sign_key_spec" {
  description = <<-EOT
    Spec for the asymmetric Merkle-root signing CMK. ECC_NIST_P384 is the
    default. Override only if a downstream verifier needs RSA.
  EOT
  type        = string
  default     = "ECC_NIST_P384"
}

# ---- Database (Aurora PostgreSQL) -------------------------------------------
#
# The database module (`modules/rds`) provisions an Amazon Aurora
# PostgreSQL-Compatible cluster (ADR 0029). Capacity is selectable per
# environment; when `aurora_capacity_mode` / `aurora_reader_count` are left at
# their sentinel defaults the stack auto-derives sensible values from
# `var.environment` (see locals.tf): prod → provisioned writer + 1 reader,
# non-prod → Serverless v2, writer-only.

variable "aurora_capacity_mode" {
  description = "Aurora capacity model: 'serverless' (Serverless v2), 'provisioned' (fixed instances), or '' to auto-derive from environment (prod=provisioned, else serverless)."
  type        = string
  default     = ""

  validation {
    condition     = contains(["", "serverless", "provisioned"], var.aurora_capacity_mode)
    error_message = "aurora_capacity_mode must be '', 'serverless', or 'provisioned'."
  }
}

variable "aurora_serverless_min_acu" {
  description = "Serverless v2 minimum Aurora Capacity Units (0.5 increments). Only used in serverless mode."
  type        = number
  default     = 0.5
}

variable "aurora_serverless_max_acu" {
  description = "Serverless v2 maximum Aurora Capacity Units. Only used in serverless mode."
  type        = number
  default     = 16
}

variable "aurora_reader_count" {
  description = "Number of reader instances in addition to the writer. -1 auto-derives from environment (prod=1, else 0). >= 1 enables a real reader endpoint for REPORTING_DATABASE_URL."
  type        = number
  default     = -1
}

variable "rds_instance_class" {
  description = "Instance class for PROVISIONED Aurora instances (db.r6g.large, …). Ignored when capacity is serverless. Env-tuned in tfvars files."
  type        = string
}

# Retained for backward compatibility with existing env wiring. Aurora storage
# auto-scales to 128 TiB with no provisioned ceiling, so these knobs are no
# longer consumed by the database module. Safe to remove from tfvars.
variable "rds_allocated_storage_gb" {
  description = "DEPRECATED (Aurora auto-scales storage). Unused; retained so existing tfvars do not error."
  type        = number
  default     = 100
}

variable "rds_max_allocated_storage_gb" {
  description = "DEPRECATED (Aurora auto-scales storage). Unused; retained so existing tfvars do not error."
  type        = number
  default     = 1000
}

variable "rds_backup_retention_days" {
  description = "Automated backup retention. HIPAA-aware default of 35 (Aurora max). Must remain >= 35 for prod."
  type        = number
  default     = 35

  validation {
    condition     = var.rds_backup_retention_days >= 1 && var.rds_backup_retention_days <= 35
    error_message = "rds_backup_retention_days must be between 1 and 35 (Aurora max)."
  }
}

variable "rds_engine_version" {
  description = "Aurora PostgreSQL engine version. We pin to a known-good 16.x minor. The cluster parameter-group family is derived from the major."
  type        = string
  default     = "16.4"
}

# Retained for backward compatibility. The Aurora cluster parameter-group
# family is derived inside the module from the engine major
# (aurora-postgresql16); this value is no longer consumed.
variable "rds_parameter_group_family" {
  description = "DEPRECATED. Aurora derives its cluster parameter-group family from the engine major. Unused; retained so existing tfvars do not error."
  type        = string
  default     = "postgres16"
}

# Retained for backward compatibility. Aurora is inherently Multi-AZ when it
# has >= 1 reader in a second AZ (see aurora_reader_count); this value is no
# longer consumed.
variable "rds_multi_az" {
  description = "DEPRECATED. Aurora HA comes from instances spread across AZs (see aurora_reader_count). Unused; retained so existing tfvars do not error."
  type        = bool
  default     = true
}

variable "rds_deletion_protection" {
  description = "Block accidental terraform destroy. Required true for prod and staging."
  type        = bool
  default     = true
}

variable "rds_master_username" {
  description = "RDS master username. Password is generated and stored in Secrets Manager."
  type        = string
  default     = "pharmax_admin"
}

variable "rds_database_name" {
  description = "Initial database name created on RDS."
  type        = string
  default     = "pharmax"
}

# ---- Aurora Global Database (cross-region DR) -------------------------------
#
# Standalone by default. Set role = "primary" in the primary region stack
# (it creates the global cluster); set role = "secondary" in the DR-region
# stack and supply the primary's global id + cluster ARN (from the primary
# stack's `rds_global_cluster_id` + `rds_cluster_arn` outputs).

variable "rds_global_cluster_role" {
  description = "Aurora Global Database role for this stack: 'standalone' (default), 'primary', or 'secondary'."
  type        = string
  default     = "standalone"

  validation {
    condition     = contains(["standalone", "primary", "secondary"], var.rds_global_cluster_role)
    error_message = "rds_global_cluster_role must be 'standalone', 'primary', or 'secondary'."
  }
}

variable "rds_enable_proxy" {
  description = "Provision an RDS Proxy connection pooler in front of Aurora (standalone clusters only). Off by default; see modules/rds/proxy.tf."
  type        = bool
  default     = false
}

variable "rds_global_cluster_identifier" {
  description = "Secondary stacks only: the global cluster id from the primary stack's rds_global_cluster_id output."
  type        = string
  default     = ""
}

variable "rds_replication_source_identifier" {
  description = "Secondary stacks only: the primary cluster ARN from the primary stack's rds_cluster_arn output."
  type        = string
  default     = ""
}

variable "rds_performance_insights_retention_days" {
  description = "Performance Insights retention in days (7 = free tier, 731 = paid long-term)."
  type        = number
  default     = 7
}

# ---- ECS --------------------------------------------------------------------

variable "ecs_web_cpu" {
  description = "Fargate CPU units for the web task (256 = .25 vCPU, 1024 = 1 vCPU)."
  type        = number
  default     = 1024
}

variable "ecs_web_memory" {
  description = "Fargate memory MiB for the web task."
  type        = number
  default     = 2048
}

variable "ecs_web_desired_count" {
  description = "Initial web task count. Auto-scaling will move within min/max."
  type        = number
  default     = 2
}

variable "ecs_web_min_count" {
  description = "Auto-scaling floor for web."
  type        = number
  default     = 2
}

variable "ecs_web_max_count" {
  description = "Auto-scaling ceiling for web."
  type        = number
  default     = 10
}

variable "ecs_worker_cpu" {
  description = "Fargate CPU units for the worker task."
  type        = number
  default     = 1024
}

variable "ecs_worker_memory" {
  description = "Fargate memory MiB for the worker task."
  type        = number
  default     = 2048
}

variable "ecs_worker_desired_count" {
  description = "Worker task count. Fixed (no autoscaling) — the worker is a polling drain."
  type        = number
  default     = 2
}

variable "ecs_print_agent_cpu" {
  description = "Fargate CPU units for the print-agent task."
  type        = number
  default     = 512
}

variable "ecs_print_agent_memory" {
  description = "Fargate memory MiB for the print-agent task."
  type        = number
  default     = 1024
}

variable "ecs_print_agent_desired_count" {
  description = "Print-agent task count. Typically 1 per pharmacy site, parameterized."
  type        = number
  default     = 1
}

variable "ecs_log_retention_days" {
  description = "CloudWatch Logs retention for ECS task logs."
  type        = number
}

variable "ecs_container_insights_enabled" {
  description = "Enable ECS Container Insights (recommended; costs ~$2/cluster/month per metric)."
  type        = bool
  default     = true
}

variable "ecs_web_image_tag" {
  description = "Image tag for the web task. CD pipeline updates this on deploy."
  type        = string
  default     = "latest"
}

variable "ecs_worker_image_tag" {
  description = "Image tag for the worker task."
  type        = string
  default     = "latest"
}

variable "ecs_print_agent_image_tag" {
  description = "Image tag for the print-agent task."
  type        = string
  default     = "latest"
}

# ---- App config (non-secret env injected into the web task) ----------------

variable "support_email" {
  description = "Operator-facing support email (SUPPORT_EMAIL). REQUIRED for the web app to boot in production."
  type        = string
  default     = ""
}

variable "app_url" {
  description = "Public base URL of the operator console (APP_URL), e.g. https://app.pharmax.co."
  type        = string
  default     = ""
}

# ---- WAF --------------------------------------------------------------------

variable "waf_rate_limit_per_5min" {
  description = "Per-IP rate limit for the rate-based rule (requests per 5-minute window)."
  type        = number
  default     = 2000
}

# ---- Alarms / SNS -----------------------------------------------------------

variable "alarm_sns_topic_arn" {
  description = "ARN of an existing SNS topic to receive CloudWatch alarms. Empty disables actions (alarm still fires)."
  type        = string
  default     = ""
}

# ---- Secrets ----------------------------------------------------------------

variable "secret_values" {
  description = <<-EOT
    Initial values for app secrets. Each entry creates a Secrets Manager secret
    with the given value. Pass {} (the default) to create empty secrets that an
    operator rotates manually after the first apply — this is recommended so
    secret material does not live in .tfvars at all.
  EOT
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "secret_rotation_lambda_arns" {
  description = <<-EOT
    Optional map of logical-secret-name -> rotation lambda ARN. Wires
    Secrets Manager rotation to the named lambda. Until the lambda is
    deployed, leave this empty and rotate via the runbook.
  EOT
  type        = map(string)
  default     = {}
}

variable "secret_rotation_interval_days" {
  description = "Days between automatic rotation invocations for any secret with a lambda wired."
  type        = number
  default     = 90
}

# ---- Audit archive ----------------------------------------------------------

variable "audit_archive_retention_years" {
  description = "Default Object Lock COMPLIANCE retention on the audit archive bucket. HIPAA-aware default 7."
  type        = number
  default     = 7

  validation {
    condition     = var.audit_archive_retention_years >= 6
    error_message = "audit_archive_retention_years must be at least 6 (HIPAA minimum)."
  }
}

variable "audit_archive_glacier_transition_days" {
  description = "Days after which audit archive objects transition to Glacier Deep Archive. Cannot be 0."
  type        = number
  default     = 90
}

# ---- Security baseline (CloudTrail / Config / GuardDuty / Security Hub) -----
#
# Off by default. These are account+region singletons — enable in EXACTLY ONE
# stack per account+region (the primary). Per-service sub-toggles let another
# tool own an individual service where needed.

variable "enable_security_baseline" {
  description = "Provision the account/region security + audit baseline (CloudTrail, Config, GuardDuty, Security Hub)."
  type        = bool
  default     = false
}

variable "security_enable_cloudtrail" {
  description = "Provision the multi-region CloudTrail trail (only when enable_security_baseline = true)."
  type        = bool
  default     = true
}

variable "security_enable_config" {
  description = "Provision the AWS Config recorder (only when enable_security_baseline = true)."
  type        = bool
  default     = true
}

variable "security_enable_config_rules" {
  description = "Provision the AWS-managed Config compliance rules (only when Config is enabled)."
  type        = bool
  default     = true
}

variable "security_enable_guardduty" {
  description = "Enable the GuardDuty detector (only when enable_security_baseline = true)."
  type        = bool
  default     = true
}

variable "security_enable_securityhub" {
  description = "Enable Security Hub (only when enable_security_baseline = true)."
  type        = bool
  default     = true
}

variable "security_enable_securityhub_fsbp" {
  description = "Subscribe to the AWS Foundational Security Best Practices standard (only when Security Hub is enabled)."
  type        = bool
  default     = true
}

variable "cloudtrail_log_retention_days" {
  description = "Days to retain CloudTrail logs in S3 before expiry (after a 90-day Glacier transition)."
  type        = number
  default     = 2555
}

variable "guardduty_finding_publishing_frequency" {
  description = "GuardDuty finding publishing cadence (FIFTEEN_MINUTES | ONE_HOUR | SIX_HOURS)."
  type        = string
  default     = "SIX_HOURS"
}

# ---- Shield Advanced --------------------------------------------------------
#
# Off by default. Requires an active account-level Shield Advanced
# subscription (paid, annual — there is no Terraform resource for the
# subscription itself; enable it once via the console/API). When on, the ALB
# and (when enabled) the CloudFront distribution are registered as protected
# resources, and CloudFront gets automatic L7 DDoS response via its WAF.

variable "enable_shield_advanced" {
  description = "Register the ALB + CloudFront with AWS Shield Advanced (requires an active subscription)."
  type        = bool
  default     = false
}

# ---- CloudFront -------------------------------------------------------------
#
# Off by default. Enable ONLY in the primary us-east-1 stack (CLOUDFRONT-scoped
# WAF + ACM cert must live in us-east-1). When enabled, the ALB SG is locked to
# the CloudFront origin-facing prefix list so the public internet can only
# reach the app through the edge.

variable "enable_cloudfront" {
  description = "Provision a CloudFront distribution in front of the ALB (us-east-1 stack only)."
  type        = bool
  default     = false
}

variable "cloudfront_origin_domain_name" {
  description = "Custom origin domain CloudFront uses to reach the ALB (a Route53 record on the ALB cert). Empty falls back to the raw ALB DNS, which only works for an HTTP origin / testing — production MUST set this."
  type        = string
  default     = ""
}

variable "cloudfront_aliases" {
  description = "Public alternate domain names served by the distribution. Requires cloudfront_acm_certificate_arn."
  type        = list(string)
  default     = []
}

variable "cloudfront_acm_certificate_arn" {
  description = "ACM certificate ARN in us-east-1 covering cloudfront_aliases. Required when aliases are set."
  type        = string
  default     = ""
}

variable "cloudfront_price_class" {
  description = "CloudFront price class (PriceClass_100 | PriceClass_200 | PriceClass_All)."
  type        = string
  default     = "PriceClass_100"
}

variable "cloudfront_geo_restriction_type" {
  description = "CloudFront geo restriction type: none | whitelist | blacklist."
  type        = string
  default     = "none"
}

variable "cloudfront_geo_restriction_locations" {
  description = "ISO 3166-1-alpha-2 country codes for the geo restriction (used only when type != none)."
  type        = list(string)
  default     = []
}

# ---- ElastiCache (Redis) ----------------------------------------------------
#
# Off by default. Backs @pharmax/cache via REDIS_URL. When enabled, the
# elasticache module provisions a TLS + AUTH Redis replication group in the
# isolated subnets and generates the AUTH token into Secrets Manager. After
# apply, assemble REDIS_URL (rediss://:<token>@<primary>:<port>) into the
# `redis-url` app secret — see modules/elasticache for the note.

variable "enable_elasticache" {
  description = "Provision an ElastiCache Redis replication group for this stack."
  type        = bool
  default     = false
}

variable "elasticache_node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.t4g.small"
}

variable "elasticache_engine_version" {
  description = "Redis engine version."
  type        = string
  default     = "7.1"
}

variable "elasticache_parameter_group_family" {
  description = "ElastiCache parameter group family (must match the engine major, e.g. redis7)."
  type        = string
  default     = "redis7"
}

variable "elasticache_replica_count" {
  description = "Number of read replicas. 0 = single node (no failover/Multi-AZ)."
  type        = number
  default     = 1
}

variable "elasticache_multi_az" {
  description = "Enable Multi-AZ for Redis. Requires elasticache_replica_count > 0."
  type        = bool
  default     = true
}

variable "elasticache_at_rest_kms_key_arn" {
  description = "Optional CMK ARN for Redis at-rest encryption. null = AWS-managed key (cache data is non-PHI by design)."
  type        = string
  default     = null
}

variable "elasticache_maxmemory_policy" {
  description = "Redis eviction policy. allkeys-lru suits a TTL'd cache."
  type        = string
  default     = "allkeys-lru"
}

variable "elasticache_snapshot_retention_days" {
  description = "Days of automatic Redis snapshots to retain. 0 disables snapshots."
  type        = number
  default     = 0
}

# ---- CI/CD deploy role (GitHub Actions OIDC) --------------------------------
#
# Off by default. Enable in EXACTLY ONE working directory per AWS account
# (it provisions the account-global GitHub OIDC provider unless told to
# reuse an existing one). The role it creates is what the deploy workflow
# (.github/workflows/deploy.yml) assumes — surface its ARN as the
# repo/Environment variable AWS_DEPLOY_ROLE_ARN.

variable "enable_cicd_deploy_role" {
  description = "Provision the GitHub Actions OIDC deploy role for this stack."
  type        = bool
  default     = false
}

variable "cicd_github_repository" {
  description = "GitHub repository ('owner/repo') trusted to assume the deploy role. Required when enable_cicd_deploy_role = true."
  type        = string
  default     = ""
}

variable "cicd_github_environment" {
  description = "GitHub Environment name to scope the OIDC subject claim to (recommended; pairs with required-reviewer protection). Ignored when cicd_github_subject_claims is set."
  type        = string
  default     = ""
}

variable "cicd_github_subject_claims" {
  description = "Explicit override for the trusted OIDC 'sub' claims. When empty, derived from cicd_github_environment or the main branch."
  type        = list(string)
  default     = []
}

variable "cicd_create_oidc_provider" {
  description = "Create the account-level GitHub OIDC provider here. Set true in exactly one working directory per account; false elsewhere (and set cicd_oidc_provider_arn)."
  type        = bool
  default     = true
}

variable "cicd_oidc_provider_arn" {
  description = "ARN of an existing GitHub OIDC provider. Required when cicd_create_oidc_provider = false."
  type        = string
  default     = ""
}

# ---- Terraform-apply role (GitHub Actions OIDC) -----------------------------
# Role assumed by .github/workflows/terraform-apply.yml — surface its ARN as
# the repo variable AWS_APPLY_ROLE_ARN_PROD (or _STAGING). Trust is
# exact-match scoped to the gated terraform-apply-<env-region> GitHub
# Environment subject claims.

variable "enable_terraform_apply_role" {
  description = "Provision the GitHub Actions OIDC terraform-apply role for this stack."
  type        = bool
  default     = false
}

variable "tfapply_github_repository" {
  description = "GitHub repository ('owner/repo') trusted to assume the apply role. Required when enable_terraform_apply_role = true."
  type        = string
  default     = ""
}

variable "tfapply_github_environments" {
  description = "Gated GitHub Environment names trusted to assume the apply role (e.g. [\"terraform-apply-prod-ue1\", \"terraform-apply-prod-uw2\"]). Required when enable_terraform_apply_role = true."
  type        = list(string)
  default     = []
}

variable "tfapply_create_oidc_provider" {
  description = "Create the account-level GitHub OIDC provider in the apply-role module. Usually false — the cicd-deploy module owns it when enabled in the same working directory (the root composition passes its ARN through automatically)."
  type        = bool
  default     = false
}

variable "tfapply_oidc_provider_arn" {
  description = "Explicit ARN of an existing GitHub OIDC provider. When empty, falls back to the cicd-deploy module's provider (if enabled here), else the module must create one (tfapply_create_oidc_provider = true)."
  type        = string
  default     = ""
}
