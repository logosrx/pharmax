# Playbook: Change Management Review

| Field                | Value                                                                 |
| -------------------- | --------------------------------------------------------------------- |
| Controls satisfied   | CC8.1-1, CC8.1-2, CC8.1-3, CC8.1-4, CC5.2-1, CC7.1-2                  |
| Cadence              | Quarterly (as part of the audit-readiness pack) plus on-event         |
| Owner                | Engineering Lead                                                      |
| Reviewers            | CTO (sample), Security Officer (auth/crypto/audit-path PRs)           |
| Final sign-off       | Engineering Lead                                                      |
| Evidence destination | `evidence/<YYYY-Q#>/change-control-summary.csv` and CI artifact links |

## Purpose

Confirm that every change in scope for the period reached production
through the documented change-management process: PR with CODEOWNERS
review, green CI, branch-protected merge, traceable deploy, with
schema and workflow changes captured as versioned migrations and
versioned workflow policies respectively.

## Inputs

- `git log --merges --first-parent main` for the period.
- `prisma/migrations/` additions in the period.
- `workflow_policy` rows created or transitioned in the period.
- CI run history for the period (GitHub Actions).
- Branch protection state at period-end vs period-start.

## Procedure

### Step 1 — Generate the change-control summary

```sh
pnpm tsx scripts/soc2/export-change-control-summary.ts \
  --from=<period-start> --to=<period-end>
```

Output: `evidence/<YYYY-Q#>/change-control-summary.csv` with columns:

- PR number, title, author, reviewer(s), merge SHA, merge time
- Migration directory (if the PR added one)
- Workflow-policy mutation (if the PR transitioned a policy)
- CI run id and status at merge time

### Step 2 — Sample review

The CTO samples N PRs per the standard sampling rate (5 PRs per 50
merged, minimum 5). For each sampled PR:

- Confirm at least one reviewer (CODEOWNERS-required for the affected
  paths).
- Confirm CI green at merge time.
- Confirm the merge SHA matches a build artifact that reached
  production.
- Confirm the PR description names the user-visible behavior change.

### Step 3 — Security-sensitive path review

The Security Officer reviews every PR in the period that touched any
of these paths:

- `packages/audit/**`
- `packages/rbac/**`
- `packages/crypto/**`
- `packages/tenancy/**`
- `packages/command-bus/**`
- `apps/web/src/server/auth/**`
- `apps/web/app/api/webhooks/**`
- `prisma/migrations/**`
- `infra/terraform/**`
- `.github/workflows/**`

For each: confirm a Security Officer review, confirm the security
implications are documented in the PR description, confirm any new
ADR exists if the change is architecturally significant.

### Step 4 — Migration cross-check

For each migration directory in the period:

- Confirm `scripts/check-migration-rls.ts` passed in CI for the PR
  that introduced it.
- Confirm the migration includes RLS policies for any new
  tenant-scoped table.
- Confirm the migration is forward-only (no destructive change without
  a documented compatibility plan).

### Step 5 — Workflow-policy cross-check

For each `workflow_policy` row created or transitioned in the period:

- Confirm the lifecycle (DRAFT → ACTIVE → SUPERSEDED → ARCHIVED) was
  followed (ADR-0017).
- Confirm at most one ACTIVE per `(organizationId, code)` (the
  partial unique index enforces this; the cross-check is a sanity
  query).
- Confirm verification records produced during the period cite a
  policy version that was ACTIVE at the time of the record.

### Step 6 — Branch protection drift check

Compare current `docs/security/branch-protection.{md,json}` to the
live GitHub branch-protection state for `main`. Any drift is a
control deficiency.

### Step 7 — Final sign-off

The Engineering Lead signs:

`evidence/change-control/<YYYY-Q#>/signoff.pdf`

The sign-off names the sampled PRs, the security-sensitive PR review
outcomes, the migration / workflow / branch-protection cross-check
results, and any open remediation items.

## Exception handling

- **Emergency hotfix that bypassed normal review.** Acceptable per the
  change-management policy if (a) at least one peer approval is
  recorded post-hoc, (b) a postmortem references the bypass, and (c)
  the bypass is logged in the risk register if it recurs > 1× per
  quarter.
- **Direct production write.** Not acceptable. Document the incident
  per the incident-response playbook.
- **CODEOWNERS gap.** If a security-sensitive PR was merged without a
  Security Officer review, treat as a CC8.1 deficiency. Add a
  CODEOWNERS entry to prevent recurrence; record the gap in the risk
  register.
