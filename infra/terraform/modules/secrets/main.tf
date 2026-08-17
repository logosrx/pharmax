# =============================================================================
# Secrets Manager module.
#
# One Secret per logical credential. The ECS task definitions reference these
# via the `secrets =` block (not `environment =`), so the secret material
# never appears in `aws ecs describe-task-definition`. The list of logical
# names below mirrors the env schemas in:
#   - apps/web/src/server/env.ts
#   - apps/worker/src/env.ts
#   - apps/print-agent/src/env.ts
#
# Each secret is encrypted with the secrets-manager CMK (passed in).
# `var.initial_values` is optional — recommended pattern is empty (operator
# populates after first apply via `aws secretsmanager put-secret-value`).
# Terraform will then ignore future changes via `lifecycle.ignore_changes`.
#
# Rotation:
#   - Secrets that support rotation lambdas (Stripe API key, Clerk webhook
#     secret) have a rotation schedule annotated. The actual rotation
#     lambda function lives outside this module (a TODO; see
#     `docs/security/secrets-management.md` § "Secret rotation lambdas").
#     Until that lambda lands, rotation is operator-driven via the runbook.
#   - The RDS master password is rotated by AWS via the
#     `manage_master_user_password = true` flag on `aws_db_instance` —
#     no secret entry here is required.
#
# Reference: ADR 0023 (database url + KMS env), ADR 0025 (Clerk webhook
# secret).
# =============================================================================

locals {
  # Logical secret names. Order here is intentional — keep it stable so
  # downstream consumers (the ECS module's `var.secret_arns` map) can
  # reference by key without breakage.
  logical_secrets = [
    # DATABASE_URL for the RLS-SUBJECT services (apps/web). Its value
    # MUST select the non-owner, non-superuser `pharmax_app` role, e.g.
    #   postgresql://<login>:<pw>@<host>:5432/pharmax?options=-c%20role%3Dpharmax_app
    # so Postgres Row-Level Security is actually enforced on every query.
    "database-url",
    # DATABASE_URL for the SYSTEM/BYPASSRLS services (apps/worker,
    # apps/print-agent). Its value selects the `pharmax_system` role
    # (BYPASSRLS), e.g. ...?options=-c%20role%3Dpharmax_system. These
    # services resolve a tenant from an external id (webhook / claim
    # drain) BEFORE entering that org's tenancy, so they legitimately
    # need to read across orgs — but they are a SEPARATE credential so
    # the web tier can never be pointed at a BYPASSRLS role by mistake.
    "database-url-system",
    "database-password",
    "direct-url",
    "reporting-database-url",
    "redis-url",
    "pharmax-local-kms-seed",
    "stripe-secret-key",
    "stripe-webhook-secret",
    "easypost-api-key",
    "easypost-webhook-secret",
    # UNREFERENCED since 2026-08-15 — no task definition injects these
    # three, and no application code reads them (ADR-0030 retired
    # Clerk). They are retained ONLY so that a rollback to a
    # task-definition revision registered before that date still
    # resolves its secret ARNs. Remove them once no rollback-eligible
    # revision references them, together with their entries in
    # `rotation_candidates` below and the populate steps in
    # infra/terraform/README.md. Tracked as the vendor-decom half of
    # EI-6 (docs/soc2/evidence-integrity-findings.md).
    "clerk-secret-key",
    "clerk-webhook-secret",
    "next-public-clerk-publishable-key",
    "sentry-dsn",
    "fedex-client-id",
    "fedex-client-secret",
    "ups-client-id",
    "ups-client-secret",
    # OTEL_EXPORTER_OTLP_HEADERS for the Grafana Cloud OTLP gateway
    # (web + worker, injected only when `otel_backend_enabled` is true —
    # see modules/ecs). Value shape:
    #   Authorization=Basic <base64(instanceId:token)>
    # Unlike the rest of this list it is seeded with a PLACEHOLDER
    # version below, not left empty: an empty secret referenced by a
    # task definition is a boot dependency that fails the task with
    # ResourceInitializationError (see the Clerk decom note in
    # modules/ecs/main.tf). A placeholder merely 401s at the gateway —
    # the exporter logs and retries, the app keeps serving. Populate the
    # real value per docs/observability/grafana-cloud-otel-backend.md.
    "grafana-cloud-otlp-headers",
  ]

  # Secrets that have an automatic-rotation candidate. Either a vendor-
  # provided lambda blueprint (Stripe doesn't publish one, but the
  # restricted-key model lets us rotate via a custom lambda) or a
  # provider-side rotation (RDS, AWS KMS — those don't show up here).
  #
  # When the rotation lambda is wired (see `docs/security/secrets-management.md`),
  # set `var.rotation_lambda_arns[<logical-name>]` to attach a schedule.
  rotation_candidates = [
    "stripe-secret-key",
    "stripe-webhook-secret",
    "clerk-secret-key",
    "clerk-webhook-secret",
    "easypost-api-key",
    "fedex-client-secret",
    "ups-client-secret",
    "grafana-cloud-otlp-headers",
  ]
}

