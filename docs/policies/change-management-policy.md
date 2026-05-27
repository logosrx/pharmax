# Change Management Policy

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

This policy governs how code, schema, and configuration changes reach production at Pharmax. It is the management-system parent of the engineering mechanics already documented in `../RUNBOOK.md` and the architectural invariants in `../ARCHITECTURE_PRINCIPLES.md`. The combination is what we point to when an auditor asks "how does a change get from a developer's laptop to a system serving PHI?".

This policy maps to:

- SOC 2 **CC8.1** — change management.
- SOC 2 **CC7.1** — system operations / vulnerability identification (covered by the CI gates).
- HIPAA **45 CFR § 164.308(a)(1)(ii)(B)** — risk management (the change controls are the day-to-day expression of risk management).
- HIPAA **45 CFR § 164.312(b)** — audit controls (every change leaves an audit trail).

## 2. Scope

This policy applies to every change that affects Pharmax production systems, including:

- Application code (`apps/web`, `apps/worker`, `apps/print-agent`, every `packages/*`).
- Database schema migrations (`prisma/migrations/`).
- Infrastructure-as-code (Terraform under our private repo, deploy pipeline configuration).
- Production configuration (AWS Secrets Manager secrets, ECS task definitions, environment variables, feature flags).
- Vendor configuration that affects production behavior (Clerk auth rules, Stripe webhook endpoints, EasyPost / FedEx / UPS portal settings).

It does not apply to local development environment changes, documentation-only changes to internal documents, or changes to `evidence/` artifacts (which are records, not running configuration).

## 3. Standard change workflow

Every standard change follows the same shape. Deviations are emergency changes (§4) or require an exception under the [Information Security Policy](./information-security-policy.md) §8.

### 3.1 Branch

Work happens on a branch off `main`. Branch names follow `feat/`, `fix/`, `chore/`, `docs/`, `refactor/`, or `migration/` conventions. The branch name is the unit the team uses to talk about the change; clarity matters.

### 3.2 Pull request

Every change to `main` goes through a pull request. There are **no direct pushes to `main`**. The branch-protection rule in GitHub enforces this for every collaborator with write access; it cannot be bypassed by the author of the change, including the CTO. Exceptions require an explicit, written, time-limited grant from the CEO and are recorded in the quarterly access review.

The pull-request template (lives in `.github/pull_request_template.md`) requires explicit answers on the engineering-side risks codified in `../ARCHITECTURE_PRINCIPLES.md` §D — PHI access? Command bus? Audit chain? RLS? Idempotency key? Migration? Reviewer cannot proceed without those boxes answered.

### 3.3 Required CI checks

Every PR must pass the required CI checks before merge. The current required gates (documented in detail in the forthcoming `../CI_GATES.md`):

- **Type check.** `pnpm typecheck` across all workspaces. No `any`, no `@ts-nocheck`, no `@ts-expect-error` without a TODO link.
- **Lint.** `pnpm lint` with the ESLint boundary rules that enforce architectural invariants (e.g. `apps/web` cannot import `@prisma/client` directly; `withSystemContext` is allowlisted to four locations; `@pharmax/billing` cannot import the Stripe SDK).
- **Schema linter.** `pnpm check:schema` against `prisma/schema/*.prisma`. Forbids `String?` where an enum or FK exists, requires indexes on FKs, requires `@@map` snake_case, requires `organizationId` on every model not in the documented allowlist.
- **Migration linter.** `pnpm check:migrations` against `prisma/migrations/`. Requires `ENABLE ROW LEVEL SECURITY` + `CREATE POLICY` for every new tenant-scoped table, or an entry in `prisma/migrations/rls-exempt.txt` with a documented justification.
- **Unit and integration tests.** `pnpm test`. Includes the anti-leak property test in `@pharmax/tenancy`, the SoD tests in `@pharmax/verification`, the audit-chain verifier tests in `@pharmax/audit`, and the workflow-safety tests across `@pharmax/orders`.
- **Secret scanning.** GitHub secret scanning enabled at the organization level (linked from [`../security/secrets-management.md`](../security/secrets-management.md)). A push that contains a known secret pattern is blocked.
- **Dependency vulnerability scan.** A pull request that introduces a dependency with a critical CVE rating fails CI; remediation is required before merge.

The CI gates are the engineering safeguards in their executable form. A change that disables a required check requires CTO approval and is logged in the policy-exception process.

