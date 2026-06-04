variable "name_prefix" {
  description = "Prefix applied to resource names. Matches the rest of the stack (pharmax-<env>-<region-short>)."
  type        = string
}

variable "vpc_id" {
  description = "VPC the Redis SG lives in."
  type        = string
}

variable "subnet_ids" {
  description = "Isolated subnet ids for the cache subnet group (no NAT, no IGW)."
  type        = list(string)
}

variable "ingress_security_group_ids" {
  description = "Security group ids allowed to reach Redis on 6379 (the ECS task SG)."
  type        = list(string)
}

variable "secrets_kms_key_arn" {
  description = "CMK ARN used to encrypt the generated AUTH token secret."
  type        = string
}

variable "node_type" {
  description = "ElastiCache node type."
  type        = string
  default     = "cache.t4g.small"
}

variable "engine_version" {
  description = "Redis engine version."
  type        = string
  default     = "7.1"
}

variable "parameter_group_family" {
  description = "ElastiCache parameter group family (must match the engine major, e.g. redis7)."
  type        = string
  default     = "redis7"
}

variable "replica_count" {
  description = "Number of read replicas. 0 = single node (no failover/Multi-AZ)."
  type        = number
  default     = 1

  validation {
    condition     = var.replica_count >= 0 && var.replica_count <= 5
    error_message = "replica_count must be between 0 and 5."
  }
}

variable "multi_az" {
  description = "Enable Multi-AZ. Requires replica_count > 0."
  type        = bool
  default     = true
}

variable "at_rest_kms_key_arn" {
  description = "Optional CMK ARN for at-rest encryption. null = AWS-managed key (cache data is non-PHI by design)."
  type        = string
  default     = null
}

variable "maxmemory_policy" {
  description = "Eviction policy. allkeys-lru suits a TTL'd cache."
  type        = string
  default     = "allkeys-lru"
}

variable "snapshot_retention_days" {
  description = "Days of automatic snapshots to retain. 0 disables snapshots (a pure cache rarely needs them)."
  type        = number
  default     = 0
}

variable "maintenance_window" {
  description = "Weekly maintenance window (UTC)."
  type        = string
  default     = "sun:06:00-sun:07:00"
}

variable "apply_immediately" {
  description = "Apply modifications immediately rather than in the maintenance window."
  type        = bool
  default     = false
}

variable "secret_recovery_in_days" {
  description = "Secrets Manager recovery window for the AUTH token secret."
  type        = number
  default     = 7
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}
