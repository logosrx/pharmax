# =============================================================================
# Synthetics module — outside-in heartbeat canary.
#
# Every alarm in `modules/cloudwatch` watches the platform from the INSIDE
# (service metrics, DB metrics, app-emitted custom metrics). All of them share
# one blind spot: they cannot see a failure that sits in front of the ALB —
# DNS, an expired certificate, CloudFront misrouting, a WAF rule blocking
# everyone, a region-level network problem. The heartbeat canary closes that
# gap by requesting the public health endpoint (`/api/health`, the deliberate
# no-auth liveness probe in `apps/web/app/api/health/route.ts`) from AWS's
# synthetics fleet — OUTSIDE the VPC — every minute.
#
# What this module deliberately does NOT do (see README.md):
#   - No authenticated flows. The canary holds no credentials and never sees
#     PHI; it proves reachability, not correctness of the operator console.
#   - No VPC config. Running the canary inside the VPC would reintroduce the
#     exact blind spot it exists to remove.
#
# Severity routing follows the same two-topic contract as
# `modules/cloudwatch`; `scripts/check-alarm-actions.ts` checks this file too
# (it is listed in ALARM_MODULE_FILES).
# =============================================================================

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  critical_topic_arn = var.critical_alarm_sns_topic_arn != "" ? var.critical_alarm_sns_topic_arn : var.alarm_sns_topic_arn
  warning_topic_arn  = var.warning_alarm_sns_topic_arn != "" ? var.warning_alarm_sns_topic_arn : var.alarm_sns_topic_arn

  critical_alarm_actions = local.critical_topic_arn != "" ? [local.critical_topic_arn] : []
  # The canary alarm is critical-tier, so this list is unused today — but
  # scripts/check-alarm-actions.ts requires both severity action lists to be
  # declared in every alarm-bearing file, so it must stay.
  # tflint-ignore: terraform_unused_declarations
  warning_alarm_actions = local.warning_topic_arn != "" ? [local.warning_topic_arn] : []

  # Canary names are limited to 21 lowercase [a-z0-9_-] characters. The
  # staging prefix (`pharmax-staging-ue1`) + a suffix does not fit, so the
  # name is truncated deliberately rather than failing apply. The alarm and
  # bucket below carry the full prefix, so the pager and the operator still
  # see the environment unambiguously.
  canary_name = substr("${var.name_prefix}-hb", 0, 21)

  script_path = "${path.module}/canary/heartbeat.js"
}

# ---- Canary package ----------------------------------------------------------
#
# The runtime expects the handler at `nodejs/node_modules/<file>.js` inside
# the zip. The output path embeds the script's hash: `aws_synthetics_canary`
# does not track zip CONTENT, only the path, so a content-addressed path is
# what makes a script edit actually roll out on the next apply.

data "archive_file" "heartbeat" {
  type        = "zip"
  output_path = "${path.module}/.build/heartbeat-${filemd5(local.script_path)}.zip"

  source {
    content  = file(local.script_path)
    filename = "nodejs/node_modules/heartbeat.js"
  }
}

# ---- Artifacts bucket --------------------------------------------------------
#
# Canary artifacts are HAR files, logs, and screenshots of the PUBLIC health
# endpoint — no PHI by construction, so SSE-S3 (not the PHI CMK) is
# sufficient. Same public-access/TLS posture as every other bucket in this
# stack; lifecycle keeps the bucket from growing forever (a 1-minute canary
# writes ~1,440 artifact sets a day).

resource "random_id" "suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "artifacts" {
  bucket = "${var.name_prefix}-synthetics-artifacts-${random_id.suffix.hex}"

  tags = merge(var.tags, {
    Purpose            = "synthetics-artifacts"
    DataClassification = "operational"
  })
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

