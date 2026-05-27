# Secrets Management

| Field          | Value                       |
| -------------- | --------------------------- |
| Owner          | [Owner: CTO]                |
| Approver       | [Approver: CEO]             |
| Effective date | [Effective date: TBD]       |
| Last reviewed  | [Last reviewed: YYYY-MM-DD] |
| Next review    | [Next review: YYYY-MM-DD]   |
| Version        | 0.1                         |
| Distribution   | Internal — All staff        |

## 1. Purpose

This document is the standing description of how Pharmax handles secrets — what they are, where they live, who can read them, how they are rotated, and what we never do with them. It is the companion to [`encryption-overview.md`](./encryption-overview.md) (the cryptographic-material story) and to the [Acceptable Use Policy](../policies/acceptable-use-policy.md) §3 (the human-side credential rules).

Secrets in this document mean any of:

- Cryptographic keys (KMS key references, JWT signing keys, HMAC secrets).
- API tokens and OAuth client secrets to vendors (Stripe, EasyPost, Clerk, Resend, Sentry, observability vendor).
- Database credentials (connection strings, role passwords).
- Service-account credentials (AWS access keys for service identities where unavoidable, system-account passwords).
- Webhook signing secrets (Stripe, EasyPost, carrier webhooks).
- Recovery codes for privileged MFA accounts.

PHI itself is not a "secret" for this document's purposes — it is Restricted data governed by [Data Classification Policy](../policies/data-classification.md) §3.4 and [`encryption-overview.md`](./encryption-overview.md).

## 2. The two homes

Pharmax keeps secrets in exactly two places, depending on the consumer:

### 2.1 AWS Secrets Manager — runtime consumption

Every secret consumed by a Pharmax process at runtime lives in **AWS Secrets Manager**:

- The Pharmax web app (`apps/web`) and worker (`apps/worker`) retrieve secrets via the AWS SDK using IAM-bound roles. The secret name is referenced in the ECS task definition; the value is resolved at boot or on lazy fetch.
- Secrets are encrypted at rest in AWS Secrets Manager with an AWS-managed KMS key (or a customer-managed KMS key for the highest-sensitivity secrets).
- Access to a given secret is bounded by IAM policy: only the role that needs the secret can read it. For example, the `pharmax-worker` task role can read the `stripe/webhook-secret` value but cannot read the `pharmax-app-clerk-secret-key` value.
- Prior versions of a secret are retained for 30 days after rotation, then purged. The 30-day window lets us roll back a rotation that broke something without leaving prior values indefinitely.
- All access is logged in CloudTrail (`GetSecretValue` events). The CloudTrail is part of the access-review evidence pack.

The application code reads secrets through a thin abstraction (`packages/platform-core/src/config/secrets.ts` — to be added if not yet present) that surfaces a typed error when a secret is missing rather than a generic SDK error. The abstraction prevents "secret-fetch failures are confused with API failures" during incident response.

### 2.2 1Password — human consumption

Every secret consumed by a human lives in **1Password**:

- The Pharmax 1Password vault is the source of truth for AWS console logins, GitHub org-admin credentials, vendor dashboard logins, the AWS root account credentials, recovery codes for privileged MFA accounts, and any human-use API token.
- Vault membership is granted by role (`Engineering`, `Operations`, `Billing`, `Security`); per-item ACLs constrain access to the smallest group that needs the item.
- The vault is encrypted at rest with a per-account Secret Key + master password as the unwrap inputs (end-to-end encryption — 1Password cannot read the vault contents).
- Sharing a credential outside the vault (Slack DM, email, screenshot, AI prompt) is a policy violation per [Acceptable Use Policy](../policies/acceptable-use-policy.md) §6.2.

A secret that needs to be consumed by both a process and a human (e.g. the Stripe webhook secret — the worker reads it; the on-call engineer needs it for incident debugging) lives in **both** Secrets Manager (canonical for the process) and 1Password (for the human), and **the two must agree**. The rotation procedure updates both atomically.

## 3. What is never permitted

The following patterns are policy violations and trigger the [Incident Response Policy](../policies/incident-response-policy.md) at SEV2 by default (SEV1 if the secret has known external exposure):

