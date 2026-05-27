# Evidence Inventory

Every evidence artifact an auditor reads to confirm operating
effectiveness, with the source it is generated from, the cadence at
which it is captured, the controls it satisfies, and where it lands
on disk.

Two layouts coexist:

- **Live sources** — queries, table snapshots, Terraform state, CI
  artifacts. An auditor reads these at the time of audit; no dated file
  is required.
- **Dated artifacts** — script outputs and human sign-offs that land
  under `evidence/<YYYY-Q#>/` (gitignored — operator-local). Each
  artifact has a deterministic filename so the auditor can navigate.

## Folder convention

```
evidence/
├── <YYYY-Q#>/                          # quarterly evidence pack
│   ├── access-reviews/<org-slug>.json
│   ├── audit-chain-summary.csv
│   ├── user-roster.csv
│   ├── access-grants.csv
│   ├── clerk-session-log.csv
│   ├── change-control-summary.csv
│   ├── vendor-inventory.csv
│   ├── incident-log.csv                # or "no-incidents.txt"
│   └── manifest.json                   # produced by run-quarterly-evidence-pack
├── access-reviews/<YYYY-Q#>/           # legacy per-org folder
├── incidents/<year>/<incident-id>/
├── training/<year>/<user>.pdf
├── policies/<year>/<policy>.pdf
├── baa/<vendor>/<vendor>-baa.pdf
├── vendor-soc2/<year>/<vendor>.pdf
├── dr-drills/<year>/<drill-id>/
├── pentests/<year>/<engagement>.pdf
├── break-glass/<year>/<id>.pdf
├── data-subject-requests/<year>/<id>/
├── shred-requests/<year>/<id>/
├── ci-runs/<period>/                   # if not linked from PR artifacts
└── controls-inventory/<YYYY-Q#>/signoff.pdf
```

The `evidence/` root is gitignored by convention; references to it from
this repo are textual only.

## Artifacts

### Continuous (live) artifacts

These are evidenced by query or by inspecting live configuration.

| Artifact                    | Source                                                | Controls satisfied                 | Notes                                                           |
| --------------------------- | ----------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------- |
| `audit_log` table           | Database                                              | CC2.1-1, CC6.2-1, CC7.2-2, PI1.4-2 | Tamper-evident per ADR-0006. Query with `organizationId` scope. |
| `audit_chain_state` table   | Database                                              | CC7.2-2                            | Per-tenant chain head pointer.                                  |
| `command_log` table         | Database                                              | PI1.1-1, PI1.3-1                   | Idempotency-keyed; every command attempt.                       |
| `event_outbox` table        | Database                                              | PI1.4-1                            | At-least-once delivery state.                                   |
| `clerk_webhook_event` table | Database                                              | CC6.1-1, CC6.5-1                   | Svix-verified lifecycle events.                                 |
| `user_role` table           | Database                                              | CC6.1-2, CC6.2-1                   | Grant assignments per user.                                     |
| `pg_policies` snapshot      | `SELECT * FROM pg_policies WHERE schemaname='public'` | CC6.1-3                            | RLS policy state.                                               |
| `workflow_policy` rows      | Database                                              | CC8.1-3                            | Versioned workflow policy with lifecycle.                       |
| ADR set                     | `docs/adr/` at period-end commit                      | CC8.1-4, CC5.1-1                   | One ADR per material decision.                                  |
| CI workflow files           | `.github/workflows/{ci,security}.yml`                 | CC5.2-1, CC7.1-2, CC8.1-1          | Branch protection cross-reference.                              |
| Branch-protection config    | `docs/security/branch-protection.{md,json}`           | CC8.1-1                            | Mirrors GitHub branch-protection state.                         |
| CODEOWNERS                  | `.github/CODEOWNERS`                                  | CC1.5-1, CC8.1-1                   | Security-sensitive paths gated.                                 |
| Terraform state             | `infra/terraform/environments/*/`                     | A1.2-1, CC6.6-1                    | RDS multi-AZ, ACM, security groups, WAF.                        |
| KMS key inventory           | AWS console / `aws kms list-keys`                     | CC6.7-1                            | Per-tenant KEK aliases.                                         |
| Schema-linter R6 / R7       | `pnpm run check:schema`                               | CC6.7-1, CC6.7-2, C1.1-2, C1.1-3   | CI-enforced.                                                    |
| Migration-linter            | `pnpm run check:migrations`                           | CC6.1-3                            | CI-enforced; RLS coverage on every new tenant table.            |
| Command-file linter         | `pnpm run check:commands`                             | PI1.1-1                            | CI-enforced; command shape pinned.                              |

