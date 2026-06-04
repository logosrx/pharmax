# =============================================================================
# CloudFront module — global edge CDN in front of the ALB.
#
# Why CloudFront in front of ECS/ALB:
#   - TLS termination + HTTP/2+3 at the edge, closer to operators.
#   - Edge caching of immutable Next.js assets (`/_next/static/*`) so the
#     ALB/Fargate tier only serves dynamic traffic.
#   - A CLOUDFRONT-scoped WAF web ACL (AWS DDoS Shield Standard is always on
#     at the edge; the WAF adds managed rule groups + a rate limit).
#   - Origin shielding: the ALB SG is locked to the CloudFront origin-facing
#     prefix list (see the alb module's `restrict_ingress_to_cloudfront`), so
#     the public internet cannot reach the ALB directly.
#
# REGION CONSTRAINT: a CLOUDFRONT-scoped `aws_wafv2_web_acl` and the ACM
# certificate for any alternate domain MUST live in us-east-1. Enable this
# module ONLY in the primary us-east-1 stack (its default provider is
# us-east-1). CloudFront itself is global — one distribution fronts the
# primary region's ALB.
#
# ORIGIN TLS CONSTRAINT: for an HTTPS origin, CloudFront validates the origin
# certificate against `origin_domain_name`. The ALB's ACM cert is issued for
# the app domain, NOT the `*.elb.amazonaws.com` name — so production MUST set
# `origin_domain_name` to a custom domain (a Route53 record pointing at the
# ALB) that the ALB cert covers. Pointing it at the raw ALB DNS will fail the
# origin handshake (502). See variables.tf.
# =============================================================================

# AWS-managed policies (no need to author our own for the common cases).
data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

# Forwards all viewer headers/cookies/query to the origin EXCEPT Host (so
# CloudFront uses the origin domain for SNI/Host, which is what the ALB cert
# + Next server expect).
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

# Adds HSTS, X-Content-Type-Options, Referrer-Policy, etc. at the edge.
data "aws_cloudfront_response_headers_policy" "security_headers" {
  name = "Managed-SecurityHeadersPolicy"
}

locals {
  origin_id         = "${var.name_prefix}-alb-origin"
  use_custom_domain = length(var.aliases) > 0 && var.acm_certificate_arn != ""
}

# ---- CLOUDFRONT-scoped WAF --------------------------------------------------
# Mirrors the regional ALB WAF rule set (the two scopes cannot share an ACL).

resource "aws_wafv2_web_acl" "this" {
  name        = "${var.name_prefix}-cf-waf"
  description = "Pharmax CloudFront WAF - managed rule groups + rate limit"
  scope       = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 10
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-cf-CommonRuleSet"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 20
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-cf-KnownBadInputs"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWSManagedRulesAmazonIpReputationList"
    priority = 30
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesAmazonIpReputationList"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-cf-AmazonIpReputation"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "AWSManagedRulesSQLiRuleSet"
    priority = 40
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesSQLiRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-cf-SQLi"
      sampled_requests_enabled   = true
    }
  }

  rule {
    name     = "RateLimitPerIp"
    priority = 50
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = var.rate_limit_per_5min
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.name_prefix}-cf-RateLimit"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.name_prefix}-cf-waf"
    sampled_requests_enabled   = true
  }

  tags = var.tags
}

# ---- Distribution -----------------------------------------------------------

resource "aws_cloudfront_distribution" "this" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "Pharmax operator console (${var.name_prefix})"
  price_class     = var.price_class
  http_version    = "http2and3"
  web_acl_id      = aws_wafv2_web_acl.this.arn
  aliases         = local.use_custom_domain ? var.aliases : null

  origin {
    domain_name = var.origin_domain_name
    origin_id   = local.origin_id

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Default: dynamic app traffic. No caching; forward everything (minus Host)
  # to the origin so auth cookies + Clerk session headers reach Next.
  default_cache_behavior {
    target_origin_id       = local.origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security_headers.id
  }

  # Next.js build output is content-hashed + immutable → cache aggressively.
  ordered_cache_behavior {
    path_pattern           = "/_next/static/*"
    target_origin_id       = local.origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security_headers.id
  }

  restrictions {
    geo_restriction {
      restriction_type = var.geo_restriction_type
      locations        = var.geo_restriction_locations
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = local.use_custom_domain ? null : true
    acm_certificate_arn            = local.use_custom_domain ? var.acm_certificate_arn : null
    ssl_support_method             = local.use_custom_domain ? "sni-only" : null
    minimum_protocol_version       = local.use_custom_domain ? "TLSv1.2_2021" : "TLSv1"
  }

  tags = var.tags
}

# ---- Shield Advanced (optional) ---------------------------------------------
# Requires an active account-level Shield Advanced subscription (paid, annual,
# configured out-of-band — no Terraform resource for the subscription). The
# CloudFront protection is created in us-east-1 (this module's region).

resource "aws_shield_protection" "this" {
  count        = var.enable_shield_advanced ? 1 : 0
  name         = "${var.name_prefix}-cloudfront"
  resource_arn = aws_cloudfront_distribution.this.arn
  tags         = var.tags
}

# Automatic application-layer (L7) DDoS response. Shield uses the WAF web ACL
# already attached to the distribution to create/relax mitigation rules
# automatically during an attack. `BLOCK` drops attack traffic; `COUNT` is
# observe-only for tuning before going to block.
resource "aws_shield_application_layer_automatic_response" "this" {
  count        = var.enable_shield_advanced && var.shield_l7_automatic_response ? 1 : 0
  resource_arn = aws_cloudfront_distribution.this.arn
  action       = var.shield_l7_automatic_response_action

  depends_on = [aws_shield_protection.this]
}
