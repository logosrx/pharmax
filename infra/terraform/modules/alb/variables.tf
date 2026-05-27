variable "name_prefix" {
  description = "Prefix applied to ALB-related resource names."
  type        = string
}

variable "vpc_id" {
  description = "VPC id."
  type        = string
}

variable "public_subnet_ids" {
  description = "Public subnets for the ALB (at least 2 across AZs)."
  type        = list(string)

  validation {
    condition     = length(var.public_subnet_ids) >= 2
    error_message = "ALB requires at least 2 public subnets."
  }
}

variable "acm_certificate_domain" {
  description = "Domain of the existing ACM cert (data source lookup)."
  type        = string
}

variable "idle_timeout_seconds" {
  description = "ALB idle timeout."
  type        = number
  default     = 60
}

variable "enable_deletion_protection" {
  description = "Block accidental destroy via AWS API. Recommended true in non-dev."
  type        = bool
  default     = true
}

variable "target_group_health_check_path" {
  description = "Path the ALB target group health check probes on the web service."
  type        = string
  default     = "/api/health"
}

variable "target_group_port" {
  description = "Container port for the web service."
  type        = number
  default     = 3000
}

variable "drop_invalid_header_fields" {
  description = "Drop malformed HTTP headers at the ALB (defense-in-depth against smuggling)."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Tags applied to every ALB resource."
  type        = map(string)
  default     = {}
}

variable "access_logs_bucket" {
  description = "Optional S3 bucket name for ALB access logs. Empty disables access logging (recommended only in dev)."
  type        = string
  default     = ""
}

variable "access_logs_prefix" {
  description = "Object key prefix for ALB access logs."
  type        = string
  default     = "alb-access-logs"
}