### 3.4 Required reviewers via CODEOWNERS

Every PR requires at least one approving review from a reviewer named in `CODEOWNERS` for the affected paths. The CODEOWNERS file (lives at `.github/CODEOWNERS`) routes:

- Security-sensitive paths (`packages/crypto/`, `packages/tenancy/`, `packages/audit/`, `packages/rbac/`, `prisma/migrations/`, anything under `apps/*/src/server/auth/`) require CTO review.
- Workflow-engine paths (`packages/command-bus/`, `packages/workflow/`, `packages/verification/`, `packages/orders/`) require review by the workflow-engine owner (CTO until that role spins out).
- Billing paths (`packages/billing/`, `apps/web/src/server/billing/`, `apps/worker/src/billing/`, `apps/worker/src/drains/stripe-*`) require billing-domain review.
- Documentation under `docs/policies/`, `docs/governance/`, `docs/security/` requires CTO review (this bundle is owned by the security program).

A PR cannot merge without the CODEOWNERS approval; the branch-protection rule enforces this on every protected branch.

### 3.5 Migrations — forward-only

Database migrations are forward-only. This is restated from `../RUNBOOK.md` §"Migrations: rules of the road":

- No `prisma migrate dev` against the prod DB. Use `prisma migrate deploy`.
- Every new tenant table needs RLS + FORCE RLS + a `tenant_isolation` policy. The migration linter enforces this on every PR.
- Index every FK and every `(organizationId, ...)` filter combination you actually query.
- Destructive changes (DROP, RENAME, type changes) require a two-step:
  - Step 1: deploy the new column or table alongside the old. Backfill. Dual-write from code.
  - Step 2: a future PR drops the old. Never single-step a destructive change against live traffic.
- A migration that fails halfway through is a SEV1 — do **not** run `prisma migrate resolve` to mark it applied without investigation.

The forward-only convention is the trade we make for being able to roll code back without rolling the database back. The runbook §"Rolling back a deploy" elaborates.

### 3.6 Merge

Merge is **squash-and-merge** for application-code changes, with the commit message generated from the PR title and body. Migration commits, ADRs, and policy changes use `merge` to preserve the authoring history when multiple authors contributed.

After merge, the deploy pipeline picks up the change. The author is responsible for watching the deploy through to production-healthy.

### 3.7 Post-merge verification

Within 30 minutes of a production deploy, the author (or the on-call engineer if the author is off-hours) verifies:

- Sentry error rate on the new release is at or below the pre-deploy baseline.
- Worker drain rates are nominal (`event-outbox-drain`, `stripe-webhook-event-drain`).
- The migration, if any, completed cleanly.
- The new feature behaves as expected against synthetic traffic.

A regression detected in the verification window triggers the [Incident Response Policy](./incident-response-policy.md) at the appropriate severity and may invoke the rollback path per `../RUNBOOK.md` §"Rolling back a deploy".

## 4. Emergency change procedure

An emergency change is one that cannot wait for the standard workflow because production is degraded or because a security threat requires immediate mitigation. The procedure:

1. **The on-call engineer** (or, for an off-hours emergency, anyone with deploy access who is paged in) initiates the change. The decision to take the emergency path is recorded in the incident channel with the time, the actor, and the rationale.
2. **The CTO is paged** if not already in the channel. The CTO either ratifies the path or directs an alternative.
3. **The change is made** under the active incident's identifier. The change goes through the standard branch + PR + CI process **if** time permits; if time does not permit, the change may be pushed directly with an open incident reference and a commit message that names the incident.
4. **A retroactive PR review** is conducted **within 24 hours** of the emergency. A reviewer who would have been required by CODEOWNERS reviews the change post hoc. Any concerns identified become follow-up tickets, tracked alongside the incident's action items.
5. **The postmortem** for the incident covers the emergency-change path as part of the timeline.

The emergency-change path is rare. Frequent emergency changes are themselves a finding; the postmortem must address why the standard path could not absorb the change.

Branch protection on `main` may be temporarily relaxed for an emergency by a CODEOWNER with the `Admin` role; the relaxation is logged automatically by GitHub and reviewed in the next quarterly access review.

## 5. Deployment cadence and rollback

### 5.1 Cadence

