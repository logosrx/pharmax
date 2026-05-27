# 0026 — CI security gates: CodeQL, gitleaks, dependency review, SBOM, CODEOWNERS

- **Status:** Accepted
- **Date:** 2026-05-25
- **Deciders:** Platform team, Security officer
- **Tags:** `security`, `compliance`, `ci`, `soc2`

## Context

The existing `ci.yml` enforces build correctness (lint, format,
typecheck, prisma-validate, custom safety linters, unit tests with
coverage). That is enough to keep the build green, but it is NOT
enough for SOC 2 Type 1 design adequacy on:

- **CC6.1 — Logical access.** Auditors expect evidence that code
  changes touching auth, RBAC, crypto, or audit paths are reviewed
  by someone whose role is to gate them.
- **CC7.1 — Threat detection.** Auditors expect a continuous static
  analysis signal (SAST) against the production code path. Today
  we run no SAST.
- **CC8.1 — Change management.** Auditors expect every merge to
  `main` to have produced a documentable artefact trail: who
  approved, what tests ran, what dependencies were introduced,
  what vulnerabilities were known at merge time.
- **HIPAA Security Rule § 164.308(a)(1)(ii)(A) — Risk analysis.**
  Auditors expect a continuous inventory of software components
  (an SBOM) that they can cross-reference against the CVE feed.

