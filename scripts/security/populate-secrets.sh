#!/usr/bin/env bash
#
# populate-secrets.sh — interactively populate the empty Secrets Manager
# entries created by `infra/terraform/modules/secrets`.
#
# WHY THIS EXISTS
#   Terraform creates each logical secret EMPTY (see modules/secrets/main.tf).
#   The values are populated out-of-band so the material never touches
#   Terraform state, code, or `.tfvars`. This script wraps
#   `aws secretsmanager put-secret-value` with hidden input so the values
#   also never land in your shell history or on disk.
#
# WHAT IT DOES NOT DO
#   - It does NOT handle the PHI-scope DB connection strings
#     (database-url / database-url-system / direct-url /
#     reporting-database-url). Those are assembled from Terraform outputs —
#     see infra/terraform/README.md § "Assembling DATABASE_URL".
#
# SPECIAL CASE
#   - pharmax-local-kms-seed is GENERATED (not pasted): it must be a strong
#     random >=32-char value because all three ECS task defs inject it (empty
#     => task fails to start) and print-agent requires it. Generated once and
#     never overwritten.
#
# USAGE
#   aws sso login --profile pharmax-prod        # first, in your own terminal
#   ./scripts/security/populate-secrets.sh
#
#   Overridable via env:
#     AWS_PROFILE       (default: pharmax-prod)
#     SECRET_PREFIX     (default: pharmax-prod-ue1)
#     EXPECTED_ACCOUNT  (default: 172800116354)  — guards against wrong account
#     BOUNCE_ECS        (default: ask)           — set to "yes"/"no" to skip prompt
#     ECS_CLUSTER       (default: pharmax-prod-ue1)
#
# SAFETY
#   - Refuses to run unless the resolved caller account matches
#     EXPECTED_ACCOUNT, so you cannot accidentally write prod creds into the
#     management account (or vice versa).
#   - Blank input SKIPS a secret (leaves its current value untouched), so the
#     script is safe to re-run to fill in only the ones you missed.
#   - Only writes to secrets that already exist in Secrets Manager.

set -euo pipefail

AWS_PROFILE="${AWS_PROFILE:-pharmax-prod}"
SECRET_PREFIX="${SECRET_PREFIX:-pharmax-prod-ue1}"
EXPECTED_ACCOUNT="${EXPECTED_ACCOUNT:-172800116354}"
ECS_CLUSTER="${ECS_CLUSTER:-pharmax-prod-ue1}"
BOUNCE_ECS="${BOUNCE_ECS:-ask}"
export AWS_PROFILE

# Vendor / integration secrets this script knows how to populate. Mirrors the
# non-DB, non-Redis entries in infra/terraform/modules/secrets/main.tf. Keep
# this list in sync when the module's logical_secrets changes.
SECRETS=(
  "clerk-secret-key"
  "next-public-clerk-publishable-key"
  "clerk-webhook-secret"
  "stripe-secret-key"
  "stripe-webhook-secret"
  "easypost-api-key"
  "easypost-webhook-secret"
  "fedex-client-id"
  "fedex-client-secret"
  "ups-client-id"
  "ups-client-secret"
  "sentry-dsn"
  "redis-url"
)

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

die() { red "ERROR: $*" >&2; exit 1; }

command -v aws >/dev/null 2>&1 || die "aws CLI not found on PATH."

bold "Verifying AWS identity (profile: $AWS_PROFILE) ..."
CALLER_JSON="$(aws sts get-caller-identity 2>&1)" || die \
  "Not authenticated. Run: aws sso login --profile $AWS_PROFILE"