### Daily artifacts

| Artifact                            | Source script                                      | Lands at                                                 | Controls satisfied | Cadence | Owner            |
| ----------------------------------- | -------------------------------------------------- | -------------------------------------------------------- | ------------------ | ------- | ---------------- |
| Audit-chain verification (all orgs) | `scripts/security/verify-audit-chain-all-orgs.ts`  | `evidence/audit-chain-verifications/<period>/<date>.tsv` | CC7.2-1, CC7.2-2   | Daily   | Security Officer |
| Nightly security digest             | `scripts/security/send-nightly-security-digest.ts` | `evidence/security-digests/<period>/<date>.json`         | CC7.2-1            | Daily   | Security Officer |
| Daily Merkle root manifest          | `scripts/security/sign-daily-merkle-root.ts`       | S3 Object Lock bucket (per ADR-0024)                     | CC7.2-3, PI1.4-2   | Daily   | Security Officer |

### Quarterly artifacts (the SOC 2 evidence pack)

Produced by `scripts/soc2/run-quarterly-evidence-pack.ts` into
`evidence/<YYYY-Q#>/`:

| Artifact                      | Source script                                            | Lands at                                             | Controls satisfied | Owner              |
| ----------------------------- | -------------------------------------------------------- | ---------------------------------------------------- | ------------------ | ------------------ |
| User roster                   | `scripts/soc2/export-user-roster.ts`                     | `evidence/<YYYY-Q#>/user-roster.csv`                 | CC6.1-1, CC6.5-1   | Security Officer   |
| Access grants                 | `scripts/soc2/export-access-grants.ts`                   | `evidence/<YYYY-Q#>/access-grants.csv`               | CC6.1-2, CC6.2-1   | Security Officer   |
| Clerk session log             | `scripts/soc2/export-clerk-session-log.ts`               | `evidence/<YYYY-Q#>/clerk-session-log.csv`           | CC6.1-1, CC6.5-1   | Security Officer   |
| Change control summary        | `scripts/soc2/export-change-control-summary.ts`          | `evidence/<YYYY-Q#>/change-control-summary.csv`      | CC8.1-1, CC8.1-2   | Engineering Lead   |
| Vendor inventory              | `scripts/soc2/export-vendor-inventory.ts`                | `evidence/<YYYY-Q#>/vendor-inventory.csv`            | CC9.2-1, P6.1-1    | Compliance Officer |
| Audit chain summary           | `scripts/soc2/export-audit-chain-summary.ts`             | `evidence/<YYYY-Q#>/audit-chain-summary.csv`         | CC7.2-2, PI1.4-2   | Security Officer   |
| Incident log                  | `scripts/soc2/export-incident-log.ts`                    | `evidence/<YYYY-Q#>/incident-log.csv`                | CC7.3-1, CC7.4-1   | Security Officer   |
| Access reviews (one per org)  | `scripts/security/run-access-review.ts`                  | `evidence/access-reviews/<YYYY-Q#>/<org>.json`       | CC6.2-2            | Security Officer   |
| Access-review sign-offs (PDF) | Human reviewer                                           | `evidence/access-reviews/<YYYY-Q#>/signed/<org>.pdf` | CC6.2-2            | Security Officer   |
| Backup restore drill log      | `scripts/operations/run-restore-drill.ts` (operator-run) | `evidence/dr-drills/<period>/<date>.txt`             | A1.2-2, CC7.5-1    | Engineering Lead   |
| Controls-inventory sign-off   | Human reviewer                                           | `evidence/controls-inventory/<YYYY-Q#>/signoff.pdf`  | CC4.2-1            | Security Officer   |
| Manifest of the pack          | `scripts/soc2/run-quarterly-evidence-pack.ts`            | `evidence/<YYYY-Q#>/manifest.json`                   | —                  | Security Officer   |

### Annual artifacts

