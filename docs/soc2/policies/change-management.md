# Change Management Policy — STUB

> **THIS IS A STUB.** Authoritative version:
> [`../../policies/change-management-policy.md`](../../policies/change-management-policy.md).
> Every `<TBD>` marker must be resolved by legal counsel and/or the
> SOC 2 auditor.

| Field          | Value                               |
| -------------- | ----------------------------------- |
| Owner          | Engineering Lead                    |
| Approver       | CTO                                 |
| Effective date | `<TBD>`                             |
| Last reviewed  | `<TBD>`                             |
| Next review    | `<TBD>`                             |
| Version        | 0.1-stub                            |
| Distribution   | Internal — Engineering + leadership |

## 1. Purpose

Define how code, schema, configuration, and infrastructure changes
move from development to production with appropriate review, testing,
and traceability.

## 2. Scope

- All commits to the Pharmax monorepo (apps, packages, scripts,
  prisma migrations, infrastructure code, CI workflows, documentation
  where it commits the organization to a control).
- All configuration changes to production systems (KMS keys, secrets,
  branch protection, vendor accounts).
- All Terraform-managed infrastructure.

## 3. Policy statements

### 3.1 PR-based workflow

Every change reaches `main` through a pull request. Direct pushes to
`main` are blocked by branch protection (see
[`../../security/branch-protection.md`](../../security/branch-protection.md)).

### 3.2 Required reviews

- At least one human review per PR.
- CODEOWNERS gates review on security-sensitive paths (auth, RBAC,
  crypto, tenancy, audit, migrations, Terraform, CI workflows).
- A PR cannot be merged with unresolved CODEOWNERS-required reviews.

### 3.3 CI gates

CI runs on every PR and on every push to `main`. Required checks:

- Typecheck (`pnpm typecheck`).
- Lint (`pnpm lint`, `pnpm format:check`).
- Prisma validate (`pnpm prisma:validate`).
- Schema linter (`pnpm check:schema`).
- Migration linter (`pnpm check:migrations`).
- Command-file linter (`pnpm check:commands`).
- Event registry validation (`pnpm events:validate`).
- Unit tests with coverage (`pnpm test`).
- Dependency vuln scan (`pnpm audit`).
- CodeQL `security-extended` (ADR-0026).
- Gitleaks (secret scan, ADR-0026).
- Dependency-review on PR (ADR-0026).
- SBOM generation on push to `main` (ADR-0026).

A failing required check blocks merge.

### 3.4 Migration changes

- Schema changes are expressed as Prisma migrations under
  `prisma/migrations/`.
- The migration linter (`scripts/check-migration-rls.ts`) enforces
  RLS coverage on every new tenant-scoped table.
- Migrations are forward-only; rollback uses a forward migration that
  reverses the change.
- `<TBD by SOC 2 auditor: confirm wording around production migration
approval — typically requires a named approver outside the
developer making the change.>`

### 3.5 Workflow-policy changes

- Workflow rules are versioned data (`workflow_policy` rows), not
  code (ADR-0008 + ADR-0017).
- The lifecycle is DRAFT → ACTIVE → SUPERSEDED → ARCHIVED.
- Verification records cite the policy version active at the time of
  the verification.

### 3.6 Architectural changes

- Architecturally significant changes are recorded as ADRs under
  `docs/adr/`.
- The ADR template (ADR-0001 governs the practice) requires Context /
  Decision / Consequences / Alternatives Considered.

### 3.7 Emergency change procedure

`<TBD by SOC 2 auditor: explicit "emergency change" procedure that
defines who can authorize bypassing the normal CI / review gates,
under what circumstances, with what compensating controls (post-hoc
review, postmortem cross-reference).>`

## 4. Roles and responsibilities

| Role                        | Responsibility                                                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engineering Lead            | Day-to-day operation of the change-management process; quarterly review per the [change-management-review](../playbooks/change-management-review.md) playbook. |
| CODEOWNERS-listed engineers | Review of changes to their owned paths.                                                                                                                        |
| Security Officer            | Review of every PR touching auth, RBAC, crypto, tenancy, audit, or migration paths.                                                                            |
| CTO                         | Approval of ADRs and material architectural changes.                                                                                                           |

## 5. Enforcement and sanctions

`<TBD by legal counsel: sanctions for direct-production-writes, for
unreviewed merges, or for emergency-change abuse.>`

## 6. Review cadence

Annual, plus quarterly review per the change-management-review
playbook.

## 7. References

- ADR-0007 (command-bus contract).
- ADR-0008, ADR-0017 (workflow policy).
- ADR-0026 (CI security gates).
- [`../../security/branch-protection.md`](../../security/branch-protection.md).
- [`.github/CODEOWNERS`](../../../.github/CODEOWNERS).

## 8. Revision history

| Version  | Date    | Author      | Change                  |
| -------- | ------- | ----------- | ----------------------- |
| 0.1-stub | `<TBD>` | Engineering | Initial framework stub. |
