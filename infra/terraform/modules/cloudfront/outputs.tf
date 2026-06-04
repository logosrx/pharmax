output "distribution_id" {
  description = "CloudFront distribution id."
  value       = aws_cloudfront_distribution.this.id
}

output "distribution_arn" {
  description = "CloudFront distribution ARN."
  value       = aws_cloudfront_distribution.this.arn
}

output "distribution_domain_name" {
  description = "CloudFront edge domain (*.cloudfront.net). Point your public DNS (the app domain) at this via a CNAME/ALIAS."
  value       = aws_cloudfront_distribution.this.domain_name
}

output "distribution_hosted_zone_id" {
  description = "CloudFront hosted zone id for Route53 ALIAS records (always Z2FDTNDATAQYW2)."
  value       = aws_cloudfront_distribution.this.hosted_zone_id
}

output "web_acl_arn" {
  description = "ARN of the CLOUDFRONT-scoped WAF web ACL."
  value       = aws_wafv2_web_acl.this.arn
}

output "shield_protection_id" {
  description = "Shield Advanced protection id for the distribution (null unless enabled)."
  value       = try(aws_shield_protection.this[0].id, null)
}
