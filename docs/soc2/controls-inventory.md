# Controls Inventory

A flat catalog of every Pharmax control referenced in the
[Trust Service Criteria mapping](./trust-service-criteria-mapping.md),
with status, owner, and review cadence. This is the file the auditor
reads to ask "is the control designed AND in place AND operating?".

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

| Control ID | Description                                                 | Status      | Owner              | Review Cadence        | Notes                                                                                 |
| ---------- | ----------------------------------------------------------- | ----------- | ------------------ | --------------------- | ------------------------------------------------------------------------------------- |
| CC1.1-1    | Policy-codified commitment to integrity and ethical values  | Implemented | Compliance Officer | Annual                | Acknowledged via signed `evidence/training/<year>/`.                                  |
| CC1.2-1    | Independent oversight (CEO approval on every policy)        | Partial     | CEO                | Annual                | Pending formal board governance pattern as company grows.                             |
| CC1.3-1    | Defined organizational structure and security authorities   | Implemented | CEO                | On-change             | Role roster in ISP §4; org chart maintained by People.                                |
| CC1.4-1    | Workforce competence via security + HIPAA training          | Implemented | Workforce Lead     | Annual                | [Security Training Program](../governance/security-training-program.md).              |
| CC1.5-1    | Accountability via sanctions and code-owner gating          | Implemented | CEO                | Per-event             | ISP §9; CODEOWNERS gates security-sensitive paths.                                    |
| CC2.1-1    | Internal information system supports control operation      | Implemented | Security Officer   | Continuous            | Audit chain + command log + outbox.                                                   |
| CC2.2-1    | Internal communication of objectives and controls           | Implemented | Workforce Lead     | Annual                | Onboarding curriculum + Slack `#sec`.                                                 |
| CC2.3-1    | External communication about the system and its controls    | Partial     | CTO                | On-change             | Customer security packet drafted; public security page pending.                       |
| CC3.1-1    | Security objectives specified clearly                       | Implemented | CTO                | Annual                | ISP §3.                                                                               |
| CC3.2-1    | Risks identified, analyzed, prioritized                     | Implemented | Security Officer   | Annual                | [Risk register](../governance/risk-register.md).                                      |
| CC3.3-1    | Fraud risk considered explicitly                            | Implemented | Security Officer   | Annual                | SoD (ADR-0011) + risk register entries.                                               |
| CC3.4-1    | Material-change risk re-assessment                          | Implemented | CTO                | On-change             | ADR template + change-management policy.                                              |
| CC4.1-1    | Ongoing performance monitoring                              | Implemented | Engineering Lead   | Continuous            | OBSERVABILITY.md four-layer model.                                                    |
| CC4.2-1    | Communication and remediation of deficiencies               | Implemented | Security Officer   | Per-event, quarterly  | Postmortems + access reviews.                                                         |
| CC5.1-1    | Control activities selected and developed                   | Implemented | CTO                | Continuous            | ADR set + policy bundle + invariant tests.                                            |
| CC5.2-1    | General technology controls (CI gates)                      | Implemented | Engineering Lead   | Continuous            | Typecheck, lint, schema linter, migration linter, CodeQL, gitleaks, dep review, SBOM. |
| CC5.3-1    | Control activities deployed through policies and procedures | Implemented | Compliance Officer | Annual                | This bundle + onboarding checklist.                                                   |
| CC6.1-1    | Identity established before access (Clerk auth)             | Implemented | Security Officer   | Quarterly             | ADR-0015 + Clerk dashboard.                                                           |
| CC6.1-2    | RBAC + scope enforcement before mutation                    | Implemented | Security Officer   | Quarterly             | `@pharmax/rbac` + command bus step 3.                                                 |
| CC6.1-3    | Tenant isolation enforced at the database (RLS)             | Implemented | Engineering Lead   | Continuous            | ADR-0004; `pharmax_app` role FORCE RLS.                                               |
| CC6.1-4    | MFA floor for high-privilege roles                          | Implemented | Security Officer   | Continuous            | ADR-0025 §3 — `requireMfaForRole`.                                                    |
| CC6.2-1    | Access grant / modify / remove under audit                  | Implemented | Security Officer   | Quarterly, per-event  | Every grant/revoke writes `audit_log`.                                                |
| CC6.2-2    | Quarterly access review with sign-off                       | Implemented | Security Officer   | Quarterly             | `scripts/security/run-access-review.ts`.                                              |
| CC6.3-1    | RBAC + Separation of Duties at the bus                      | Implemented | Security Officer   | Continuous            | ADR-0011.                                                                             |
| CC6.4-1    | Physical access (AWS-managed)                               | Implemented | CTO                | Annual                | AWS SOC 2 report.                                                                     |
| CC6.5-1    | Deprovisioning on termination                               | Implemented | Workforce Lead     | Per-event             | Clerk webhook `user.deleted` (ADR-0025 §1).                                           |
| CC6.6-1    | Transmission encryption (TLS everywhere)                    | Implemented | Engineering Lead   | Continuous            | ACM-managed certs + HSTS.                                                             |
| CC6.6-2    | Webhook authentication + idempotency                        | Implemented | Engineering Lead   | Continuous            | Stripe / EasyPost / Clerk signature verify.                                           |
| CC6.7-1    | Per-field envelope encryption with AAD binding              | Implemented | Security Officer   | Continuous            | ADR-0005; `LocalKmsAdapter` dev-only; AwsKmsAdapter prod (ADR-0023).                  |
| CC6.7-2    | PHI search via blind indexes                                | Implemented | Engineering Lead   | Continuous            | ADR-0010.                                                                             |
| CC6.8-1    | Malicious-software prevention and detection                 | Implemented | Engineering Lead   | Continuous            | CI dependency scan + runtime hardening + workstation antimalware.                     |
| CC7.1-1    | Performance and capacity monitoring                         | Implemented | Engineering Lead   | Continuous            | CloudWatch + Sentry.                                                                  |
| CC7.1-2    | SAST on every PR (CodeQL)                                   | Implemented | Engineering Lead   | Continuous, on-change | ADR-0026 §1.                                                                          |
| CC7.2-1    | Detection of security events                                | Implemented | Security Officer   | Continuous, daily     | Chain verifier + nightly digest + Sentry alerts.                                      |
| CC7.2-2    | Tamper-evident audit log (per-tenant hash chain)            | Implemented | Security Officer   | Continuous            | ADR-0006.                                                                             |
| CC7.2-3    | Daily signed Merkle root over the audit chain               | Partial     | Security Officer   | Daily                 | ADR-0024 scaffold landed; KMS + S3 lanes pending.                                     |
| CC7.3-1    | Defined incident response process                           | Implemented | Security Officer   | Per-event             | [`incident-response-policy.md`](../policies/incident-response-policy.md).             |
| CC7.3-2    | Break-glass with 4-hour cap                                 | Implemented | Security Officer   | Per-event             | `@pharmax/rbac::breakGlass`; ADR-0011.                                                |
| CC7.4-1    | Response to identified security events                      | Implemented | Security Officer   | Per-event             | Postmortem template + remediation tracker.                                            |
| CC7.5-1    | Recovery of systems (restore drill)                         | Partial     | Engineering Lead   | Quarterly             | Restore-drill runbook landed; first drill scheduled.                                  |
| CC8.1-1    | All code changes through PR + review + CI                   | Implemented | Engineering Lead   | Continuous            | Branch protection + CODEOWNERS.                                                       |
| CC8.1-2    | All schema changes through versioned migrations             | Implemented | Engineering Lead   | Per-event             | `prisma/migrations/` + `scripts/check-migration-rls.ts`.                              |
| CC8.1-3    | All workflow changes through versioned policy               | Implemented | Engineering Lead   | Per-event             | ADR-0008 + ADR-0017; `workflow_policy` lifecycle.                                     |
| CC8.1-4    | Architectural decisions recorded (ADRs)                     | Implemented | CTO                | Per-event             | `docs/adr/`.                                                                          |
| CC9.1-1    | Risk mitigated through identified controls                  | Implemented | Security Officer   | Annual                | Risk register cross-references control IDs.                                           |
| CC9.2-1    | Vendor risk assessment and management                       | Implemented | Compliance Officer | Annual, on-change     | [`vendor-management-policy.md`](../policies/vendor-management-policy.md).             |