| Artifact                    | Source                           | Lands at                                                               | Controls satisfied        | Owner              |
| --------------------------- | -------------------------------- | ---------------------------------------------------------------------- | ------------------------- | ------------------ |
| Policy approvals (signed)   | Human                            | `evidence/policies/<year>/<policy>.pdf`                                | CC1.2-1, CC5.3-1          | CEO                |
| Training completion         | Human + LMS                      | `evidence/training/<year>/<user>.pdf`                                  | CC1.1-1, CC1.4-1, CC2.2-1 | Workforce Lead     |
| Risk assessment refresh     | Human + risk register diff       | `evidence/risk-assessment/<year>/refresh.md` + `risk-register.md` diff | CC3.2-1, CC3.3-1, CC9.1-1 | Security Officer   |
| Penetration test report     | External vendor                  | `evidence/pentests/<year>/<engagement>.pdf`                            | CC7.4-1 (input)           | Security Officer   |
| DR tabletop log             | Human                            | `evidence/dr-drills/<year>/tabletop.md`                                | A1.3-1                    | Engineering Lead   |
| Vendor SOC 2 confirmations  | Vendor + procurement             | `evidence/vendor-soc2/<year>/<vendor>.pdf`                             | CC9.2-1                   | Compliance Officer |
| BAA execution per vendor    | Vendor + procurement             | `evidence/baa/<vendor>/<vendor>-baa.pdf`                               | CC9.2-1, C1.1-1           | Compliance Officer |
| Device-hygiene attestations | Workforce                        | `evidence/device-hygiene/<year>/<user>.pdf`                            | CC6.8-1                   | Workforce Lead     |
| Policy bundle export        | This bundle at period-end commit | `evidence/policies/<year>/bundle.zip`                                  | CC5.3-1                   | Compliance Officer |

### Per-event artifacts

| Artifact                         | Trigger                                 | Lands at                                                   | Controls satisfied                                                              | Owner              |
| -------------------------------- | --------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------ |
| Postmortem                       | Incident classified at severity ≥ MINOR | `evidence/incidents/<year>/<incident-id>/postmortem.md`    | CC7.3-1, CC7.4-1, CC4.2-1                                                       | Security Officer   |
| Customer notification            | Incident requiring customer comm        | `evidence/external-comms/<year>/<incident-id>.md`          | CC2.3-1                                                                         | CTO                |
| Regulator notification           | Incident requiring regulator comm       | `evidence/regulator-notifications/<year>/<incident-id>.md` | Per [`incident-response-policy.md`](../policies/incident-response-policy.md) §5 | Security Officer   |
| Break-glass justification        | Break-glass elevation                   | `evidence/break-glass/<year>/<id>.pdf`                     | CC7.3-2                                                                         | Security Officer   |
| Vendor onboarding                | New vendor                              | `evidence/vendor-onboarding/<vendor>/questionnaire.pdf`    | CC9.2-1                                                                         | Compliance Officer |
| Vendor decommissioning           | Vendor decommissioned                   | `evidence/vendor-decom/<vendor>/checklist.pdf`             | CC9.2-1                                                                         | Compliance Officer |
| Data-subject request fulfillment | Patient request via clinic              | `evidence/data-subject-requests/<year>/<id>/`              | P4.1-1, P5.1-1                                                                  | Compliance Officer |
| Crypto-shred                     | Right-to-be-forgotten request           | `evidence/shred-requests/<year>/<id>/`                     | C1.2-1                                                                          | Security Officer   |
| Exception approval               | Policy exception                        | `evidence/exceptions/<YYYY-Q#>/<id>.pdf`                   | Per ISP §8                                                                      | CEO                |
| Sanctions                        | Workforce violation                     | `evidence/sanctions/<year>/<id>.pdf`                       | CC1.5-1                                                                         | CEO                |

## What this inventory does NOT cover (and why)

- **PHI exports.** No evidence artifact in this inventory includes
  patient PHI. Every script that touches tenant data outputs opaque
  UUIDs for `organizationId` and `userId` and omits PHI columns. The
  auditor confirms PHI handling by inspecting code paths (ADR-0005,
  ADR-0010) and tests, not by reading PHI bytes.
- **Secrets.** No evidence artifact contains a secret (API key, KMS
  key material, webhook signing key). The CC6.6-2 evidence is "the key
  is configured and active", not "this is the key".
- **Source bytes of vendor SOC 2 reports.** Vendor reports are
  redistributable under NDA only; the inventory points to where the
  PDF lives (procurement system + `evidence/vendor-soc2/`), it does
  not embed them.

## Refresh

The Compliance Officer refreshes this inventory:

- On every new evidence artifact added by engineering.
- On every cadence change.
- During the quarterly evidence pack run (the manifest is
  cross-checked against this file).
- During the annual policy review.
