# =============================================================================
# Alerting module — the SNS topics CloudWatch alarms publish to.
#
# Two topics, not one:
#
#   `<prefix>-alerts-critical`  → wakes a human. Subscribers are the on-call
#                                 rotation's paging integration and, as a
#                                 backstop, the on-call mailbox.
#   `<prefix>-alerts-warning`   → files a ticket / lands in a mailbox that is
#                                 read at the start of a shift.
#
# The split is the whole point of the module. A pager that fires for
# "worker CPU is 82%" gets muted within a week, and the muted pager is the
# one that will not wake anyone for "the writer is out of memory". Which
# alarm goes where is decided at the alarm, in
# `modules/cloudwatch/main.tf`, where each resource carries a one-line
# `# severity:` rationale next to the topic it routes to.
#
# Encryption: both topics are SSE-KMS under the dedicated alerts CMK
# (`modules/kms` key #9). Alarm payloads are not PHI — an alarm name, a
# metric, a threshold, a state transition — but the stream is a map of which
# subsystem is fragile and when, and SOC 2 CC6.7 expects at-rest encryption
# on the topic regardless.
#
# Publish authorization: the topic policy names `cloudwatch.amazonaws.com`
# and conditions the grant on this account plus an alarm-ARN prefix, so the
# topic is not world-publishable and not even publishable by an unrelated
# alarm in the same account.
#
# Subscription endpoints are NEVER committed. See variables.tf for the
# supply path (TF_VAR_* from the CI secret store at apply time).
# =============================================================================

locals {
  # Alarm ARNs this topic will accept publishes from. The cloudwatch module
  # names every alarm `${name_prefix}-...`, so one wildcard covers the set
  # while still excluding alarms from other stacks in the same account.
  alarm_arn_pattern = "arn:aws:cloudwatch:${var.aws_region}:${var.aws_account_id}:alarm:${var.name_prefix}-*"

  # Severity tiers. The map drives the policy documents so the two topics
  # cannot drift apart in what they allow.
  severities = ["critical", "warning"]
}

# ---- Topics ------------------------------------------------------------------

resource "aws_sns_topic" "critical" {
  name              = "${var.name_prefix}-alerts-critical"
  display_name      = "Pharmax CRITICAL"
  kms_master_key_id = var.kms_key_arn

  tags = merge(var.tags, {
    Purpose  = "alerting"
    Severity = "critical"
  })
}

resource "aws_sns_topic" "warning" {
  name              = "${var.name_prefix}-alerts-warning"
  display_name      = "Pharmax warning"
  kms_master_key_id = var.kms_key_arn

  tags = merge(var.tags, {
    Purpose  = "alerting"
    Severity = "warning"
  })
}

# ---- Topic policies ----------------------------------------------------------
#
# Setting a policy REPLACES the SNS default, which grants the owning account
# broad access. The owner statement below restores exactly that much and no
# more; without it, an operator can lose the ability to manage the topic
# outside of Terraform.

locals {
  topic_arns = {
    critical = aws_sns_topic.critical.arn
    warning  = aws_sns_topic.warning.arn
  }
}

data "aws_iam_policy_document" "topic" {
  for_each = toset(local.severities)

  statement {
    sid    = "AllowAccountOwnerAdministration"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.aws_account_id}:root"]
    }

    actions = [
      "SNS:GetTopicAttributes",
      "SNS:SetTopicAttributes",
      "SNS:AddPermission",
      "SNS:RemovePermission",
      "SNS:DeleteTopic",
      "SNS:Subscribe",
      "SNS:ListSubscriptionsByTopic",
      "SNS:Publish",
    ]
    resources = [local.topic_arns[each.key]]
  }

  statement {
    sid    = "AllowCloudWatchAlarmsToPublish"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    actions   = ["SNS:Publish"]
    resources = [local.topic_arns[each.key]]

    # Both conditions, not either: SourceAccount alone would accept any alarm
    # in this account (including one an attacker with CloudWatch write could
    # create to drown the real signal); SourceArn alone is satisfiable
    # cross-account by an attacker who guesses the name pattern.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.aws_account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [local.alarm_arn_pattern]
    }
  }

  statement {
    sid    = "DenyNonTlsPublish"
    effect = "Deny"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions   = ["SNS:Publish"]
    resources = [local.topic_arns[each.key]]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_sns_topic_policy" "critical" {
  arn    = aws_sns_topic.critical.arn
  policy = data.aws_iam_policy_document.topic["critical"].json
}

resource "aws_sns_topic_policy" "warning" {
  arn    = aws_sns_topic.warning.arn
  policy = data.aws_iam_policy_document.topic["warning"].json
}

# ---- Subscriptions -----------------------------------------------------------
#
# Email subscriptions land in `PendingConfirmation` until a human clicks the
# link AWS sends. A pending subscription receives nothing, so "terraform
# apply succeeded" is NOT the same as "the pager works" — confirm the
# subscription, then run the end-to-end test in
# `docs/runbooks/alerting.md` § "Proving the pipe works".

resource "aws_sns_topic_subscription" "critical_email" {
  for_each = toset(var.critical_email_subscriptions)

  topic_arn = aws_sns_topic.critical.arn
  protocol  = "email"
  endpoint  = each.value
}

resource "aws_sns_topic_subscription" "warning_email" {
  for_each = toset(var.warning_email_subscriptions)

  topic_arn = aws_sns_topic.warning.arn
  protocol  = "email"
  endpoint  = each.value
}

# HTTPS subscribers are paging/ticketing integrations (PagerDuty, Opsgenie,
# an internal webhook). `endpoint_auto_confirms` is required because those
# providers answer the SubscriptionConfirmation callback themselves.
resource "aws_sns_topic_subscription" "critical_https" {
  for_each = toset(var.critical_https_subscriptions)

  topic_arn              = aws_sns_topic.critical.arn
  protocol               = "https"
  endpoint               = each.value
  endpoint_auto_confirms = true
}

resource "aws_sns_topic_subscription" "warning_https" {
  for_each = toset(var.warning_https_subscriptions)

  topic_arn              = aws_sns_topic.warning.arn
  protocol               = "https"
  endpoint               = each.value
  endpoint_auto_confirms = true
}

# ---- Guard rail --------------------------------------------------------------
#
# A topic with zero subscribers is the failure this module exists to fix,
# wearing a different hat: the alarm publishes, SNS accepts, and the message
# is delivered to nobody. `check` surfaces it as a plan/apply warning rather
# than an error because a first apply legitimately creates the topics before
# the endpoints are known — but it must not be possible to forget.

check "critical_topic_has_a_subscriber" {
  assert {
    condition = (
      length(var.critical_email_subscriptions) + length(var.critical_https_subscriptions)
    ) > 0
    error_message = join("", [
      "The critical alerting topic has no subscribers: an alarm that pages ",
      "will publish successfully and reach nobody. Supply endpoints via ",
      "TF_VAR_critical_email_subscriptions / TF_VAR_critical_https_subscriptions ",
      "from the CI secret store (never in terraform.tfvars).",
    ])
  }
}

check "warning_topic_has_a_subscriber" {
  assert {
    condition = (
      length(var.warning_email_subscriptions) + length(var.warning_https_subscriptions)
    ) > 0
    error_message = join("", [
      "The warning alerting topic has no subscribers. Warning-tier alarms ",
      "will be recorded in CloudWatch and delivered nowhere. Supply endpoints ",
      "via TF_VAR_warning_email_subscriptions / TF_VAR_warning_https_subscriptions.",
    ])
  }
}