## Additional Criteria — Availability

| Control ID | Description                                       | Status      | Owner            | Review Cadence | Notes                                                                      |
| ---------- | ------------------------------------------------- | ----------- | ---------------- | -------------- | -------------------------------------------------------------------------- |
| A1.1-1     | Capacity monitored to meet committed availability | Implemented | Engineering Lead | Continuous     | CloudWatch + auto-scaling.                                                 |
| A1.2-1     | Environmental protections (multi-AZ + backups)    | Implemented | Engineering Lead | Continuous     | RDS multi-AZ; 35-day automated backups.                                    |
| A1.2-2     | Backup integrity validated periodically           | Partial     | Engineering Lead | Quarterly      | [`restore-drill.md`](../operations/restore-drill.md); first drill pending. |
| A1.3-1     | DR plan tested annually                           | Partial     | Engineering Lead | Annual         | BCP/DR policy drafted; tabletop pending.                                   |

## Additional Criteria — Processing Integrity

| Control ID | Description                                        | Status      | Owner            | Review Cadence    | Notes                                    |
| ---------- | -------------------------------------------------- | ----------- | ---------------- | ----------------- | ---------------------------------------- |
| PI1.1-1    | Twenty-step command-bus contract on every mutation | Implemented | Engineering Lead | Continuous        | ADR-0007 + 29 contract tests.            |
| PI1.2-1    | Input validated (Zod + workflow engine)            | Implemented | Engineering Lead | Continuous        | ADR-0007 step 1 + ADR-0008.              |
| PI1.3-1    | Processing monitored; exceptions tracked           | Implemented | Engineering Lead | Continuous        | `command_log`, `event_outbox`, SLA.      |
| PI1.4-1    | Output complete, accurate, distributed, protected  | Implemented | Engineering Lead | Continuous        | Outbox + ports/adapters.                 |
| PI1.4-2    | Tamper-evident processing records                  | Implemented | Security Officer | Continuous, daily | ADR-0006 + ADR-0024 (partial).           |
| PI1.5-1    | Stored data integrity-protected                    | Implemented | Engineering Lead | Continuous        | RLS + REVOKE UPDATE/DELETE on audit_log. |