- **No `.env` files committed to the repository.** The repo's `.gitignore` covers `.env`, `.env.local`, `.env.*.local`. A committed `.env` is the canonical "secret leaked in repository" event (R-011 in [`../governance/risk-register.md`](../governance/risk-register.md)).
- **No secrets in client-side environment variables.** Per `.cursor/rules/02-security-compliance.mdc`, secrets that the browser would receive (any `NEXT_PUBLIC_*` Next.js convention) are forbidden for anything but truly public values. The `STRIPE_WEBHOOK_SECRET` is server-only, full stop.
- **No secrets in Slack, email, AI prompts, or screenshots.** See [Acceptable Use Policy](../policies/acceptable-use-policy.md) §6.2 and §7.
- **No secrets in CI variables that survive past a single run.** Where CI needs a secret, it is fetched from AWS Secrets Manager at the start of the job and scoped to the job's lifetime.
- **No personal copies of production secrets.** A developer who needs a Stripe key for a debugging session uses Stripe test-mode keys, not production. See [Acceptable Use Policy](../policies/acceptable-use-policy.md) §6.5.
- **No raw secret values in log lines.** The structured logger (Pino) redacts known secret field names. Errors that would include a secret in the message string are caught at the logger boundary; the redacted form is what reaches Sentry and the log aggregator. See `../OBSERVABILITY.md` §"Layer 2 — Sentry".
- **No AWS root for routine work.** AWS root credentials are reserved for the irreducible set of root-only operations and are protected by hardware MFA per [Access Control Policy](../policies/access-control-policy.md) §9.

## 4. GitHub secret scanning

GitHub secret scanning is enabled at the organization level. The configuration:

- **Push protection** enabled — a push containing a known secret pattern is blocked at the push step.
- **Custom patterns** registered for Pharmax-specific secret shapes (e.g. internal API tokens that follow a recognizable prefix).
- **Alerts** route to the CTO via email and Slack.
- **Validation** with partner integrations enabled where supported (so the scanner can confirm a leaked secret is actually valid against the issuing provider, prioritizing remediation).

The CI hardening lane delivers the validation-and-alert wiring; until that lane lands, secret-scanning alerts are reviewed daily by the CTO.

A confirmed secret leak triggers, in order:

1. Rotate the leaked secret at the issuing provider (AWS, Stripe, etc.) **immediately**. Do not wait to investigate.
2. Update Secrets Manager + 1Password with the new value.
3. Verify the production process picks up the new value (rolling restart if necessary).
4. Investigate the cause; file the postmortem per [Incident Response Policy](../policies/incident-response-policy.md).
5. Remove the leaked value from the repository history with `git filter-repo` or equivalent; force-push to the affected branch; coordinate with the team to re-pull.

## 5. Rotation cadence

Rotation cadence depends on secret class:

| Secret class                                              | Rotation cadence                                                 | Notes                                                                                                                                                                                 |
| --------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Per-tenant KEK (AWS KMS CMK)                              | Annual (automatic) + on incident                                 | KMS automatic rotation publishes a new key version annually; wrapped DEKs continue to unwrap.                                                                                         |
| RDS root credentials                                      | Annual + on suspected compromise                                 | RDS supports password rotation through Secrets Manager rotation lambdas; we wire this once the production RDS instance is fully managed.                                              |
| Database role passwords (`pharmax_app`, `pharmax_system`) | Annual + on suspected compromise                                 | Each role's password rotates independently. The `pharmax_system` rotation is coordinated with on-call to absorb the brief unavailability of system tasks during cutover.              |
| Stripe live-mode API keys                                 | Annual + on suspected compromise                                 | Stripe supports rolling the API key without service interruption (issue a new key, update Secrets Manager, then revoke the old).                                                      |
| Stripe webhook signing secret                             | Annual + on suspected compromise                                 | Same rolling pattern via the Stripe dashboard.                                                                                                                                        |
| Clerk secret keys                                         | Annual + on suspected compromise                                 | Rolled via the Clerk dashboard.                                                                                                                                                       |
| EasyPost / carrier API keys                               | Annual + on suspected compromise                                 | Pharmax-level; per-tenant carrier credentials are governed by `../RUNBOOK.md` §"Rotating a carrier credential".                                                                       |
| Per-tenant carrier credentials (`carrier_credential`)     | On tenant request + on suspected compromise                      | The Phase 4 `carrier_credential` table holds the per-tenant keys; rotation is a `RegisterCarrierCredential` command that transitions the old to DISABLED inside the same transaction. |
| Resend (or equivalent transactional email) API key        | Annual + on suspected compromise                                 | Rolled via the vendor dashboard.                                                                                                                                                      |
| Sentry DSN                                                | On suspected compromise only                                     | DSNs are project identifiers, not secrets in the strict sense; rotation is a defensive measure.                                                                                       |
| Observability vendor tokens                               | Annual + on suspected compromise                                 | Per vendor selection (Datadog or Honeycomb).                                                                                                                                          |
| GitHub PAT / org tokens for CI                            | 90 days                                                          | Short-lived tokens are preferred; we lean on GitHub App authentication where possible for CI.                                                                                         |
| AWS service-account access keys (where unavoidable)       | 90 days                                                          | The preference is IAM roles, not access keys. Where a key is necessary, 90 days is the rotation floor.                                                                                |
| AWS root account credentials                              | Annual + on suspected compromise                                 | Hardware MFA is the primary defense; the password is rotated annually.                                                                                                                |
| Privileged MFA recovery codes                             | On regeneration (i.e. after consumption)                         | Each set of recovery codes is single-batch; when one is consumed, the remaining batch is regenerated and the prior set is invalidated.                                                |
| 1Password vault master passphrase (per user)              | Annual or as the user prefers; mandatory on suspected compromise | Self-service through 1Password.                                                                                                                                                       |

