variable "name_prefix" {
  description = "Resource-name prefix."
  type        = string
}

variable "vpc_id" {
  description = "VPC the cluster lives in."
  type        = string
}

variable "isolated_subnet_ids" {
  description = "Subnet ids (must be in the isolated tier — no internet egress)."
  type        = list(string)

  validation {
    condition     = length(var.isolated_subnet_ids) >= 2
    error_message = "Aurora subnet group requires at least 2 subnets in distinct AZs."
  }
}

variable "ingress_security_group_ids" {
  description = "Security groups allowed to reach Aurora on port 5432 (typically the ECS task SG)."
  type        = list(string)
}

variable "kms_key_arn" {
  description = "CMK for storage + perf-insights + the AWS-managed master-user secret."
  type        = string
}

variable "engine_version" {
  description = "Aurora PostgreSQL engine version (e.g. 16.4). The cluster parameter-group family is derived from the major (aurora-postgresql16)."
  type        = string
}

variable "capacity_mode" {
  description = "Aurora capacity model: 'serverless' (Aurora Serverless v2, db.serverless) or 'provisioned' (fixed instance_class)."
  type        = string

  validation {
    condition     = contains(["serverless", "provisioned"], var.capacity_mode)
    error_message = "capacity_mode must be 'serverless' or 'provisioned'."
  }
}

variable "instance_class" {
  description = "Instance class for PROVISIONED mode (db.r6g.large, …). Ignored in serverless mode (db.serverless is used)."
  type        = string
  default     = "db.r6g.large"
}

variable "serverless_min_acu" {
  description = "Serverless v2 minimum Aurora Capacity Units (0.5 increments). Only used in serverless mode."
  type        = number
  default     = 0.5
}

variable "serverless_max_acu" {
  description = "Serverless v2 maximum Aurora Capacity Units. Only used in serverless mode."
  type        = number
  default     = 16
}

variable "reader_count" {
  description = "Number of reader instances in addition to the writer. >= 1 enables a real reader endpoint for REPORTING_DATABASE_URL."
  type        = number
  default     = 1

  validation {
    condition     = var.reader_count >= 0 && var.reader_count <= 14
    error_message = "reader_count must be between 0 and 14 (Aurora allows up to 15 instances total)."
  }
}

variable "backup_retention_days" {
  description = "Automated backup retention (1-35)."
  type        = number
}

variable "backup_window" {
  description = "UTC backup window."
  type        = string
  default     = "03:00-04:00"
}

variable "maintenance_window" {
  description = "UTC weekly maintenance window."
  type        = string
  default     = "Sun:04:30-Sun:05:30"
}

variable "deletion_protection" {
  description = "Block accidental destroy."
  type        = bool
}

variable "master_username" {
  description = "Master username."
  type        = string
}

variable "database_name" {
  description = "Initial database name."
  type        = string
}

variable "performance_insights_retention_days" {
  description = "Performance insights retention (7 free; 731 paid)."
  type        = number
}

variable "monitoring_interval_seconds" {
  description = "Enhanced monitoring sampling interval. 0 disables."
  type        = number
  default     = 60
}

variable "enabled_cloudwatch_logs_exports" {
  description = "Which Postgres log streams to export to CloudWatch."
  type        = list(string)
  default     = ["postgresql"]
}

variable "tags" {
  description = "Tags to apply to every database resource."
  type        = map(string)
  default     = {}
}

# ---- RDS Proxy (connection pooler) -----------------------------------------
#
# Opt-in. When enabled (on a standalone, managed-password cluster) it creates
# an RDS Proxy in front of the cluster so autoscaled compute multiplexes onto a
# warm connection pool instead of opening direct backends. Repoint DATABASE_URL
# at the `proxy_endpoint` output to use it.

variable "enable_rds_proxy" {
  description = "Provision an RDS Proxy connection pooler in front of the cluster. Requires global_cluster_role = 'standalone' (managed master password)."
  type        = bool
  default     = false
}

variable "proxy_max_connections_percent" {
  description = "RDS Proxy: max % of the cluster's max_connections the proxy may open to the backend."
  type        = number
  default     = 100
}

variable "proxy_max_idle_connections_percent" {
  description = "RDS Proxy: max % of backend connections the proxy keeps idle in the pool."
  type        = number
  default     = 50
}

variable "proxy_idle_client_timeout_seconds" {
  description = "RDS Proxy: seconds an idle client connection is held before the proxy closes it."
  type        = number
  default     = 1800
}

# ---- Aurora Global Database (cross-region DR) -------------------------------
#
# Aurora Global Database links a primary cluster (read/write) in one region to
# one or more secondary clusters (read-only, sub-second replication lag) in
# other regions, with managed promotion for regional failover (RPO ~1s,
# RTO < 1 min). It supersedes the manual warm-standby posture.
#
#   - "standalone" (default): a single-region cluster — unchanged behavior.
#   - "primary":   creates the global cluster + the primary cluster. Outputs
#                  `global_cluster_id` + `cluster_arn` for the secondary stack.
#   - "secondary": joins an existing global cluster as a read replica. The
#                  master credentials + database are inherited from the
#                  primary; only this region's KMS key is set locally.
#
# Cross-state wiring: the secondary stack lives in a different region with its
# own state, so it takes the primary's `global_cluster_identifier` +
# `replication_source_identifier` (the primary cluster ARN) as inputs — the
# operator copies them from the primary stack's outputs (the same
# operator-driven pattern used for DATABASE_URL / DNS).

variable "global_cluster_role" {
  description = "Role of this cluster in an Aurora Global Database: 'standalone' (default), 'primary', or 'secondary'."
  type        = string
  default     = "standalone"

  validation {
    condition     = contains(["standalone", "primary", "secondary"], var.global_cluster_role)
    error_message = "global_cluster_role must be 'standalone', 'primary', or 'secondary'."
  }
}

variable "global_cluster_identifier" {
  description = "For a 'secondary' cluster: the global cluster identifier from the primary stack's `global_cluster_id` output. Empty otherwise."
  type        = string
  default     = ""
}

variable "replication_source_identifier" {
  description = "For a 'secondary' cluster: the primary cluster ARN from the primary stack's `cluster_arn` output. Empty otherwise."
  type        = string
  default     = ""
}
