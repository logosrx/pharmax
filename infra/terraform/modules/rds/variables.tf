variable "name_prefix" {
  description = "Resource-name prefix."
  type        = string
}

variable "vpc_id" {
  description = "VPC the instance lives in."
  type        = string
}

variable "isolated_subnet_ids" {
  description = "Subnet ids (must be in the isolated tier — no internet egress)."
  type        = list(string)

  validation {
    condition     = length(var.isolated_subnet_ids) >= 2
    error_message = "RDS subnet group requires at least 2 subnets in distinct AZs."
  }
}

variable "ingress_security_group_ids" {
  description = "Security groups allowed to reach RDS on port 5432 (typically the ECS task SG)."
  type        = list(string)
}

variable "kms_key_arn" {
  description = "CMK for storage + perf-insights + the AWS-managed master-user secret."
  type        = string
}

variable "engine_version" {
  description = "Postgres engine minor (e.g. 16.4)."
  type        = string
}

variable "parameter_group_family" {
  description = "RDS parameter group family (e.g. postgres16)."
  type        = string
}

variable "instance_class" {
  description = "RDS instance class (db.r6g.large, db.t4g.medium, …)."
  type        = string
}

variable "allocated_storage_gb" {
  description = "Initial storage."
  type        = number
}

variable "max_allocated_storage_gb" {
  description = "Storage autoscaling ceiling."
  type        = number
}

variable "backup_retention_days" {
  description = "Automated backup retention (7-35)."
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

variable "multi_az" {
  description = "Enable Multi-AZ standby."
  type        = bool
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
  default     = ["postgresql", "upgrade"]
}

variable "tags" {
  description = "Tags to apply to every RDS resource."
  type        = map(string)
  default     = {}
}
