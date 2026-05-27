variable "name_prefix" {
  description = "Prefix applied to Web ACL name."
  type        = string
}

variable "alb_arn" {
  description = "ARN of the ALB to associate the Web ACL with."
  type        = string
}

variable "rate_limit_per_5min" {
  description = "Per-IP rate limit (requests in a 5-minute window)."
  type        = number
}

variable "metric_namespace" {
  description = "CloudWatch metric namespace for WAF metrics."
  type        = string
  default     = "AWS/WAFV2"
}

variable "tags" {
  description = "Tags applied to the Web ACL."
  type        = map(string)
  default     = {}
}
