# Information Security Policy

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

This Information Security Policy ("ISP") is the top of the Pharmax policy stack. It states why we have a security program, what the program protects, who is accountable, and how the sub-policies underneath fit together.

Pharmax is a HIPAA-aware modular monolith that handles prescription workflow, protected health information ("PHI"), billing, shipping, and operator-console flows. The product's value proposition rests on three promises:

1. **We do not lose or expose PHI.** Patient identifying data is encrypted at rest with per-tenant key isolation (ADR 0005), is queryable only via blind-index search (ADR 0010), and is never logged.
2. **We do not let one tenant see another tenant's data.** Postgres Row-Level Security is forced on every tenant-scoped table (ADR 0004) and our application middleware fails closed.
3. **We can prove what happened.** Every workflow-altering action goes through a command bus that writes to a hash-chained audit log (ADR 0006), an immutable command log, an order-event stream, and an outbox for downstream effects.

This policy explains the management system around those engineering promises. It is the document an auditor reads first.

## 2. Scope

This ISP applies to:

- All Pharmax employees, contractors, and interns.
- All Pharmax-owned and Pharmax-managed systems (production environments, staging environments, internal tooling).
- All third-party systems that store, process, or transmit Pharmax data under contract (covered in detail by the [Vendor Management Policy](./vendor-management-policy.md)).
- All devices used to access Pharmax data, including personal laptops insofar as they are governed by the [Acceptable Use Policy](./acceptable-use-policy.md).

It does not apply to:

- The systems of Pharmax customers (pharmacies, clinics, or prescribers) operating their own infrastructure. The Pharmax security program ends at our trust boundary; customer-side security is covered by their own programs and our BAAs where applicable.
- Open-source dependencies maintained by third parties — those are covered as a vendor-risk category under [Vendor Management](./vendor-management-policy.md) and the upcoming dependency-CVE control.

## 3. Security objectives

The Pharmax security program exists to achieve, in priority order:

1. **Patient safety.** No engineering decision, deploy, or operational action should silently degrade the workflow safety rules codified in `.cursor/rules/01-workflow-safety.mdc` — no fill before PV1, no final verification before fill, no ship before final verification, no expired or held lot assignment, no silent reprint, no PHI in logs.
2. **Confidentiality of PHI and other Restricted data.** PHI access is least-privilege, encrypted at rest and in transit, auditable, and revocable. The [Data Classification Policy](./data-classification.md) is the operational expression of this objective.
3. **Tenant isolation.** Cross-tenant data leakage is a SEV0 incident under `../INCIDENT_RESPONSE.md`. The two-layer enforcement (RLS at the database, AsyncLocalStorage at the application) is non-negotiable.
4. **Integrity of the operational record.** Audit logs, command logs, order events, and the outbox are append-only and tamper-evident. A break in any of these is treated as a security event.
5. **Availability of critical workflow.** The order workflow (typing → PV1 → fill → final verification → ship) is the product. Recovery objectives are stated in the [Business Continuity and Disaster Recovery Policy](./business-continuity-and-disaster-recovery.md).

Where these objectives conflict, **patient safety wins**. A degraded operational mode that keeps the workflow safe is preferred over an available-but-unsafe mode.

## 4. Roles and responsibilities

Pharmax is intentionally a small team. Where this policy names a role, it refers to the human currently holding that role; where the team is too small for full role separation, the policy still names the role so the structure is durable as the team grows.

### 4.1 CEO — accountable owner

The Chief Executive Officer is the final approver of every policy in this bundle, the executive sponsor of the SOC 2 program, and the named accountable individual for HIPAA-related disclosures. The CEO does not author the policies, but signs them.

### 4.2 CTO — security lead

The Chief Technology Officer is the operational owner of the security program. The CTO:

- Authors and maintains every policy in this bundle.
- Chairs the annual risk-assessment exercise (see [`../governance/risk-assessment-procedure.md`](../governance/risk-assessment-procedure.md)).
- Reviews and approves vendor engagements that touch Restricted data.
- Owns the relationship with the SOC 2 auditor and the HIPAA assessor.
- Signs off on quarterly access reviews (see [`../governance/access-review-procedure.md`](../governance/access-review-procedure.md)).
- Acts as Incident Commander, or appoints one, during a SEV0 or SEV1 incident.
- Is the named **HIPAA Security Official** under 45 CFR § 164.308(a)(2).

As the team grows past ~15 engineers, the security-lead role is expected to spin out into a dedicated Head of Security; until then, the CTO holds both hats.

### 4.3 Engineering — implementation and control operation

Every engineer is responsible for:

- Following the workflow-safety rules and the architectural principles documented in `../ARCHITECTURE_PRINCIPLES.md`.
- Routing critical mutations through the command bus and never bypassing it.
- Adding RLS policies to every new tenant-scoped table (enforced by the migration linter — see ADR 0004).
- Adding audit / command-log / outbox writes inside the same transaction as the domain mutation.
- Not logging PHI under any circumstances, ever.
- Reporting suspected security events promptly per [Incident Response Policy](./incident-response-policy.md).
- Completing security and HIPAA training on the cadence in [`../governance/security-training-program.md`](../governance/security-training-program.md).

