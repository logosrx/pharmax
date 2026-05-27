variable "name_prefix" {
  description = "Prefix applied to every resource name."
  type        = string
}

variable "vpc_cidr" {
  description = "Primary VPC CIDR. Should be at least a /18 to fit 3 AZ x 3 tiers."
  type        = string
}

variable "availability_zone_count" {
  description = "Number of AZs to span. Each AZ gets one public, one private, one isolated subnet."
  type        = number
}

variable "nat_gateway_strategy" {
  description = "single = one NAT gateway in az[0]; per_az = one per AZ (HA)."
  type        = string
}

variable "flow_logs_retention_days" {
  description = "CloudWatch Logs retention for VPC flow logs."
  type        = number
}

variable "flow_logs_kms_key_arn" {
  description = "KMS key for VPC flow log group encryption."
  type        = string
}

variable "tags" {
  description = "Tags to apply to every resource."
  type        = map(string)
  default     = {}
}
