# Audit Readiness Checklist

A one-page operator checklist run in the two weeks before a SOC 2
audit (Type I design adequacy or Type II operating effectiveness)
walk-through, and once a quarter as a standalone readiness pulse.

The order matters: each item gates the next. Stop at the first failing
item and remediate before continuing — a partial readiness state is
worse than a clear one.

Owner per item is a role title; see
[`README.md`](./README.md#ownership). An item that says **"document the
gap"** without a remediation date is a control deficiency and must be
recorded in the [risk register](../governance/risk-register.md).

## Known-open gaps as of this revision

Read these before running the checklist. Every one of them will make an
item below fail, and knowing which failures are already understood is
the difference between a readiness pulse and a fire drill.

- **230 placeholder markers are unresolved** across the policy,
  security, and governance documents. The full breakdown, with owners
  and which audit gate each blocks, is in
  [`placeholder-inventory.md`](./placeholder-inventory.md). Section 9
  below therefore fails today by design; treat the inventory as the
  work list rather than re-deriving it.
- **Six evidence-integrity findings are open**, two of them High. They
  are written as actionable tasks in
  [`evidence-integrity-findings.md`](./evidence-integrity-findings.md)
  and are referenced by ID (`EI-1` … `EI-6`) from the affected items
  below and from the controls inventory.
- **Fourteen of sixty-nine controls are `Partial`**, up from eight,
  after the inventory was reconciled against the code. See the
  reconciliation note at the end of
  [`controls-inventory.md`](./controls-inventory.md).

## Pre-audit checklist

### Section 1 — Framework integrity (Compliance Officer)

- [ ] `trust-service-criteria-mapping.md` last-modified date is within
      the current quarter. If older, run the annual policy-review
      playbook to refresh.
- [ ] `controls-inventory.md` status column reviewed; every
      `Implemented` row reflects current code; every `Partial` /
      `Planned` row has a remediation owner and date in the risk
      register.
- [ ] `evidence-inventory.md` refreshed; every artifact in the
      quarterly pack actually landed in the most recent
      `evidence/<YYYY-Q#>/`.
- [ ] All ADRs current; ADR status reflects actual deployment state.
      No ADRs in `Proposed` status that have already shipped; no
      `Accepted` ADRs that have been silently undone.

### Section 2 — Periodic controls (Security Officer)

- [ ] Quarterly access review completed within the last 90 days for
      every active tenant. Signed PDFs under
      `evidence/access-reviews/<YYYY-Q#>/signed/`. `EI-1` resolved
      2026-08-06: the pack is written by the S3 Object Lock publisher
      to the audit-archive bucket, and production refuses to boot with
      the review enabled but the bucket unconfigured. Confirm the pack
      objects exist under the bucket's `access-reviews/` prefix AND
      cross-check the `access_review_snapshot` rows' `digestSha256`.
- [ ] Audit-chain verifier (`scripts/security/verify-audit-chain-all-orgs.ts`)
      run within the last 24 hours and exit code was 0 (no chain
      breaks).
- [ ] Daily Merkle-root signing job ran < 26 hours ago for every active
      tenant. Manifest landed in S3 Object Lock bucket (ADR-0024). The
      code and Terraform lanes have both landed — the worker refuses to
      boot in production without `AUDIT_ARCHIVE_S3_BUCKET` — so the
      question is now whether a production run is evidenced, not
      whether the lane exists. `EI-2` resolved 2026-08-06: the bucket
      policy now denies a `PutObject` naming any Object Lock mode other
      than COMPLIANCE, and one whose retention is under the six-year
      floor (`scripts/audit-archive-bucket-policy.test.ts` pins both).
- [ ] Nightly security digest (`scripts/security/send-nightly-security-digest.ts`)
      delivered every night in the period — confirm dispatch records.
- [ ] Break-glass usage in the period reviewed; every elevation has a
      justification PDF and the elevation auto-expired within its
      4-hour cap (ADR-0011).

### Section 3 — Availability and recovery (Engineering Lead)

- [ ] Last backup restore drill completed within the last 90 days.
      Restore-drill log under `evidence/dr-drills/<period>/` with
      post-restore `verifyChain` exit code 0. The quarterly cadence is
      enforced by `.github/workflows/restore-drill.yml`, which opens a
      tracking issue and runs a read-only preflight; the destructive
      phases stay human-in-the-loop, so a green workflow is not a
      completed drill.
- [ ] Last DR tabletop exercise completed within the last 12 months.
      **Note `EI-5`:** the secondary region carries no
      `terraform.tfvars`, so a region-failover scenario is a paper
      exercise today.
- [ ] RDS automated backups verified — retention and Multi-AZ are set
      in `infra/terraform/environments/prod/us-east-1/terraform.tfvars`
      (`rds_backup_retention_days = 35`, `rds_multi_az = true`);
      confirm the most recent automated snapshot is < 26 hours old.
- [ ] CloudWatch alarms reviewed; no alarm in `INSUFFICIENT_DATA` for
      more than 7 days without an explanation. `EI-3` resolved
      2026-08-06: every alarm routes to a severity-tiered SNS topic
      (`enable_alerting = true` in prod tfvars; CI-enforced by
      `pnpm check:alarm-actions`). Confirm
      `terraform output alerting_critical_subscription_count` is > 0
      and that a deliberately tripped test alarm reached a human —
      that delivery test is the one part still unexercised.

### Section 4 — Change management (Engineering Lead)

- [ ] Change-management policy followed in the period — every PR
      merged to `main` had at least one approving review; CI green;
      branch-protection rules unchanged. Confirm by running
      `scripts/soc2/export-change-control-summary.ts` and reviewing
      the count of PRs vs migrations.
- [ ] No direct production database writes in the period (auditable
      via `audit_log` for grants, `command_log` for mutations; any
      DBA-shell session is logged in CloudTrail).
- [ ] Every migration in the period passed `scripts/check-migration-rls.ts`.
- [ ] Every command file added passed `scripts/check-command-files.ts`.
- [ ] CodeQL (ADR-0026 §1) has no open `error`-severity findings older
      than 14 days; gitleaks has no findings; dependency-review has no
      `critical` CVEs older than 7 days.

### Section 5 — Vendor management (Compliance Officer)

- [ ] Vendor risk reviews current for every vendor in the inventory
      (`docs/governance/vendor-inventory.md`).
- [ ] Every PHI-touching vendor has a BAA on file
      (`docs/governance/baa-tracker.md`) and the BAA has not lapsed.
- [ ] Vendor SOC 2 reports current (within annual renewal window) for
      every PHI-touching vendor (AWS, EasyPost, and the observability
      vendor once selected). Clerk is no longer in scope — ADR-0030
      moved authentication in-house — so its absence from the vendor
      pack is correct, not a gap.
- [ ] No new vendor added in the period without going through the
      vendor onboarding playbook.

### Section 6 — Penetration test and risk assessment (Security Officer)

- [ ] Penetration test completed within the last 12 months and
      findings remediated or accepted with a risk-register entry.
      Pentest report under `evidence/pentests/<year>/`.
- [ ] Annual risk assessment refresh completed within the last 12
      months. Refresh memo under `evidence/risk-assessment/<year>/`.

### Section 7 — Incident response (Security Officer)

- [ ] Every incident in the period has a postmortem under
      `evidence/incidents/<year>/<incident-id>/`. **Open gap `EI-4`:**
      no durable incident record exists in the system, so nothing
      enforces the completeness of that folder.
      `scripts/soc2/export-incident-log.ts` runs in declared stub mode
      and emits an `audit_log` proxy, which is a cross-check and not a
      population. If the period had no incidents, land the explicit
      `no-incidents-<period>.txt` marker the exporter's banner
      describes.
- [ ] Every incident classified `MAJOR` or `CRITICAL` had a customer
      notification and a regulator notification where required, with
      copies under `evidence/external-comms/<year>/` and
      `evidence/regulator-notifications/<year>/`.
- [ ] On-call rotation in [`docs/RUNBOOK.md`](../RUNBOOK.md) reflects
      the current schedule; no orphaned on-call shifts.

### Section 8 — Workforce (Workforce Lead)

- [ ] Security training completed by every employee within the last
      12 months. Completion records under `evidence/training/<year>/`.
- [ ] Acceptable-use policy acknowledgment current for every employee.
- [ ] Every termination in the period had a `DeactivateUser` command
      (`packages/auth/src/commands/deactivate-user.ts`) within 24 hours,
      flipping `User.status` to `SUSPENDED` or `TERMINATED` and revoking
      the user's sessions in the same transaction. Audit via
      `command_log` and `audit_log`, not `clerk_webhook_event` — that
      table has had no writer since ADR-0030 (`EI-6`). Because the
      command is admin-initiated rather than triggered by an identity
      provider, reconcile the termination list from HR records; the
      system cannot tell you about a termination nobody actioned.
- [ ] Device-hygiene attestations current for every employee with
      production access.

### Section 9 — Policy bundle (Compliance Officer)

- [ ] Every policy in [`../policies/`](../policies/) has a current
      `Last reviewed` date within the last 12 months.
- [ ] Every policy has a signed approval PDF for the current version
      under `evidence/policies/<year>/`.
- [ ] No policy in the bundle has unresolved placeholder markers in the
      front matter (Owner, Approver, Effective date, Last reviewed, Next
      review). **This item fails today.** All 22 authoritative documents
      carry `[Effective date: TBD]`, and the nine framework stubs carry
      81 `<TBD>` markers between them. Work the list in
      [`placeholder-inventory.md`](./placeholder-inventory.md), which
      names the owner and the blocking gate for each; do not re-count
      them here. Resolve a marker by deleting it and stating the fact —
      never by blanking it.
- [ ] The framework stubs under [`policies/`](./policies/) and the
      authoritative policies under [`../policies/`](../policies/) do
      not disagree on the policy structure; if they do, the
      authoritative version wins and the stub is updated.

### Section 10 — Final readiness sign-off (CTO + Security Officer + Compliance Officer)

- [ ] All sections 1-9 complete or with explicit gap remediation
      dates entered in the risk register.
- [ ] `scripts/soc2/run-quarterly-evidence-pack.ts --from=<start>
--to=<end>` executed and the resulting manifest under
      `evidence/<YYYY-Q#>/manifest.json` lists every expected artifact.
- [ ] Auditor working folder prepared with a copy of: - this checklist (filled in) - the quarterly evidence pack - the controls inventory sign-off - read-only role + connection details for the audit-sample
      queries

The CTO, Security Officer, and Compliance Officer co-sign the final
checklist as `evidence/audit-readiness/<YYYY-Q#>/signed.pdf`.

## Failure modes

A failing item is one of:

- **Cadence missed** — a periodic control did not produce on time.
  Mitigate by running the script now and document the slip.
- **Gap with no owner** — the most serious failure. Stop the checklist;
  the CTO assigns an owner and a target before resuming.
- **Drift** — the framework says one thing, the code says another.
  Reconcile the framework to the code (the code is the truth);
  re-run the relevant playbook.

Three or more failed items in a single run is a signal to delay the
audit, not to push through. A delayed audit is recoverable; a failed
audit is not.