The engineering safeguards above are not aspirational — they are enforced by ESLint boundary rules, the schema linter, the migration linter, and the PR template, plus the test suites that pin specific failure modes (the anti-leak property test in `@pharmax/tenancy`, the SoD tests in `@pharmax/verification`, the audit-chain verifier tests in `@pharmax/audit`).

### 4.4 Operations — supporting infrastructure

The Operations function (today a shared engineering responsibility; expected to formalize as the team grows) owns:

- Production deploys, the deploy pipeline, and rollback procedures (see [Change Management Policy](./change-management-policy.md)).
- On-call rotation and incident response coordination (see [Incident Response Policy](./incident-response-policy.md)).
- Vendor portal management (Stripe dashboard, EasyPost portal, AWS console, Clerk dashboard, etc.) — quarterly access reviews per [`../governance/access-review-procedure.md`](../governance/access-review-procedure.md).
- Routine maintenance documented in `../RUNBOOK.md`.

### 4.5 Every employee — basic hygiene

Every person with credentials that touch Pharmax data is bound by:

- The [Acceptable Use Policy](./acceptable-use-policy.md) (device, credentials, network, AI-tool hygiene).
- The training requirements in [`../governance/security-training-program.md`](../governance/security-training-program.md).
- The reporting obligations in the [Incident Response Policy](./incident-response-policy.md).

## 5. Sub-policy index

The ISP itself is short on purpose. The detailed operational rules live in sub-policies:

| Sub-policy                                                                                  | What it covers                                                                              |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [Acceptable Use](./acceptable-use-policy.md)                                                | Device, credentials, network, prohibited uses, AI tool usage                                |
| [Data Classification](./data-classification.md)                                             | Public / Internal / Confidential / Restricted-PHI tiers, handling per tier                  |
| [Access Control](./access-control-policy.md)                                                | Identity, MFA, RBAC, tenancy, break-glass, quarterly access reviews                         |
| [Vendor Management](./vendor-management-policy.md)                                          | Vendor onboarding, security review, BAA, annual review, decommissioning                     |
| [Incident Response](./incident-response-policy.md)                                          | Policy frame on top of `../INCIDENT_RESPONSE.md`: classification, comms, regulatory, drills |
| [Business Continuity and Disaster Recovery](./business-continuity-and-disaster-recovery.md) | RTO, RPO, critical functions, failover, drill cadence                                       |
| [Change Management](./change-management-policy.md)                                          | Branch, PR, CI, reviews, deploy, rollback, emergency-change procedure                       |

Two adjacent directories hold governance artifacts and security analyses that this ISP references:

- [`../governance/`](../governance/) — risk register, risk-assessment procedure, vendor inventory, BAA tracker, access-review procedure, security training program.
- [`../security/`](../security/) — HIPAA Security Risk Analysis, SOC 2 + HIPAA control matrix, data-flow diagrams, secrets management, encryption overview.

## 6. SOC 2 Trust Services Criteria alignment

This ISP is the management-system anchor for the following SOC 2 Trust Services Criteria. Each line below is satisfied — or planned to be satisfied — by an explicit control elsewhere in this bundle and tracked in [`../security/control-matrix.md`](../security/control-matrix.md).

