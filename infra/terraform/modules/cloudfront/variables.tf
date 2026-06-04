variable "name_prefix" {
  description = "Prefix applied to resource names (pharmax-<env>-<region-short>)."
  type        = string
}

variable "origin_domain_name" {
  description = <<-EOT
    The domain name CloudFront uses to reach the ALB origin over HTTPS.

    MUST be a domain the ALB's ACM certificate covers (e.g. a Route53 record
    like origin.app.example.com pointing at the ALB). Do NOT use the raw
    *.elb.amazonaws.com name: CloudFront validates the origin certificate
    against this domain and the ALB cert does not cover the ELB DNS name, so
    the origin handshake would 502.
  EOT
  type        = string

  validation {
    condition     = length(var.origin_domain_name) > 0
    error_message = "origin_domain_name is required when CloudFront is enabled."
  }
}

variable "aliases" {
  description = "Alternate domain names (CNAMEs) for the distribution. Requires acm_certificate_arn. Empty = use the default *.cloudfront.net domain."
  type        = list(string)
  default     = []
}

variable "acm_certificate_arn" {
  description = "ACM certificate ARN in us-east-1 covering `aliases`. Required when aliases is set; ignored otherwise."
  type        = string
  default     = ""
}

variable "price_class" {
  description = "CloudFront price class (PriceClass_100 | PriceClass_200 | PriceClass_All)."
  type        = string
  default     = "PriceClass_100"
}

variable "rate_limit_per_5min" {
  description = "Per-IP rate limit for the CloudFront WAF rate-based rule (requests per 5-minute window)."
  type        = number
  default     = 2000
}

variable "geo_restriction_type" {
  description = "Geo restriction type: none | whitelist | blacklist."
  type        = string
  default     = "none"
}

variable "geo_restriction_locations" {
  description = "ISO 3166-1-alpha-2 country codes for the geo restriction (only used when type != none)."
  type        = list(string)
  default     = []
}

variable "enable_shield_advanced" {
  description = "Register the distribution with AWS Shield Advanced. Requires an active account-level Shield Advanced subscription."
  type        = bool
  default     = false
}

variable "shield_l7_automatic_response" {
  description = "Enable Shield Advanced automatic application-layer (L7) DDoS response using the attached WAF web ACL (only when Shield Advanced is enabled)."
  type        = bool
  default     = true
}

variable "shield_l7_automatic_response_action" {
  description = "Action for the automatic L7 response: BLOCK (mitigate) or COUNT (observe-only)."
  type        = string
  default     = "BLOCK"

  validation {
    condition     = contains(["BLOCK", "COUNT"], var.shield_l7_automatic_response_action)
    error_message = "shield_l7_automatic_response_action must be 'BLOCK' or 'COUNT'."
  }
}

variable "tags" {
  description = "Tags applied to the distribution + WAF."
  type        = map(string)
  default     = {}
}
