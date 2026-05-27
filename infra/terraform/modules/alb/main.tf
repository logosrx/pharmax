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
# The ALB SG accepts 80/443 from the internet. The ECS task SG accepts traffic
# from THIS SG only (declared in the ecs module).

resource "aws_security_group" "alb" {
  name        = "${var.name_prefix}-alb"
  description = "Pharmax ALB SG — public 80/443"
  vpc_id      = var.vpc_id

  tags = merge(var.tags, {
    Name = "${var.name_prefix}-alb"
  })
}

resource "aws_security_group_rule" "alb_ingress_https" {
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
  type              = "ingress"
  from_port         = 80
  to_port           = 80
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  ipv6_cidr_blocks  = ["::/0"]
  security_group_id = aws_security_group.alb.id
  description       = "HTTP (redirected to HTTPS)"
}

resource "aws_security_group_rule" "alb_egress_all" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
  ipv6_cidr_blocks  = ["::/0"]
  security_group_id = aws_security_group.alb.id
  description       = "ALB→target traffic"
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