- **CC1 — Control Environment.** Roles (§4), tone-at-the-top (§3), training ([`../governance/security-training-program.md`](../governance/security-training-program.md)).
- **CC2 — Communication and Information.** Policy distribution (this document's header), incident communications ([Incident Response](./incident-response-policy.md)), training records.
- **CC3 — Risk Assessment.** Annual procedure ([`../governance/risk-assessment-procedure.md`](../governance/risk-assessment-procedure.md)) and the standing [risk register](../governance/risk-register.md).
- **CC4 — Monitoring Activities.** Observability stack (`../OBSERVABILITY.md`), audit chain (`../adr/0006-hash-chained-audit-log.md`), quarterly access reviews.
- **CC5 — Control Activities.** Every sub-policy in this bundle.
- **CC6 — Logical and Physical Access.** [Access Control Policy](./access-control-policy.md); office posture covered under [Acceptable Use Policy](./acceptable-use-policy.md).
- **CC7 — System Operations.** [Change Management Policy](./change-management-policy.md); [Incident Response Policy](./incident-response-policy.md); runbook (`../RUNBOOK.md`).
- **CC8 — Change Management.** [Change Management Policy](./change-management-policy.md) and ADR 0004 / 0006 / 0007 / 0011 (the architectural invariants the change-management gates protect).
- **CC9 — Risk Mitigation.** Vendor management, BCP/DR, incident response.
- **A1 — Availability.** [Business Continuity and Disaster Recovery Policy](./business-continuity-and-disaster-recovery.md).
- **C1 — Confidentiality.** [Data Classification Policy](./data-classification.md); [`../security/encryption-overview.md`](../security/encryption-overview.md).
- **P1 — Privacy.** Privacy notice and patient-rights handling are covered alongside our HIPAA posture in [`../security/hipaa-security-risk-analysis.md`](../security/hipaa-security-risk-analysis.md); the formal SOC 2 P-series controls are scoped against the next audit period.
- **PI1 — Processing Integrity.** Workflow safety rules (`.cursor/rules/01-workflow-safety.mdc`), the command bus contract (ADR 0007), hash-chained audit (ADR 0006), separation of duties (ADR 0011).

## 7. HIPAA Security Rule alignment

Pharmax handles PHI on behalf of pharmacy customers and is a Business Associate under HIPAA. The HIPAA Security Rule — 45 CFR Part 164, Subpart C — requires administrative, physical, and technical safeguards. The mapping at a high level:

- **Administrative safeguards (45 CFR § 164.308):** the security management process (§3 of this policy and [`../governance/risk-assessment-procedure.md`](../governance/risk-assessment-procedure.md)), assigned security responsibility (§4 — CTO as HIPAA Security Official), workforce security and training ([`../governance/security-training-program.md`](../governance/security-training-program.md)), information access management ([Access Control](./access-control-policy.md)), incident procedures ([Incident Response](./incident-response-policy.md)), contingency plan ([BCP/DR](./business-continuity-and-disaster-recovery.md)), evaluation (annual review of this bundle), and BAA execution ([`../governance/baa-tracker.md`](../governance/baa-tracker.md)).
- **Physical safeguards (45 CFR § 164.310):** Pharmax has no physical data center — production runs on AWS, which provides the physical safeguards under their attestation. Office posture is governed by the [Acceptable Use Policy](./acceptable-use-policy.md) (device encryption, lock screen, screen privacy, no PHI on personal devices).
- **Technical safeguards (45 CFR § 164.312):** access control (RBAC + RLS + Clerk MFA), audit controls (hash-chained `audit_log` + `command_log` + `order_event` + `event_outbox`), integrity (the audit chain and the workflow-state guards), person-or-entity authentication (Clerk), and transmission security (TLS 1.2+ everywhere). Detail in [`../security/encryption-overview.md`](../security/encryption-overview.md) and [`../security/control-matrix.md`](../security/control-matrix.md).

The detailed control-to-citation mapping is the [`../security/hipaa-security-risk-analysis.md`](../security/hipaa-security-risk-analysis.md) and [`../security/control-matrix.md`](../security/control-matrix.md). This ISP only references the structure.

## 8. Exception process

Exceptions to this policy or any sub-policy are rare and always documented. The process is:

1. The requester opens a ticket against the affected policy file. The ticket states the exception, the duration, the compensating controls, and the business justification.
2. The CTO reviews. If the exception materially changes the security posture (anything touching PHI handling, tenancy isolation, audit integrity, or access control), the CEO approves.
3. Approved exceptions are written to `evidence/exceptions/<YYYY-Q#>/<ticket-id>.md` with the policy file and section referenced.
4. Exceptions expire by default at 90 days. Extension requires the same review.
5. Active exceptions are listed in the quarterly access-review evidence pack so leadership sees the cumulative posture, not just point-in-time decisions.

Undocumented deviations from policy are control failures. They are reported via the [Incident Response Policy](./incident-response-policy.md) and recorded in the [risk register](../governance/risk-register.md) with a residual rating until remediated.

## 9. Sanctions

Failure to follow this policy or a sub-policy is a serious matter. The proportional response depends on intent and impact:

- **Honest mistake, low impact, self-reported.** Coaching, additional training, no formal sanction. We optimize for self-reporting; the worst outcome is one where someone hides a mistake because they feared consequences.
- **Negligence, material impact (e.g. PHI exposure, cross-tenant leak).** Written warning, mandatory retraining, removal of standing privileged access, performance review consequences.
- **Willful violation (e.g. logging PHI deliberately, sharing credentials, exfiltrating data).** Up to and including immediate termination and referral to law enforcement, plus all required HIPAA breach notifications under 45 CFR § 164.404.

The sanctions standard is enforced uniformly. The CTO documents enforcement actions in `evidence/sanctions/`, retained for the period required under HIPAA workforce-security record-keeping (six years per 45 CFR § 164.530(j)).

## 10. Review and approval

This policy is reviewed:

- **At least annually**, against the calendar in the header.
- **On material change**, which includes:
  - A new vendor that receives PHI.
  - A change in the architectural invariants in `../ARCHITECTURE_PRINCIPLES.md` §C.
  - A change in regulatory scope (e.g. expansion into a state with stricter requirements, or a new federal rule that touches our footprint).
  - A SEV0 or SEV1 incident that surfaces a gap in this policy.
- **On the recommendation of the SOC 2 auditor or HIPAA assessor** after a periodic review.

Approval is by the CEO. The signed PDF is filed under `evidence/policies/<YYYY>/information-security-policy-v<version>.pdf`.

## Revision history

| Version | Date       | Author | Change           |
| ------- | ---------- | ------ | ---------------- |
| 0.1     | YYYY-MM-DD | CTO    | Initial drafting |