data "aws_iam_policy_document" "artifacts_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.artifacts.arn,
      "${aws_s3_bucket.artifacts.arn}/*"
    ]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  policy = data.aws_iam_policy_document.artifacts_bucket.json
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    id     = "expire-artifacts"
    status = "Enabled"

    filter {}

    expiration {
      days = var.artifact_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# ---- Execution role ----------------------------------------------------------
#
# Least privilege per the CloudWatch Synthetics documentation: write artifacts
# to ONE prefix of ONE bucket, publish metrics to the CloudWatchSynthetics
# namespace only, and write to the canary's own Lambda log groups
# (`/aws/lambda/cwsyn-*`). Nothing else — the canary holds no application
# credentials and can reach no application data store.

data "aws_iam_policy_document" "canary_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "canary" {
  name               = "${var.name_prefix}-synthetics-canary"
  assume_role_policy = data.aws_iam_policy_document.canary_assume.json

  tags = var.tags
}

data "aws_iam_policy_document" "canary" {
  statement {
    sid    = "ArtifactWrite"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:GetObject"
    ]
    resources = ["${aws_s3_bucket.artifacts.arn}/*"]
  }

  statement {
    sid       = "ArtifactBucketLocation"
    effect    = "Allow"
    actions   = ["s3:GetBucketLocation"]
    resources = [aws_s3_bucket.artifacts.arn]
  }

  # The runtime calls ListAllMyBuckets while resolving the artifact location;
  # it takes no resource-level scoping.
  statement {
    sid       = "ListBuckets"
    effect    = "Allow"
    actions   = ["s3:ListAllMyBuckets"]
    resources = ["*"]
  }

  statement {
    sid       = "PublishCanaryMetrics"
    effect    = "Allow"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["CloudWatchSynthetics"]
    }
  }

  statement {
    sid    = "CanaryLambdaLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents"
    ]
    resources = [
      "arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/cwsyn-*"
    ]
  }
}

resource "aws_iam_role_policy" "canary" {
  name   = "${var.name_prefix}-synthetics-canary"
  role   = aws_iam_role.canary.id
  policy = data.aws_iam_policy_document.canary.json
}

# ---- Canary ------------------------------------------------------------------

resource "aws_synthetics_canary" "heartbeat" {
  name                 = local.canary_name
  artifact_s3_location = "s3://${aws_s3_bucket.artifacts.bucket}/heartbeat/"
  execution_role_arn   = aws_iam_role.canary.arn
  handler              = "heartbeat.handler"
  zip_file             = data.archive_file.heartbeat.output_path
  runtime_version      = var.runtime_version
  start_canary         = true

  schedule {
    expression = var.schedule_expression
  }

  run_config {
    timeout_in_seconds = var.canary_timeout_seconds

    # The URL is configuration, not code, so a URL change is an apply — not a
    # script repackage. It is public (it is the login page's own origin), so
    # a plaintext Lambda environment variable is fine.
    environment_variables = {
      HEARTBEAT_URL = var.heartbeat_url
    }
  }

  success_retention_period = var.artifact_retention_days
  failure_retention_period = var.artifact_retention_days

  tags = var.tags

  depends_on = [aws_iam_role_policy.canary]
}

# ---- Alarm -------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "heartbeat_failed" {
  # severity: critical — the canary failing means the public health endpoint is
  # unreachable from the internet: either the whole ingress path (DNS, cert,
  # CloudFront, WAF, ALB) or the web service itself is down, and every internal
  # alarm can stay green while that is true. Verifying and restoring public
  # reachability is exactly what an on-call engineer is for at 03:00.
  # Missing data breaches on purpose: a canary that has stopped RUNNING is
  # external monitoring silently switched off, which is this repository's
  # signature failure mode (see the alerting runbook's history note).
  alarm_name          = "${var.name_prefix}-synthetics-heartbeat-failed"
  alarm_description   = "Heartbeat canary failed or stopped reporting: the public health endpoint is unreachable from outside AWS. See RUNBOOK docs/runbooks/alarms/synthetics-heartbeat-failed.md."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = var.alarm_evaluation_periods
  metric_name         = "SuccessPercent"
  namespace           = "CloudWatchSynthetics"
  period              = 300
  statistic           = "Average"
  threshold           = 100
  treat_missing_data  = "breaching"

  dimensions = {
    CanaryName = aws_synthetics_canary.heartbeat.name
  }

  alarm_actions = local.critical_alarm_actions
  ok_actions    = local.critical_alarm_actions

  tags = var.tags
}