resource "aws_secretsmanager_secret" "this" {
  for_each = toset(local.logical_secrets)

  name                    = "${var.name_prefix}/${each.key}"
  description             = "Pharmax ${each.key} (${var.name_prefix}). Managed by Terraform; rotate via aws secretsmanager put-secret-value or the rotation lambda."
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_in_days

  tags = merge(var.tags, {
    Logical    = each.key
    Rotatable  = contains(local.rotation_candidates, each.key) ? "true" : "false"
    HipaaScope = contains(["database-url", "database-url-system", "direct-url", "reporting-database-url", "database-password", "pharmax-local-kms-seed"], each.key) ? "in-scope" : "operational"
  })
}

# Optionally seed an initial value. Most operators leave this empty and
# populate the secret out-of-band so the value never touches Terraform.
resource "aws_secretsmanager_secret_version" "this" {
  # Iterate over the secret NAMES only. `nonsensitive` is safe + necessary
  # here: the keys are logical secret names (e.g. "database-url"), never
  # secret material — the value stays sensitive via `var.initial_values[...]`.
  # Terraform refuses a sensitive value (the whole `initial_values` map) as a
  # for_each argument, so we unwrap just the key set.
  for_each = toset([
    for k in nonsensitive(keys(var.initial_values)) : k
    if contains(local.logical_secrets, k)
  ])

  secret_id     = aws_secretsmanager_secret.this[each.key].id
  secret_string = var.initial_values[each.key]

  # Once an operator rotates a secret out-of-band, do not let Terraform
  # overwrite their rotation on the next apply.
  lifecycle {
    ignore_changes = [secret_string]
  }
}

# The Grafana Cloud OTLP-headers secret ships with a placeholder version
# (rationale in the `logical_secrets` comment above). The operator overwrites
# it out-of-band with the real
#   Authorization=Basic <base64(instanceId:token)>
# value — `ignore_changes` below guarantees the next apply does not revert
# that overwrite back to the placeholder. Skipped when the operator passed a
# real initial value via `var.initial_values`, which would otherwise race
# this resource for the same secret's version.
resource "aws_secretsmanager_secret_version" "grafana_cloud_otlp_headers_placeholder" {
  count = contains(nonsensitive(keys(var.initial_values)), "grafana-cloud-otlp-headers") ? 0 : 1

  secret_id     = aws_secretsmanager_secret.this["grafana-cloud-otlp-headers"].id
  secret_string = "Authorization=Basic REPLACE-WITH-BASE64-OF-INSTANCEID-COLON-TOKEN"

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# Optional: attach a rotation schedule to any candidate that has a lambda
# wired in `var.rotation_lambda_arns`. The lambda itself is created
# outside this module — see the README's "Wiring a secret rotation lambda"
# section. Until the lambda lands, this for_each evaluates to {} and no
# rotation is configured.

resource "aws_secretsmanager_secret_rotation" "this" {
  for_each = {
    for k, arn in var.rotation_lambda_arns :
    k => arn
    if contains(local.rotation_candidates, k) && contains(local.logical_secrets, k)
  }

  secret_id           = aws_secretsmanager_secret.this[each.key].id
  rotation_lambda_arn = each.value

  rotation_rules {
    automatically_after_days = var.rotation_interval_days
  }
}
