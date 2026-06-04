# =============================================================================
# ALB module — public ALB with HTTPS, HTTP→HTTPS redirect, web target group.
#
# - Cert is looked up by domain (must be ISSUED + in this region).
# - HTTP listener 301-redirects to HTTPS.
# - HTTPS listener uses a modern TLS policy (TLS-1-3-2021-06).
# - Target group is ip-target-type so it works with Fargate.
# - Access logs OPTIONAL (set via var.access_logs_bucket). Logs should
#   live in a separate bucket from documents/audit; that bucket lives
#   outside this stack to avoid log-storage circular dependencies.
# =============================================================================

data "aws_acm_certificate" "this" {
  domain      = var.acm_certificate_domain
  statuses    = ["ISSUED"]
  most_recent = true
}

# ---- Security group ---------------------------------------------------------
# Default: the ALB SG accepts 80/443 from the internet. When CloudFront is in
# front (`restrict_ingress_to_cloudfront = true`), ingress is locked to the
# AWS-managed CloudFront origin-facing prefix list so the public internet
# cannot reach the ALB directly — all traffic must traverse the edge (WAF +
# Shield). The ECS task SG accepts traffic from THIS SG only (ecs module).

resource "aws_security_group" "alb" {
  name        = "${var.name_prefix}-alb"
  description = var.restrict_ingress_to_cloudfront ? "Pharmax ALB SG - CloudFront origin only" : "Pharmax ALB SG - public 80/443"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-alb"
  })
}

# CloudFront's published origin-facing IP ranges, as an AWS-managed prefix
# list. Only looked up when we are locking the ALB to the edge.
data "aws_ec2_managed_prefix_list" "cloudfront" {
  count = var.restrict_ingress_to_cloudfront ? 1 : 0
  name  = "com.amazonaws.global.cloudfront.origin-facing"
}

# Public ingress (default posture, no CloudFront).
resource "aws_security_group_rule" "alb_ingress_https" {
  count             = var.restrict_ingress_to_cloudfront ? 0 : 1
  type              = "ingress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  ipv6_cidr_blocks  = ["::/0"]
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from the public internet"
}

resource "aws_security_group_rule" "alb_ingress_http" {
  count             = var.restrict_ingress_to_cloudfront ? 0 : 1
  type              = "ingress"
  from_port         = 80
  to_port           = 80
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  ipv6_cidr_blocks  = ["::/0"]
  security_group_id = aws_security_group.alb.id
  description       = "HTTP (redirected to HTTPS)"
}

# CloudFront-only ingress. The distribution's origin requests are HTTPS-only
# (see the cloudfront module), so we only open 443 to the edge prefix list.
resource "aws_security_group_rule" "alb_ingress_https_cloudfront" {
  count             = var.restrict_ingress_to_cloudfront ? 1 : 0
  type              = "ingress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  prefix_list_ids   = [data.aws_ec2_managed_prefix_list.cloudfront[0].id]
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from the CloudFront origin-facing prefix list only"
}

resource "aws_security_group_rule" "alb_egress_all" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
  ipv6_cidr_blocks  = ["::/0"]
  security_group_id = aws_security_group.alb.id
  description       = "ALB to target traffic"
}

# ---- ALB --------------------------------------------------------------------

resource "aws_lb" "this" {
  name               = "${var.name_prefix}-alb"
  load_balancer_type = "application"
  internal           = false
  security_groups    = [aws_security_group.alb.id]
  subnets            = var.public_subnet_ids

  idle_timeout                     = var.idle_timeout_seconds
  drop_invalid_header_fields       = var.drop_invalid_header_fields
  enable_deletion_protection       = var.enable_deletion_protection
  enable_cross_zone_load_balancing = true
  enable_http2                     = true

  dynamic "access_logs" {
    for_each = var.access_logs_bucket != "" ? [1] : []
    content {
      bucket  = var.access_logs_bucket
      prefix  = var.access_logs_prefix
      enabled = true
    }
  }

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-alb"
  })
}

# ---- Web target group -------------------------------------------------------
#
# `target_type = ip` is required for Fargate. The health check path defaults
# to `/api/health`. Pharmax should expose this from the Next.js app.

resource "aws_lb_target_group" "web" {
  name        = "${var.name_prefix}-tg-web"
  vpc_id      = var.vpc_id
  port        = var.target_group_port
  protocol    = "HTTP"
  target_type = "ip"

  deregistration_delay = 30

  health_check {
    enabled             = true
    path                = var.target_group_health_check_path
    matcher             = "200-299"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
    protocol            = "HTTP"
  }

  stickiness {
    type            = "lb_cookie"
    cookie_duration = 86400
    enabled         = false
  }

  tags = merge(var.tags, {
    Service = "web"
  })

  lifecycle {
    create_before_destroy = true
  }
}

# ---- Shield Advanced (optional) ---------------------------------------------
# Requires an active account-level Shield Advanced subscription (a paid,
# annual commitment configured out-of-band — there is no Terraform resource
# for the subscription itself). Protects the ALB with enhanced DDoS
# mitigation + access to the Shield Response Team / cost-protection.

resource "aws_shield_protection" "alb" {
  count        = var.enable_shield_advanced ? 1 : 0
  name         = "${var.name_prefix}-alb"
  resource_arn = aws_lb.this.arn
  tags         = var.tags
}

# ---- HTTP → HTTPS redirect --------------------------------------------------

resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

# ---- HTTPS listener ---------------------------------------------------------

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = data.aws_acm_certificate.this.arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }
}