Rotation events are recorded in the engineering tracker; an executed rotation is also visible in CloudTrail (for AWS-side rotations) or in the relevant vendor's audit log. The quarterly access review confirms rotation cadence is on track.

## 6. Secret provisioning workflow

A new secret is provisioned via the following steps:

1. The requester opens a ticket describing the secret, the consumer, the IAM scope needed, and the rotation cadence.
2. The CTO (or delegated security owner) creates the secret in AWS Secrets Manager with the appropriate name, KMS key, and IAM policy.
3. If the secret is also needed for human consumption, it is added to the appropriate 1Password vault entry with the access ACL set to the smallest group that needs it.
4. The application code is updated to reference the secret by name (not by value). The PR goes through the standard [Change Management Policy](../policies/change-management-policy.md) workflow.
5. The secret is deployed alongside the consuming code.

A secret that is provisional or experimental (e.g. a vendor trial API key) is named with a `provisional-` prefix so it is visible in inventory; it is rotated or removed at the end of the trial period.

## 7. Secret decommissioning workflow

When a secret is no longer needed:

1. The consumer code is removed first. The application no longer references the secret name.
2. The secret is deleted from AWS Secrets Manager (with the deletion-recovery window so a mistake is recoverable for 30 days).
3. The 1Password vault entry, if any, is removed.
4. The issuing provider's record (e.g. the Stripe API key entry) is revoked.
5. The decommissioning is recorded in the engineering tracker.

A secret that was leaked and is being rotated is a special case: the deletion is **immediate** (skip the deletion-recovery window), and the leaked value is documented in the incident record.

## 8. CI and build-time secrets

CI workflows that need access to secrets pull them from AWS Secrets Manager at the start of the job via the AWS GitHub OIDC integration:

- The CI job assumes a role via OIDC (no long-lived AWS access keys in GitHub).
- The role's policy permits read on the specific secrets the job needs.
- The job exports the secrets into the CI environment for the duration of the job; CI does not persist them.

Build-time secrets (e.g. a Sentry release token used to upload sourcemaps) follow the same pattern. We do not check secrets into the build pipeline configuration; the secret name and the IAM scope are the artifacts in the pipeline.

## 9. Cross-references

- [`encryption-overview.md`](./encryption-overview.md) — cryptographic-key custody, the encryption companion.
- [Acceptable Use Policy](../policies/acceptable-use-policy.md) — human-side credential rules.
- [Access Control Policy](../policies/access-control-policy.md) — IAM scopes and privileged-access list.
- [Change Management Policy](../policies/change-management-policy.md) — how a secret change ships.
- [Incident Response Policy](../policies/incident-response-policy.md) — what happens when a secret leaks.
- [`../RUNBOOK.md`](../RUNBOOK.md) §"Rotating a KMS data key", §"Rotating a carrier credential".
- [`control-matrix.md`](./control-matrix.md) — the control rows that this document evidences.
- HIPAA 45 CFR § 164.308(a)(5)(ii)(D) (password management implementation specification), § 164.312(a)(2)(i) (unique user identification).

## Revision history

| Version | Date       | Author | Change           |
| ------- | ---------- | ------ | ---------------- |
| 0.1     | YYYY-MM-DD | CTO    | Initial drafting |