ACCOUNT="$(printf '%s' "$CALLER_JSON" | sed -n 's/.*"Account": *"\([0-9]*\)".*/\1/p')"
ARN="$(printf '%s' "$CALLER_JSON" | sed -n 's/.*"Arn": *"\([^"]*\)".*/\1/p')"

[ -n "$ACCOUNT" ] || die "Could not parse account from: $CALLER_JSON"
if [ "$ACCOUNT" != "$EXPECTED_ACCOUNT" ]; then
  die "Account mismatch: caller is $ACCOUNT but EXPECTED_ACCOUNT is $EXPECTED_ACCOUNT.
Refusing to write secrets to the wrong account. Re-check your profile."
fi
green "OK — account $ACCOUNT"
echo "   $ARN"
echo

bold "Populating secrets under prefix: $SECRET_PREFIX"
echo "Press ENTER with no input to SKIP a secret (leaves its current value)."
echo "Input is hidden. Values are never written to disk or shell history."
echo

written=0
skipped=0
for name in "${SECRETS[@]}"; do
  secret_id="${SECRET_PREFIX}/${name}"

  # Only touch secrets that already exist (Terraform should have created them).
  if ! aws secretsmanager describe-secret --secret-id "$secret_id" >/dev/null 2>&1; then
    red "  ! $name — secret '$secret_id' does not exist; skipping (did terraform apply run?)"
    skipped=$((skipped + 1))
    continue
  fi

  printf '  %s: ' "$name"
  # -s hides input; -r keeps backslashes literal.
  IFS= read -rs value || true
  echo  # newline after hidden input

  if [ -z "$value" ]; then
    echo "    ↳ skipped"
    skipped=$((skipped + 1))
    continue
  fi

  if aws secretsmanager put-secret-value \
       --secret-id "$secret_id" \
       --secret-string "$value" >/dev/null 2>&1; then
    green "    ↳ written"
    written=$((written + 1))
  else
    red "    ↳ FAILED to write $secret_id"
  fi
  unset value
done

# ---------------------------------------------------------------------------
# pharmax-local-kms-seed — special-cased.
#
# This is NOT a vendor key you paste; it is a strong random seed. It MUST be
# non-empty because all three ECS task definitions inject it via the `secrets`
# block (an empty secret makes the task fail to start), and apps/print-agent
# functionally requires it (LocalKmsAdapter, >=32 chars). apps/web + worker use
# AWS KMS in prod and ignore the value, but ECS still must be able to fetch it.
#
# We GENERATE it once and never overwrite — print-agent wraps data with this
# seed, so rotating it would orphan anything it already wrapped.
# ---------------------------------------------------------------------------
seed_id="${SECRET_PREFIX}/pharmax-local-kms-seed"
if aws secretsmanager describe-secret --secret-id "$seed_id" >/dev/null 2>&1; then
  seed_out="$(aws secretsmanager get-secret-value --secret-id "$seed_id" \
    --query 'SecretString' --output text 2>&1)"
  seed_rc=$?
  if [ $seed_rc -eq 0 ] && [ "${#seed_out}" -ge 32 ]; then
    echo "  pharmax-local-kms-seed: already set (>=32 chars) — leaving as-is"
    skipped=$((skipped + 1))
  else
    printf '  pharmax-local-kms-seed is empty. Generate a random 48-byte seed and store it? [y/N] '
    read -r gen_answer || true
    case "$gen_answer" in
      y|Y|yes|YES)
        new_seed="$(openssl rand -base64 48 2>/dev/null || head -c 48 /dev/urandom | base64)"
        new_seed="$(printf '%s' "$new_seed" | tr -d '\n')"
        if [ "${#new_seed}" -lt 32 ]; then
          red "    ↳ failed to generate a >=32 char seed; skipping"
          skipped=$((skipped + 1))
        elif aws secretsmanager put-secret-value \
               --secret-id "$seed_id" \
               --secret-string "$new_seed" >/dev/null 2>&1; then
          green "    ↳ generated and written (len=${#new_seed})"
          written=$((written + 1))
        else
          red "    ↳ FAILED to write $seed_id"
        fi
        unset new_seed
        ;;
      *)
        echo "    ↳ skipped (WARNING: ECS tasks will fail to start until this is set)"
        skipped=$((skipped + 1))
        ;;
    esac
  fi
  unset seed_out
fi

echo
bold "Done: $written written, $skipped skipped."
echo
echo "Reminder: this script does NOT set the DB connection strings"
echo "(database-url / direct-url / reporting-database-url). Assemble those per"
echo "infra/terraform/README.md § \"Assembling DATABASE_URL\"."
echo

# Secrets are read at container start, so a redeploy is required to pick up
# new values.
if [ "$written" -gt 0 ]; then
  do_bounce="$BOUNCE_ECS"
  if [ "$do_bounce" = "ask" ]; then
    printf 'Force a new deployment of ECS services on cluster %s now? [y/N] ' "$ECS_CLUSTER"
    read -r answer || true
    case "$answer" in
      y|Y|yes|YES) do_bounce="yes" ;;
      *)           do_bounce="no" ;;
    esac
  fi

  if [ "$do_bounce" = "yes" ]; then
    for svc in web worker print-agent; do
      bold "Redeploying $svc ..."
      aws ecs update-service \
        --cluster "$ECS_CLUSTER" \
        --service "$svc" \
        --force-new-deployment >/dev/null \
        && green "  ↳ $svc redeploy triggered" \
        || red "  ↳ failed to redeploy $svc"
    done
  else
    echo "Skipped ECS redeploy. When ready, run:"
    echo "  for svc in web worker print-agent; do aws ecs update-service --cluster $ECS_CLUSTER --service \$svc --force-new-deployment; done"
  fi
fi