## Additional Criteria — Confidentiality

| Control ID | Description                                               | Status      | Owner              | Review Cadence | Notes                          |
| ---------- | --------------------------------------------------------- | ----------- | ------------------ | -------------- | ------------------------------ |
| C1.1-1     | Information classified per data-classification policy     | Implemented | Compliance Officer | Annual         | Four-tier classification.      |
| C1.1-2     | PHI encrypted at the field level                          | Implemented | Security Officer   | Continuous     | ADR-0005 envelope encryption.  |
| C1.1-3     | PHI search via non-reversible indexes                     | Implemented | Engineering Lead   | Continuous     | ADR-0010 blind indexes.        |
| C1.1-4     | Document storage is classification-aware                  | Implemented | Engineering Lead   | Continuous     | ADR-0021 documents port.       |
| C1.2-1     | Confidential information disposed when no longer required | Implemented | Security Officer   | Per-event      | Crypto-shred via KEK rotation. |

## Additional Criteria — Privacy

| Control ID | Description                                       | Status      | Owner              | Review Cadence        | Notes                                                                |
| ---------- | ------------------------------------------------- | ----------- | ------------------ | --------------------- | -------------------------------------------------------------------- |
| P1.1-1     | Notice provided to data subjects                  | Partial     | Compliance Officer | Annual, on-onboarding | Clinic-mediated; clinic notices on file.                             |
| P2.1-1     | Choice and consent managed per BAA                | Implemented | Compliance Officer | Annual                | BAA-mediated; clinic captures consent.                               |
| P3.1-1     | Collection limited to what is necessary           | Implemented | Engineering Lead   | Per-event, annual     | Schema review + ADR-0010 purpose registry.                           |
| P4.1-1     | Use, retention, disposal of personal information  | Partial     | Security Officer   | Per-event             | Retention windows in classification policy; export workflow pending. |
| P5.1-1     | Data-subject access (clinic-mediated)             | Implemented | Compliance Officer | Per-event             | Per-patient extract on request.                                      |
| P6.1-1     | Disclosure to third parties limited and tracked   | Implemented | Compliance Officer | Quarterly             | Vendor inventory + BAA tracker + carrier credentials.                |
| P7.1-1     | Quality of personal information                   | Implemented | Engineering Lead   | Continuous            | Verification gates (PV1, final) + workflow-policy gating.            |
| P8.1-1     | Monitoring and enforcement of privacy commitments | Implemented | Security Officer   | Continuous            | Cross-references CC2.1-1, CC6.2-2, CC7.3-1.                          |

## Maintenance

This file is refreshed on every control change. The control IDs are
stable across versions; status flags flip as work lands. Deprecations
are recorded but not deleted.

The Security Officer signs off on the inventory at the start of every
audit period and at the end of every quarterly access review. The
sign-off lives at `evidence/controls-inventory/<YYYY-Q#>/signoff.pdf`.