Pharmax deploys on a **continuous-delivery cadence** — merges to `main` trigger an automatic deploy to staging, with a one-click promote-to-production gate. The CTO and the team agree on a target weekly deploy count to maintain operational muscle memory; weeks with zero production deploys are an anomaly, not a goal.

The deploy pipeline is intentionally simple: build, test, push image, update the ECS task definition, wait for healthy. Each step's logs are retained.

### 5.2 Rollback

Rollback is documented in `../RUNBOOK.md` §"Rolling back a deploy". The summary:

- The deploy pipeline records the release SHA. Rollback is re-deploy of the prior SHA.
- Code rollback is fine; **schema rollback is not**. If a release ran a destructive migration, the rollback path is a new forward-only migration that restores the data — never `prisma migrate reset` in production.
- Rollback decisions during an incident are made by the IC per [Incident Response Policy](./incident-response-policy.md).

### 5.3 Feature flags

Feature flags are used to ship code to production without exposing the behavior. The conventions:

- Flag names are descriptive (`shipping.purchase_label_v2`, not `flag123`).
- Each flag has a documented owner and a documented retirement plan. Flags that survive past their retirement plan are technical debt and are tracked.
- Flag flips in production are a change under this policy: they go through CODEOWNERS review and are recorded in the change log.
- Flags are not a substitute for proper code review or CI gates — code behind a flag still runs in production and is still subject to all the architectural invariants.

## 6. Configuration management

Production configuration (env vars, ECS task definitions, AWS Secrets Manager secret values, Clerk policy settings, Stripe webhook endpoints) is treated as code:

- ECS task definitions, IAM policies, and other AWS configuration live in Terraform. Changes go through the standard PR workflow against the IaC repo.
- AWS Secrets Manager **secret values** are the only thing that does not live in the repo (because they shouldn't). The secret references and rotation cadence live in [`../security/secrets-management.md`](../security/secrets-management.md). Updating a secret value is an action recorded in CloudTrail and reviewed in the quarterly access review.
- Vendor portal settings are documented in the vendor-specific runbook entry. A change to a vendor portal setting (e.g. enabling a new Stripe webhook event) is announced in the team channel and recorded in the runbook.

## 7. Separation of duties at the change boundary

The architectural Separation of Duties rules (ADR 0011) constrain who can perform certain command-level operations on an order. The change-management equivalent constrains who can author and approve a change:

- An author cannot approve their own PR. GitHub enforces this with branch protection.
- For changes that touch the highest-risk paths (`packages/crypto/`, `packages/tenancy/`, `packages/audit/`, `prisma/migrations/`), the reviewer is by default the CTO. The CTO authors changes to those paths only when no other CODEOWNER is available; in that case, an additional review from a second engineer is required and recorded.
- An emergency change made by an author with elevated access (e.g. the CTO bypassing branch protection) is reviewed within 24 hours by another engineer.

## 8. Change record retention

The change record consists of:

- The Git history of `main` (retained indefinitely).
- The PR descriptions, reviews, and discussions in GitHub (retained per GitHub's retention).
- The CI build logs (retained for the period the CI provider supports).
- The deploy pipeline logs (retained for at least 12 months; longer where storage cost permits).
- For emergency changes, the incident channel export under `evidence/incidents/<YYYY>/`.

The combined record is sufficient for the SOC 2 audit-trail expectation and for HIPAA audit-controls obligations.

## 9. Cross-references

- [Information Security Policy](./information-security-policy.md) — parent.
- [`../RUNBOOK.md`](../RUNBOOK.md) — operational mechanics referenced here.
- [`../ARCHITECTURE_PRINCIPLES.md`](../ARCHITECTURE_PRINCIPLES.md) — the architectural invariants the CI gates enforce.
- [Incident Response Policy](./incident-response-policy.md) — the emergency-change path lives at the boundary of incident response.
- [`../security/secrets-management.md`](../security/secrets-management.md) — secret rotation as a configuration change.
- [Access Control Policy](./access-control-policy.md) — who can author and approve.
- ADR 0007 — Twenty-step command-bus contract.
- ADR 0011 — Separation of Duties at the command bus.
- ADR 0017 — Workflow policy migration (the schema-versioning posture).

## Revision history

| Version | Date       | Author | Change           |
| ------- | ---------- | ------ | ---------------- |
| 0.1     | YYYY-MM-DD | CTO    | Initial drafting |
