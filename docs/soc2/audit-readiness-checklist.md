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
      `evidence/access-reviews/<YYYY-Q#>/signed/`.
- [ ] Audit-chain verifier (`scripts/security/verify-audit-chain-all-orgs.ts`)
      run within the last 24 hours and exit code was 0 (no chain
      breaks).
- [ ] Daily Merkle-root signing job ran < 26 hours ago for every active
      tenant. Manifest landed in S3 Object Lock bucket (ADR-0024).
      If the signing lane is not yet wired, document the gap with a
      target completion date.
- [ ] Nightly security digest (`scripts/security/send-nightly-security-digest.ts`)
      delivered every night in the period — confirm dispatch records.
- [ ] Break-glass usage in the period reviewed; every elevation has a
      justification PDF and the elevation auto-expired within its
      4-hour cap (ADR-0011).

### Section 3 — Availability and recovery (Engineering Lead)

- [ ] Last backup restore drill completed within the last 90 days.
      Restore-drill log under `evidence/dr-drills/<period>/` with
      post-restore `verifyChain` exit code 0.
- [ ] Last DR tabletop exercise completed within the last 12 months.
- [ ] RDS automated backups verified — 35-day retention, multi-AZ,
      most recent automated snapshot < 26 hours old.
- [ ] CloudWatch alarms reviewed; no alarm in `INSUFFICIENT_DATA` for
      more than 7 days without an explanation.

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
      every PHI-touching vendor (AWS, EasyPost, Clerk, observability
      vendor).
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
      `evidence/incidents/<year>/<incident-id>/`.
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
- [ ] Every termination in the period had a Clerk webhook
      `user.deleted` event followed by a Pharmax `User.status =
INACTIVE` flip within 24 hours (audit via `clerk_webhook_event`).
- [ ] Device-hygiene attestations current for every employee with
      production access.

### Section 9 — Policy bundle (Compliance Officer)

- [ ] Every policy in [`../policies/`](../policies/) has a current
      `Last reviewed` date within the last 12 months.
- [ ] Every policy has a signed approval PDF for the current version
      under `evidence/policies/<year>/`.
- [ ] No policy in the bundle has `[TBD]` markers in the front matter
      (Owner, Approver, Effective date).
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