We also have an ongoing operational risk: any PR can in theory
include a leaked secret (Clerk webhook secret, EasyPost token,
AWS access key copied from a teammate's terminal). The `pnpm audit`
job in `ci.yml` catches CVEs in published deps but cannot catch
in-repo secret leakage.

## Decision

Add a new `.github/workflows/security.yml` workflow alongside the
existing `ci.yml`, gated as an additional required check on `main`
via branch protection. Add four jobs:

### 1. CodeQL — SAST

`github/codeql-action@v3` running the `security-extended` query
pack against `javascript-typescript`. Findings post to the GitHub
Security tab AND fail the job at `error` severity. Warnings show
up but do not block.

We chose CodeQL over Semgrep because:

- It is GitHub-native (no third-party SaaS to negotiate a BAA with).
- The HIPAA-relevant queries (broken auth, weak crypto, taint
  flows) are covered by `security-extended` out of the box.
- Findings live in the GitHub Security tab where the security
  officer already monitors Dependabot alerts; one fewer console.

### 2. Gitleaks — secret scanning

`gitleaks/gitleaks-action@v2` against the PR diff (and full
history on push-to-main). We extend the default ruleset with
Pharmax-specific patterns in `.github/gitleaks.toml`:

- Clerk `sk_*`, `pk_live_*`, `whsec_*`.
- EasyPost `EZTK*`, `EZAK*`.
- A guarded pattern for `PHARMAX_LOCAL_KMS_SEED` assignments
  that allows the CI-only seed in `integration.yml` but blocks
  everywhere else.

Gitleaks blocks (`continue-on-error: false`). A leaked credential
is a critical incident, not advisory.

### 3. Dependency review

`actions/dependency-review-action@v4` diffs the lockfile against
the OSV / GHSA advisory feed on every PR. Hard-fails on `high` or
`critical` severity. Blocks copyleft license additions
(AGPL/GPL family) — Pharmax is a closed-source product and we
cannot accept new copyleft transitive deps without a security
review.

### 4. SBOM

`anchore/sbom-action@v0` produces an SPDX-JSON SBOM artefact on
every push to `main` and on every PR. Today it is stored in the
workflow run artefacts (90-day retention). Tier 2 plans will move
these to a dedicated evidence bucket for the SOC 2 evidence
binder.

### 5. CODEOWNERS

`.github/CODEOWNERS` defines dual ownership for security-critical
paths: `@pharmax/platform` AND `@pharmax/security` both must
approve any PR touching:

- `apps/web/src/server/auth/**` (identity, MFA gate, tenancy
  resolution).
- `packages/crypto/**`, the bootstrap files of each app
  (KMS wiring).
- `packages/audit/**`, `packages/security/**` (audit log,
  Merkle root, break-glass).
- `packages/rbac/**`, `packages/tenancy/**` (authorization).
- `packages/billing/**`, billing routes, Stripe drains
  (financial integrity).
- `infra/**`, `.github/workflows/**` (production change).
- `docs/policy/**`, `docs/security/**`, `SECURITY.md`,
  `CODEOWNERS` itself (the policy controls these controls).

Branch protection (see `docs/security/branch-protection.md`)
turns CODEOWNERS into a hard gate via
`require_code_owner_reviews: true`. Until the GitHub teams exist,
the file is read as documentation; once teams are created (this
is a 5-minute org-admin operation) the gate goes live.

### 6. `SECURITY.md`

Public-facing vulnerability disclosure policy at the repository
root. Covers reporting channel, response SLA, scope, safe-harbor
terms, and coordinated-disclosure timeline. SOC 2 CC7.5 calls out
"the entity establishes a process to receive and act on
externally identified vulnerabilities"; `SECURITY.md` is the
documented process.

## Consequences

### Easier

- Every PR that lands on `main` has a documentable audit trail:
  `ci-pass`, `security-pass`, (sometimes `integration`), with the
  CodeQL findings link, the SBOM artefact, and the dependency
  diff visible from one place. The SOC 2 evidence binder can
  cite the workflow run URL.
- Security-critical reviews become a structural property of the
  PR flow, not a convention. A change to KMS adapter logic
  cannot merge without the security owner; this is exactly the
  CC8.1 control auditors will look for.
- Secret leaks become a CI-time finding instead of an incident.
  Gitleaks blocks at the diff before the secret can be exposed
  through a public PR URL.

### Harder

- PRs that touch security-critical paths now block on a second
  approver. That is intentional and is the SOC 2 ask, but it
  adds a coordination cost. Mitigation: the dual ownership is
  scoped — most PRs do not touch these paths. The signal-to-noise
  on additional approvals stays high.
- The four new jobs add roughly 5–10 minutes of CI wall-time. We
  accept this; `security-pass` is in parallel with `ci-pass`, and
  the long-pole job is CodeQL which would not block iteration on
  feature branches (those merge via squash from feature PRs).

## Ongoing obligations

- The placeholder GitHub team handles in `CODEOWNERS`
  (`@pharmax/platform`, `@pharmax/security`,
  `@pharmax/infrastructure`, `@pharmax/database`) MUST exist before
  branch protection enables `require_code_owner_reviews`. Until
  then the file is read as documentation, and we should add the
  named individuals manually as required reviewers in branch
  protection.
- `SECURITY.md` ships a placeholder reporting email
  (`security@pharmax.example`). The first deployment to a real
  customer requires:
  1. Replace the email with the live mailbox address.
  2. Publish the PGP public key referenced by the well-known URL.
  3. File a follow-up PR to remove the "placeholder" callout from
     this ADR.
- The `branch-protection.json` snapshot drifts from reality if
  someone changes the UI without updating the file. The ops lane
  has a planned evidence script that diffs the GitHub state vs the
  JSON on a nightly cadence; until that ships, treat any UI
  change as a violation of CC8.1 and revert.

## Alternatives considered

- **Snyk / GitHub Advanced Security paid tier.** Adds richer
  vulnerability signals (e.g. reachability analysis) but
  introduces a vendor we would otherwise not depend on. CodeQL +
  Dependabot already cover the SOC 2 ask without an extra BAA.
- **Run security checks only on push to `main`.** Cheaper, but
  means a PR with a leaked secret has a live secret on a PR URL
  for the duration of the review. The PR-time gate is the right
  trade.
- **Add the security jobs to `ci.yml` instead of a separate
  workflow.** Tempting for one less file, but mixing build
  correctness checks with security checks makes the gate logic
  in `ci-pass` harder to reason about — and a security workflow
  may legitimately have different `permissions:` blocks (CodeQL
  needs `security-events: write`) that we do NOT want on the
  build-correctness jobs.
- **Block on Dependabot pull requests automatically.** Out of
  scope for this ADR; Dependabot is its own surface area
  governed by `dependabot.yml`. A future ADR can layer
  auto-merge for low-severity updates once we have confidence in
  the rest of the gate.
