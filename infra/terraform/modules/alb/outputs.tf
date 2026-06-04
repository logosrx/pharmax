output "alb_arn" {
  value = aws_lb.this.arn
}

output "alb_arn_suffix" {
  description = "Suffix used by CloudWatch metric resource ARNs."
  value       = aws_lb.this.arn_suffix
}

output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "alb_zone_id" {
  value = aws_lb.this.zone_id
}

output "security_group_id" {
  value = aws_security_group.alb.id
}

output "target_group_web_arn" {
  value = aws_lb_target_group.web.arn
}

output "target_group_web_arn_suffix" {
  description = "Suffix used by CloudWatch metric resource ARNs."
  value       = aws_lb_target_group.web.arn_suffix
}

output "https_listener_arn" {
  value = aws_lb_listener.https.arn
}

output "shield_protection_id" {
  description = "Shield Advanced protection id for the ALB (null unless enabled)."
  value       = try(aws_shield_protection.alb[0].id, null)
}
