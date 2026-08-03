# Controls Inventory

A flat catalog of every Pharmax control referenced in the
[Trust Service Criteria mapping](./trust-service-criteria-mapping.md),
with status, owner, and review cadence. This is the file the auditor
reads to ask "is the control designed AND in place AND operating?".

For the **engineering crosswalk** — control → exact code paths +
audit / Prisma tables + `.test.ts` files + CI gate — see
[`code-evidence-map.md`](./code-evidence-map.md). The IDs in this
file are stable and authoritative; the code map fills in the file
paths.

Status vocabulary:

- **Implemented** — the control is in production and evidence is being
  generated on the stated cadence.
- **Partial** — the control is partially in place; there is a tracked
  gap with a remediation plan in the risk register.
- **Planned** — the control is on the roadmap with an owner and a
  target date. Not yet operating.
- **Deprecated** — the control was replaced by another control. The
  row is retained for lineage; the "Replaced by" column points at the
  successor.
- **N/A** — the control is not applicable to Pharmax's scope; the
  justification is the "Notes" column.

Owner is a role title — see
[`README.md`](./README.md#ownership) for the role roster.

## Common Criteria

| Control ID | Description                                                 | Status      | Owner              | Review Cadence        | Notes                                                                                                                                                                                                                                                 |
| ---------- | ----------------------------------------------------------- | ----------- | ------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CC1.1-1    | Policy-codified commitment to integrity and ethical values  | Implemented | Compliance Officer | Annual                | Acknowledged via signed `evidence/training/<year>/`.                                                                                                                                                                                                  |
| CC1.2-1    | Independent oversight (CEO approval on every policy)        | Partial     | CEO                | Annual                | Pending formal board governance pattern as company grows.                                                                                                                                                                                             |
| CC1.3-1    | Defined organizational structure and security authorities   | Implemented | CEO                | On-change             | Role roster in ISP §4; org chart maintained by People.                                                                                                                                                                                                |
| CC1.4-1    | Workforce competence via security + HIPAA training          | Implemented | Workforce Lead     | Annual                | [Security Training Program](../governance/security-training-program.md).                                                                                                                                                                              |
| CC1.5-1    | Accountability via sanctions and code-owner gating          | Implemented | CEO                | Per-event             | ISP §9; CODEOWNERS gates security-sensitive paths.                                                                                                                                                                                                    |
| CC2.1-1    | Internal information system supports control operation      | Implemented | Security Officer   | Continuous            | Audit chain + command log + outbox.                                                                                                                                                                                                                   |
| CC2.2-1    | Internal communication of objectives and controls           | Implemented | Workforce Lead     | Annual                | Onboarding curriculum + Slack `#sec`.                                                                                                                                                                                                                 |
| CC2.3-1    | External communication about the system and its controls    | Partial     | CTO                | On-change             | Customer security packet drafted; public security page pending. No automated lane exists.                                                                                                                                                             |
| CC3.1-1    | Security objectives specified clearly                       | Implemented | CTO                | Annual                | ISP §3.                                                                                                                                                                                                                                               |
| CC3.2-1    | Risks identified, analyzed, prioritized                     | Implemented | Security Officer   | Annual                | [Risk register](../governance/risk-register.md).                                                                                                                                                                                                      |
| CC3.3-1    | Fraud risk considered explicitly                            | Implemented | Security Officer   | Annual                | SoD (ADR-0011) + risk register entries.                                                                                                                                                                                                               |
| CC3.4-1    | Material-change risk re-assessment                          | Implemented | CTO                | On-change             | ADR template + change-management policy.                                                                                                                                                                                                              |
| CC4.1-1    | Ongoing performance monitoring                              | Implemented | Engineering Lead   | Continuous            | OBSERVABILITY.md four-layer model.                                                                                                                                                                                                                    |
| CC4.2-1    | Communication and remediation of deficiencies               | Implemented | Security Officer   | Per-event, quarterly  | Postmortems + access reviews.                                                                                                                                                                                                                         |
| CC5.1-1    | Control activities selected and developed                   | Implemented | CTO                | Continuous            | ADR set + policy bundle + invariant tests.                                                                                                                                                                                                            |
| CC5.2-1    | General technology controls (CI gates)                      | Implemented | Engineering Lead   | Continuous            | Typecheck, lint, schema linter, migration linter, CodeQL, gitleaks, dep review, SBOM.                                                                                                                                                                 |
| CC5.3-1    | Control activities deployed through policies and procedures | Implemented | Compliance Officer | Annual                | This bundle + onboarding checklist.                                                                                                                                                                                                                   |
| CC6.1-1    | Identity established before access                          | Implemented | Security Officer   | Quarterly             | ADR-0030 in-house engine; `packages/auth/src/commands/sign-in.ts`. Clerk retired.                                                                                                                                                                     |
| CC6.1-2    | RBAC + scope enforcement before mutation                    | Implemented | Security Officer   | Quarterly             | `@pharmax/rbac` + command bus step 3.                                                                                                                                                                                                                 |
| CC6.1-3    | Tenant isolation enforced at the database (RLS)             | Implemented | Engineering Lead   | Continuous            | ADR-0004; `pharmax_app` role FORCE RLS.                                                                                                                                                                                                               |
| CC6.1-4    | MFA floor for high-privilege roles                          | Implemented | Security Officer   | Continuous            | ADR-0030 / ADR-0036; `packages/auth/src/configure.ts:68` `MFA_REQUIRED_ROLE_CODES`.                                                                                                                                                                   |
| CC6.2-1    | Access grant / modify / remove under audit                  | Implemented | Security Officer   | Quarterly, per-event  | Every grant/revoke writes `audit_log`.                                                                                                                                                                                                                |
| CC6.2-2    | Quarterly access review with sign-off                       | Partial     | Security Officer   | Quarterly             | `scripts/security/run-access-review.ts` and the digest-sealed `access_review_snapshot` row are in place, but the evidence pack is written to ephemeral task storage — see EI-1 in [evidence-integrity-findings.md](./evidence-integrity-findings.md). |
| CC6.3-1    | RBAC + Separation of Duties at the bus                      | Implemented | Security Officer   | Continuous            | ADR-0011.                                                                                                                                                                                                                                             |
| CC6.4-1    | Physical access (AWS-managed)                               | Implemented | CTO                | Annual                | AWS SOC 2 report.                                                                                                                                                                                                                                     |
| CC6.5-1    | Deprovisioning on termination                               | Partial     | Workforce Lead     | Per-event             | `packages/auth/src/commands/deactivate-user.ts` revokes sessions in-transaction, but it is admin-initiated. The automated Clerk `user.deleted` lane was removed by ADR-0030 and nothing replaced it — see EI-6.                                       |
| CC6.6-1    | Transmission encryption (TLS everywhere)                    | Implemented | Engineering Lead   | Continuous            | ACM-managed certs + HSTS.                                                                                                                                                                                                                             |
| CC6.6-2    | Webhook authentication + idempotency                        | Implemented | Engineering Lead   | Continuous            | Stripe / EasyPost / FedEx / Resend signature verify under `apps/web/app/api/webhooks/`. Clerk lane retired.                                                                                                                                           |
| CC6.7-1    | Per-field envelope encryption with AAD binding              | Implemented | Security Officer   | Continuous            | ADR-0005; `LocalKmsAdapter` dev-only; AwsKmsAdapter prod (ADR-0023).                                                                                                                                                                                  |
| CC6.7-2    | PHI search via blind indexes                                | Implemented | Engineering Lead   | Continuous            | ADR-0010.                                                                                                                                                                                                                                             |
| CC6.8-1    | Malicious-software prevention and detection                 | Partial     | Engineering Lead   | Continuous            | CI dependency scan and gitleaks are real (`.github/workflows/security.yml`). Workstation antimalware has no artifact or attestation mechanism in the repository.                                                                                      |
| CC7.1-1    | Performance and capacity monitoring                         | Partial     | Engineering Lead   | Continuous            | Sentry operates. The ten CloudWatch alarms have empty `alarm_actions` in production — see EI-3.                                                                                                                                                       |
| CC7.1-2    | SAST on every PR (CodeQL)                                   | Implemented | Engineering Lead   | Continuous, on-change | ADR-0026 §1.                                                                                                                                                                                                                                          |
| CC7.2-1    | Detection of security events                                | Implemented | Security Officer   | Continuous, daily     | Chain verifier + nightly digest + Sentry, all on the application lane. The CloudWatch lane is unrouted — see EI-3.                                                                                                                                    |
| CC7.2-2    | Tamper-evident audit log (per-tenant hash chain)            | Implemented | Security Officer   | Continuous            | ADR-0006.                                                                                                                                                                                                                                             |
| CC7.2-3    | Daily signed Merkle root over the audit chain               | Partial     | Security Officer   | Daily                 | Both lanes have landed — `S3ObjectLockPublisher` and the KMS signing client in `packages/security/src/merkle/`, plus the Terraform bucket and CMK. Still Partial: no production run is evidenced and EI-2 is open.                                    |
| CC7.3-1    | Defined incident response process                           | Implemented | Security Officer   | Per-event             | [`incident-response-policy.md`](../policies/incident-response-policy.md).                                                                                                                                                                             |
| CC7.3-2    | Break-glass with 4-hour cap                                 | Implemented | Security Officer   | Per-event             | `@pharmax/rbac::breakGlass`; ADR-0011.                                                                                                                                                                                                                |
| CC7.4-1    | Response to identified security events                      | Partial     | Security Officer   | Per-event             | No durable incident record exists and no postmortem template is in the repository; `scripts/soc2/export-incident-log.ts` runs in declared stub mode — see EI-4.                                                                                       |
| CC7.5-1    | Recovery of systems (restore drill)                         | Partial     | Engineering Lead   | Quarterly             | Runbook plus `.github/workflows/restore-drill.yml`, which opens a quarterly tracking issue and runs a read-only preflight. No drill has been evidenced.                                                                                               |
| CC8.1-1    | All code changes through PR + review + CI                   | Implemented | Engineering Lead   | Continuous            | Branch protection + CODEOWNERS.                                                                                                                                                                                                                       |
| CC8.1-2    | All schema changes through versioned migrations             | Implemented | Engineering Lead   | Per-event             | `prisma/migrations/` + `scripts/check-migration-rls.ts`.                                                                                                                                                                                              |
| CC8.1-3    | All workflow changes through versioned policy               | Implemented | Engineering Lead   | Per-event             | ADR-0008 + ADR-0017; `workflow_policy` lifecycle.                                                                                                                                                                                                     |
| CC8.1-4    | Architectural decisions recorded (ADRs)                     | Implemented | CTO                | Per-event             | `docs/adr/`.                                                                                                                                                                                                                                          |
| CC9.1-1    | Risk mitigated through identified controls                  | Implemented | Security Officer   | Annual                | Risk register cross-references control IDs.                                                                                                                                                                                                           |
| CC9.2-1    | Vendor risk assessment and management                       | Implemented | Compliance Officer | Annual, on-change     | [`vendor-management-policy.md`](../policies/vendor-management-policy.md).                                                                                                                                                                             |

## Additional Criteria — Availability

| Control ID | Description                                       | Status      | Owner            | Review Cadence | Notes                                                                                                                                      |
| ---------- | ------------------------------------------------- | ----------- | ---------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A1.1-1     | Capacity monitored to meet committed availability | Implemented | Engineering Lead | Continuous     | Target-tracking auto-scaling at `infra/terraform/modules/ecs/main.tf:315`. Alarm notification is unrouted — see EI-3.                      |
| A1.2-1     | Environmental protections (multi-AZ + backups)    | Implemented | Engineering Lead | Continuous     | `rds_multi_az = true` and `rds_backup_retention_days = 35` at `infra/terraform/environments/prod/us-east-1/terraform.tfvars:44` and `:33`. |
| A1.2-2     | Backup integrity validated periodically           | Partial     | Engineering Lead | Quarterly      | [`restore-drill.md`](../operations/restore-drill.md); first drill pending.                                                                 |
| A1.3-1     | DR plan tested annually                           | Partial     | Engineering Lead | Annual         | BCP/DR policy drafted; tabletop pending. The secondary region has no `terraform.tfvars` — see EI-5.                                        |

## Additional Criteria — Processing Integrity

| Control ID | Description                                        | Status      | Owner            | Review Cadence    | Notes                                                                                                                                                                                                                                                                         |
| ---------- | -------------------------------------------------- | ----------- | ---------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PI1.1-1    | Twenty-step command-bus contract on every mutation | Implemented | Engineering Lead | Continuous        | ADR-0007 + 29 contract tests.                                                                                                                                                                                                                                                 |
| PI1.2-1    | Input validated (Zod + workflow engine)            | Implemented | Engineering Lead | Continuous        | ADR-0007 step 1 + ADR-0008.                                                                                                                                                                                                                                                   |
| PI1.3-1    | Processing monitored; exceptions tracked           | Implemented | Engineering Lead | Continuous        | `command_log`, `event_outbox`, SLA.                                                                                                                                                                                                                                           |
| PI1.4-1    | Output complete, accurate, distributed, protected  | Implemented | Engineering Lead | Continuous        | Outbox + ports/adapters.                                                                                                                                                                                                                                                      |
| PI1.4-2    | Tamper-evident processing records                  | Partial     | Security Officer | Continuous, daily | ADR-0006 hash chain is implemented, with `REVOKE UPDATE, DELETE` enforced in the RLS baseline migration. The ADR-0024 daily signing half is not evidenced in production (CC7.2-3). Aligned with [code-evidence-map.md](./code-evidence-map.md), which already read `Partial`. |
| PI1.5-1    | Stored data integrity-protected                    | Implemented | Engineering Lead | Continuous        | RLS + REVOKE UPDATE/DELETE on audit_log.                                                                                                                                                                                                                                      |

## Additional Criteria — Confidentiality

| Control ID | Description                                               | Status      | Owner              | Review Cadence | Notes                                                                                                                                                                                                           |
| ---------- | --------------------------------------------------------- | ----------- | ------------------ | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1.1-1     | Information classified per data-classification policy     | Implemented | Compliance Officer | Annual         | Four-tier classification.                                                                                                                                                                                       |
| C1.1-2     | PHI encrypted at the field level                          | Implemented | Security Officer   | Continuous     | ADR-0005 envelope encryption.                                                                                                                                                                                   |
| C1.1-3     | PHI search via non-reversible indexes                     | Implemented | Engineering Lead   | Continuous     | ADR-0010 blind indexes.                                                                                                                                                                                         |
| C1.1-4     | Document storage is classification-aware                  | Implemented | Engineering Lead   | Continuous     | ADR-0021 documents port.                                                                                                                                                                                        |
| C1.2-1     | Confidential information disposed when no longer required | Implemented | Security Officer   | Per-event      | `packages/patients/src/commands/crypto-shred-patient.ts` NULLs every envelope and blind-index column, destroying the per-row DEK. Not KEK rotation — `rotateKek` exists only on the dev-only `LocalKmsAdapter`. |

## Additional Criteria — Privacy

| Control ID | Description                                       | Status      | Owner              | Review Cadence        | Notes                                                                                                                                                       |
| ---------- | ------------------------------------------------- | ----------- | ------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1.1-1     | Notice provided to data subjects                  | Partial     | Compliance Officer | Annual, on-onboarding | Clinic-mediated; clinic notices on file.                                                                                                                    |
| P2.1-1     | Choice and consent managed per BAA                | Implemented | Compliance Officer | Annual                | BAA-mediated; clinic captures consent.                                                                                                                      |
| P3.1-1     | Collection limited to what is necessary           | Implemented | Engineering Lead   | Per-event, annual     | Schema review + ADR-0010 purpose registry.                                                                                                                  |
| P4.1-1     | Use, retention, disposal of personal information  | Partial     | Security Officer   | Per-event             | Retention windows in classification policy; export workflow pending.                                                                                        |
| P5.1-1     | Data-subject access (clinic-mediated)             | Partial     | Compliance Officer | Per-event             | `packages/patients/src/commands/view-patient.ts` is a single-record read under audit. No extract or export producer exists, so a request is served by hand. |
| P6.1-1     | Disclosure to third parties limited and tracked   | Implemented | Compliance Officer | Quarterly             | Vendor inventory + BAA tracker + carrier credentials.                                                                                                       |
| P7.1-1     | Quality of personal information                   | Implemented | Engineering Lead   | Continuous            | Verification gates (PV1, final) + workflow-policy gating.                                                                                                   |
| P8.1-1     | Monitoring and enforcement of privacy commitments | Implemented | Security Officer   | Continuous            | Cross-references CC2.1-1, CC6.2-2, CC7.3-1.                                                                                                                 |

## Maintenance

This file is refreshed on every control change. The control IDs are
stable across versions; status flags flip as work lands. Deprecations
are recorded but not deleted.

The table shape is machine-readable: `scripts/compliance/seed-control-plane.ts`
parses it into the control catalog and throws on an unrecognized status,
an unrecognized cadence, or a row whose cell count does not match the
header. Correct the contents of cells freely; do not rename, reorder, or
add columns, and do not introduce a status outside the vocabulary above,
without changing that parser in the same commit. A literal pipe inside a
cell must be escaped as `\|`.

Statuses that the control plane will soon derive from code probes rather
than from this column — CC5.2-1, CC7.1-2, CC8.1-1, CC8.1-2 — should not
be hand-maintained once that lane is live. Prefer letting the probe
compute them and treat a disagreement between probe and document as the
signal it is.

### Reconciliation, this revision

Six controls moved from Implemented to Partial after their
implementations were read rather than assumed: CC6.2-2, CC6.5-1,
CC6.8-1, CC7.1-1, CC7.4-1, P5.1-1. Six further rows kept their status
but had a materially wrong citation corrected — CC6.1-1, CC6.1-4, and
CC6.6-2 still named Clerk, which ADR-0030 retired; C1.2-1 named a
rotation mechanism that exists only in the dev KMS adapter; PI1.4-2
carried an Implemented status with "(partial)" in its own note; CC7.2-3
understated work that has since landed. Supporting evidence is in
[`evidence-integrity-findings.md`](./evidence-integrity-findings.md).

The Security Officer signs off on the inventory at the start of every
audit period and at the end of every quarterly access review. The
sign-off lives at `evidence/controls-inventory/<YYYY-Q#>/signoff.pdf`.
