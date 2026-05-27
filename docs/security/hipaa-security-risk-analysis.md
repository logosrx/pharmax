# HIPAA Security Risk Analysis

| Field          | Value                       |
| -------------- | --------------------------- |
| Owner          | [Owner: CTO]                |
| Approver       | [Approver: CEO]             |
| Effective date | [Effective date: TBD]       |
| Last reviewed  | [Last reviewed: YYYY-MM-DD] |
| Next review    | [Next review: YYYY-MM-DD]   |
| Version        | 0.1                         |
| Distribution   | Internal — All staff        |

## 1. Purpose and scope

This Security Risk Analysis ("SRA") is the structured assessment required by **45 CFR § 164.308(a)(1)(ii)(A)** of the HIPAA Security Rule. The Rule directs a covered entity or business associate to "conduct an accurate and thorough assessment of the potential risks and vulnerabilities to the confidentiality, integrity, and availability of electronic protected health information held by the covered entity or business associate." This SRA is Pharmax's exercise of that obligation.

Pharmax is a Business Associate under HIPAA. It processes electronic Protected Health Information (ePHI) on behalf of pharmacy customers under Business Associate Agreements ([`../governance/baa-tracker.md`](../governance/baa-tracker.md)). The SRA reflects Pharmax's posture as a BA; downstream covered entities perform their own SRAs against their own scopes.

This SRA covers:

- The Pharmax production environment — `apps/web`, `apps/worker`, `apps/print-agent`, the PostgreSQL database, the AWS-managed services we depend on.
- The end-to-end PHI data flow described in [`data-flow.md`](./data-flow.md).
- The administrative, physical, and technical safeguards described in [`control-matrix.md`](./control-matrix.md), specifically the rows that address HIPAA citations.

It does not cover:

- Customer-side infrastructure (the customer's pharmacy facility, the operator's workstation hardware, the local printer/scanner network). Those are covered by the customer's own SRA.
- Pharmax's marketing or corporate IT outside the production scope.

The companion documents are:

- [`encryption-overview.md`](./encryption-overview.md) — how PHI is protected cryptographically.
- [`data-flow.md`](./data-flow.md) — where PHI lives at each stage.
- [`control-matrix.md`](./control-matrix.md) — the full SOC 2 + HIPAA control-to-evidence map.
- [`../governance/risk-register.md`](../governance/risk-register.md) — the standing register of identified risks.

## 2. Methodology

This SRA was prepared by the CTO with input from the engineering leads in the security-relevant domains (crypto, tenancy, audit, RBAC, workflow). The methodology follows the structure recommended by the HHS Office for Civil Rights _Guidance on Risk Analysis_:

1. **Scope the analysis.** §1 above.
2. **Inventory information assets.** §3.
3. **Identify threats.** §4.
4. **Identify vulnerabilities.** §5.
5. **Assess current safeguards.** §6.
6. **Determine likelihood and impact, calculate risk.** §7.
7. **Assess residual risk after current safeguards.** §8.
8. **Identify action items.** §9.
9. **Review and document the analysis.** This document is committed to the repository under change control; the executive summary is filed with the annual risk-assessment evidence.

The SRA is refreshed annually per [`../governance/risk-assessment-procedure.md`](../governance/risk-assessment-procedure.md) and after any material change.

## 3. Asset inventory

### 3.1 PHI-bearing data assets

| Asset                                 | What it holds                                                                                                                               | Where it lives                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `patient` table                       | Patient demographics — first/middle/last name, DOB, sex at birth, SSN-last-4, phone, email, address, MRN. Per-field `*Enc` + `*Bi` columns. | AWS RDS, US region.                                            |
| `prescription` table                  | Prescription details — drug, dose, sig, refills, prescriber reference. PHI by linkage to the patient row.                                   | AWS RDS, US region.                                            |
| `order` table                         | Workflow state, tenant scope, links to patient and prescription. PHI by linkage.                                                            | AWS RDS, US region.                                            |
| `order_event`, `command_log`          | Workflow history. PHI-free `metadata` by schema validation.                                                                                 | AWS RDS, US region.                                            |
| `audit_log`, `hipaa_audit_entry`      | Hash-chained audit trail per ADR 0006. PHI-redacted metadata.                                                                               | AWS RDS, US region.                                            |
| Documents and attachments             | Patient-attached PDFs, scans, labels.                                                                                                       | AWS S3 (SSE-KMS), US region.                                   |
| Shipping labels in transit to carrier | Recipient name and address. PHI by linkage.                                                                                                 | In transit to EasyPost over TLS; ephemeral after transmission. |
| Notification email content            | Recipient address, order reference, minimum-necessary content.                                                                              | In transit to Resend (or equivalent) over TLS.                 |
| Backups and snapshots                 | Full database state, encrypted at rest with AWS KMS.                                                                                        | AWS RDS automated backups + manual snapshots, US region.       |

### 3.2 Key and credential assets

| Asset                                           | Sensitivity                                                                                     | Where it lives                                                                       |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Per-tenant KEKs                                 | Restricted — direct PHI exposure if compromised.                                                | AWS KMS, per-tenant CMK.                                                             |
| Per-record DEKs                                 | Restricted — exists in process memory during encrypt/decrypt; wrapped form persisted in `*Enc`. | Memory only; wrapped persisted in DB.                                                |
| Per-tenant search keys                          | Restricted — exposes deterministic blind-index space if compromised.                            | Derived on demand from KEK; never persisted in plaintext.                            |
| Database credentials                            | Restricted.                                                                                     | AWS Secrets Manager; rotated per [`secrets-management.md`](./secrets-management.md). |
| Vendor API keys (Clerk, Stripe, EasyPost, etc.) | Restricted — vendor-side blast radius if compromised.                                           | AWS Secrets Manager; rotated.                                                        |
| Webhook signing secrets                         | Restricted.                                                                                     | AWS Secrets Manager.                                                                 |
| Operator identity (Clerk)                       | PII (operator-side); auth grant for PHI access.                                                 | Clerk-managed.                                                                       |

### 3.3 System assets

| Asset                                      | Function                                                                                        | Where it lives                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------- |
| `apps/web` operator console                | Operator-facing PHI rendering and command dispatch.                                             | AWS ECS / Fargate, Multi-AZ, US region. |
| `apps/worker` background processor         | Outbox drain, side-effect dispatch, scheduled jobs.                                             | AWS ECS / Fargate, Multi-AZ, US region. |
| `apps/print-agent` workstation companion   | Local Zebra printer driver, scan ingestion. Runs on the operator's workstation in the pharmacy. | Customer workstation; local network.    |
| PostgreSQL primary                         | Source of truth.                                                                                | AWS RDS Multi-AZ, US region.            |
| PostgreSQL read replicas (when introduced) | Reporting and read scale.                                                                       | AWS RDS, US region.                     |

## 4. Threat identification

Threats are the events, actors, or conditions that could cause harm. We use a lightweight STRIDE-aligned frame: Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege.

### 4.1 External threat actors

- **Opportunistic attackers** — automated scanners, credential-stuffing botnets, ransomware groups that target healthcare-adjacent systems.
- **Targeted attackers** — actors with patient PHI as the goal (insurance fraud, identity theft, medical identity theft).
- **Compromised third parties** — a breach at a vendor (Clerk, Stripe, EasyPost, Sentry, observability vendor) that exposes a Pharmax-side credential or downstream system.

### 4.2 Internal threat actors

- **Malicious insider** — an employee or contractor with legitimate access using that access for unauthorized purposes (R-007 in the [risk register](../governance/risk-register.md)).
- **Negligent insider** — an employee or contractor making a mistake that exposes PHI (logging PHI, committing a secret, losing a laptop without encryption).
- **Compromised insider** — an employee whose account is taken over via phishing or device compromise (R-004 in the [risk register](../governance/risk-register.md)).

### 4.3 Environmental and operational threats

- **Vendor outages** — AWS region failure, Clerk outage, Stripe outage (R-008, R-015 in the [risk register](../governance/risk-register.md)).
- **Hardware failure** — individual AZ-level events, absorbed by Multi-AZ.
- **Operational error** — a misconfigured deployment, a destructive migration, a wrong-button-pressed event.
- **Catastrophic events** — ransomware against the production environment (low likelihood per the AWS-managed posture), large-scale natural events affecting an AWS region.

### 4.4 Specific threats Pharmax models

- **Cross-tenant data access** via misconfigured RLS, missing tenancy context, or a bug in the `@pharmax/tenancy` extension. The mitigation is the two-layer wall in ADR 0004; the residual risk is R-003.
- **Ciphertext displacement** — an attacker with DB read/write moving a PHI envelope across rows. The mitigation is AAD binding in ADR 0005; the attack surfaces as `AuthorizationError(AAD_MISMATCH)`.
- **Audit-chain tampering** — a privileged actor rewriting `audit_log` to occlude an action. The mitigation is hash-chaining in ADR 0006; the residual risk is R-009.
- **Separation-of-duties bypass** — the same human performing both PV1 approval and final verification on the same order. The mitigation is enforcement at the command bus in ADR 0011.
- **Workflow bypass** — a code path that mutates `order.current_status` outside the command bus, skipping audit / outbox writes. The mitigation is ESLint boundary rules, code review, the workflow-safety rule in `.cursor/rules/01-workflow-safety.mdc`. Residual risk R-017.
- **Webhook replay** — an attacker replaying an old vendor webhook to trigger duplicate side-effects. The mitigation is signature verification + idempotency at the inbound-event row (R-005).
- **Logged PHI leakage** — a logger context inadvertently including PHI in a field name not on the redactor allowlist. The mitigation is the Pino redactor + Sentry `beforeSend` allowlist + browser session replay disabled. Residual risk R-018.
- **Right-to-be-forgotten failure** — a tenant-offboarding or individual deletion request that fails to remove all PHI. The mitigation is the crypto-shred design in ADR 0005 (KEK deletion + `*Enc`/`*Bi` nulling). Tested in `packages/crypto/`.

## 5. Vulnerability identification

A vulnerability is a weakness that a threat could exploit. The vulnerabilities Pharmax monitors:

### 5.1 Technical vulnerabilities

- **Dependency CVEs.** The npm dependency tree is large and evolves continuously (R-010). Mitigation: CI dependency scan, monitoring, the dependency-pin policy.
- **Code-level bugs.** Any code path can carry a bug that exposes PHI or weakens an invariant. Mitigation: tests pin the invariants (the anti-leak property test, the SoD tests, the audit-chain verifier tests, the workflow-safety tests); code review via CODEOWNERS for security-critical paths.
- **Configuration drift.** Infrastructure, RDS, KMS, ECS, and vendor portal configurations can drift from policy. Mitigation: Terraform under change control; quarterly access reviews; monitoring.
- **Default-permissive client tooling.** AI assistants and developer tooling default to broad data access. Mitigation: [Acceptable Use Policy](../policies/acceptable-use-policy.md) §7.

### 5.2 Process vulnerabilities

- **MDM-optional posture.** Workstation hygiene rests on self-report (R-014). Mitigation plan: MDM mandatory above 15 engineers.
- **Single-region posture.** Region failure exceeds the 4-hour RTO (R-015). Mitigation plan: ADR 0022 (multi-region tenancy).
- **Procurement-side drift.** A new vendor onboarded without the BAA-before-PHI discipline. Mitigation: [Vendor Management Policy](../policies/vendor-management-policy.md) §3.3; quarterly BAA-vs-integration cross-check (R-019).
- **Training-cycle gaps.** A workforce member who has not completed the annual security/HIPAA training (R-018 indirectly). Mitigation: [Security and HIPAA Training Program](../governance/security-training-program.md) §7 escalation.

### 5.3 Physical vulnerabilities

- **Workstation loss or theft.** R-013. Mitigation: encryption + lock screen + no-PHI-on-disk.
- **Office surroundings.** Public-space screen visibility, shoulder-surfing. Mitigation: [Acceptable Use Policy](../policies/acceptable-use-policy.md) §4.2.

## 6. Current safeguards

Per HIPAA, safeguards split into **administrative**, **physical**, and **technical**. The full matrix lives in [`control-matrix.md`](./control-matrix.md); this section summarizes the most material safeguards by category and pins where they are documented.

### 6.1 Administrative safeguards (45 CFR § 164.308)

- **Security management process** — this SRA + the [risk register](../governance/risk-register.md) + the annual [`risk-assessment-procedure.md`](../governance/risk-assessment-procedure.md). [`§ 164.308(a)(1)`].
- **Assigned security responsibility** — CTO as HIPAA Security Official per [ISP §4.2](../policies/information-security-policy.md). [`§ 164.308(a)(2)`].
- **Workforce security and information access management** — [Access Control Policy](../policies/access-control-policy.md); provisioning / deprovisioning in §7. [`§ 164.308(a)(3)`, `§ 164.308(a)(4)`].
- **Security awareness and training** — [Security and HIPAA Training Program](../governance/security-training-program.md). [`§ 164.308(a)(5)`].
- **Security incident procedures** — [Incident Response Policy](../policies/incident-response-policy.md) + `../INCIDENT_RESPONSE.md`. [`§ 164.308(a)(6)`].
- **Contingency plan** — [BCP/DR Policy](../policies/business-continuity-and-disaster-recovery.md). [`§ 164.308(a)(7)`].
- **Evaluation** — annual policy review; SOC 2 audit cycle. [`§ 164.308(a)(8)`].
- **Business associate contracts** — [Vendor Management Policy](../policies/vendor-management-policy.md) + [BAA tracker](../governance/baa-tracker.md). [`§ 164.308(b)(1)`].

### 6.2 Physical safeguards (45 CFR § 164.310)

- **Facility access controls** — AWS provides physical safeguards for the production environment; AWS SOC 2 is the evidence. Pharmax has no Pharmax-controlled data center. [`§ 164.310(a)`].
- **Workstation use and security** — [Acceptable Use Policy](../policies/acceptable-use-policy.md) §4 (encryption, lock screen, OS currency, no PHI on disk). [`§ 164.310(b)`, `§ 164.310(c)`].
- **Device and media controls** — crypto-shred for PHI disposal (ADR 0005); no removable media for PHI ([Data Classification Policy](../policies/data-classification.md) §3.4.5). [`§ 164.310(d)`].

### 6.3 Technical safeguards (45 CFR § 164.312)

- **Access control** — Clerk authentication + `@pharmax/rbac` + RLS (ADR 0004) + envelope encryption (ADR 0005). Unique user identification; emergency-access procedure (`pharmax_system` + break-glass); automatic logoff (Clerk session timeout); encryption/decryption (envelope per field). [`§ 164.312(a)`].
- **Audit controls** — hash-chained `audit_log` (ADR 0006); `command_log`; `order_event`; `event_outbox`. [`§ 164.312(b)`].
- **Integrity** — audit chain detects tampering; workflow-safety rules block direct mutation; CAS on `Order.version` and `Invoice.version`. [`§ 164.312(c)`].
- **Person or entity authentication** — Clerk-managed, MFA enforced. [`§ 164.312(d)`].
- **Transmission security** — TLS 1.2+ everywhere; AAD binding for transit-as-storage edge cases (an envelope arriving at a different row would fail AAD). [`§ 164.312(e)`].

### 6.4 Organizational requirements (45 CFR § 164.314)

- **Business associate contracts** — [BAA tracker](../governance/baa-tracker.md). [`§ 164.314(a)`].

## 7. Risk determination

Risk = likelihood × impact, weighted against the current safeguards. The [risk register](../governance/risk-register.md) carries the per-risk detail; this section summarizes the categorical exposure.

| Risk category                                                                                                                             | Likelihood (current) | Impact (current) | Composite | Reference                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------- | --------- | ----------------------------------------------- |
| **Confidentiality** — unauthorized disclosure of PHI through application exploit, vendor compromise, workstation loss, or insider action. | Moderate             | Severe           | High      | R-001, R-002, R-004, R-006, R-007, R-013, R-018 |
| **Integrity** — unauthorized alteration of PHI or of the audit record.                                                                    | Low                  | Significant      | Moderate  | R-003, R-009, R-017                             |
| **Availability** — disruption to the order workflow, the audit chain, or the production environment.                                      | Moderate             | Significant      | High      | R-008, R-012, R-015                             |
| **Workforce conduct** — negligent or malicious insider action; non-completion of training.                                                | Moderate             | Moderate         | Moderate  | R-007, R-011, R-014                             |
| **Third-party** — vendor outage, vendor breach, sub-processor introduction without BAA.                                                   | Moderate             | Significant      | High      | R-008, R-010, R-019                             |

The high-composite categories drive the active mitigation plans documented in the [risk register](../governance/risk-register.md). No category is "extreme" (likelihood and impact both at the top of the scale) under the current safeguards.

## 8. Residual risk

After the current safeguards in §6, the residual risk per category:

- **Confidentiality.** Reduced to moderate by the combination of envelope encryption (ADR 0005), per-tenant KEK isolation, forced RLS (ADR 0004), and the PHI-free-logging discipline. The residual concern is application-layer exploits that bypass the application's tenancy or read-decryption discipline; the mitigation plan is the pre-launch external pen test (R-001) and the standing CI controls.
- **Integrity.** Reduced to low by the hash-chained audit log (ADR 0006), the workflow-safety rules, and the command-bus contract (ADR 0007). The residual concern is workflow-bypass code paths introduced in future changes (R-017); the mitigation is the planned custom ESLint rule and continued CODEOWNERS routing.
- **Availability.** Reduced to moderate by Multi-AZ RDS, the documented restore-from-backup procedure, and the BCP/DR drill cadence. The residual concern is the single-region posture (R-015); the mitigation plan is ADR 0022.
- **Workforce.** Reduced to moderate by training, MFA, audit-chain visibility, and sanctions. The residual concern is the MDM-optional posture (R-014); the mitigation plan is MDM mandatory above 15 engineers.
- **Third-party.** Reduced to moderate by the vendor-management workflow, the BAA-before-PHI discipline, and the quarterly cross-check. The residual concern is the dependency CVE surface (R-010) and the sub-processor flow-down (R-019); both have mitigation plans.

The residual posture is consistent with the SOC 2 Type 1 readiness target and a HIPAA-ready procurement conversation. The composite-16-plus category is "Confidentiality" against the worst-case external attack; the mitigation plan is the pen test and the standing safeguards, and the residual rating is supported by the engineering invariants that bound the worst-case blast radius.

## 9. Action items

The current standing action items, drawn from the risk register and this SRA:

| Item                                                                                                                                                                            | Owner | Target                    | Risk reference |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------- | -------------- |
| Land `AwsKmsAdapter` in production. Until it lands, the production-fails-closed posture is the safeguard; landing it formalizes the operational rotation procedure.             | CTO   | Phase 4 implementation    | R-002, R-005   |
| Schedule the `audit_chain_check` cron documented in `../OBSERVABILITY.md` and `../RUNBOOK.md`.                                                                                  | CTO   | Engineering tracker       | R-009, R-017   |
| Roll out the custom ESLint rule that flags direct `current_status` mutations against workflow tables.                                                                           | CTO   | Engineering tracker       | R-017          |
| Disable `/sign-up` self-enrollment in production (Clerk invitation-only).                                                                                                       | CTO   | Pre-first-customer-launch | R-020          |
| Select observability vendor (Datadog or Honeycomb) and execute BAA.                                                                                                             | CTO   | Engineering tracker       | R-019          |
| Conduct external penetration test before first customer above 10k patients lands.                                                                                               | CTO   | Pre-launch milestone      | R-001          |
| Migrate `BillingManager` and `OrgAdmin` to phishing-resistant MFA (passkey or hardware key).                                                                                    | CTO   | Two-quarter plan          | R-004          |
| MDM enrollment becomes mandatory once headcount passes 15 or earlier if a customer contract requires it.                                                                        | CTO   | Headcount trigger         | R-014          |
| ADR 0022 multi-region tenancy implementation.                                                                                                                                   | CTO   | Roadmap                   | R-015          |
| Quarterly drill program per [BCP/DR Policy](../policies/business-continuity-and-disaster-recovery.md) §8.                                                                       | CTO   | Per-quarter               | R-008, R-015   |
| Continue the quarterly access-review cadence per [`access-review-procedure.md`](../governance/access-review-procedure.md). Confirm BAA-vs-integration cross-check each quarter. | CTO   | Per-quarter               | R-019          |

Action items are tracked in the engineering tracker. Closure of an item updates the corresponding risk-register entry's residual rating where appropriate.

## 10. Conclusion

Pharmax's PHI posture is built around five load-bearing primitives — envelope encryption (ADR 0005), per-tenant KEK isolation, forced Row-Level Security (ADR 0004), hash-chained audit (ADR 0006), and the command-bus contract (ADR 0007) — wrapped in a control environment that includes least-privilege RBAC, separation of duties at the bus (ADR 0011), and Clerk-backed MFA-enforced authentication (ADR 0015). The combination is what bounds the worst-case blast radius of any single failure: a leaked envelope cannot decrypt without KMS; a leaked credential cannot read PHI without RLS-scoped access; an attacker who reaches the database still cannot forge history without breaking the chain.

This SRA is the management-system instance of those engineering invariants. It is refreshed annually. Action items are tracked to closure. The residual risk is consistent with a HIPAA-ready procurement conversation and a SOC 2 Type 1 readiness target.

The SRA is the document an external HIPAA-readiness assessor reads first. The companion control matrix and the encryption overview are the supporting evidence. Together they answer the question "show me you have analyzed your risks and built controls against them" with both the rationale and the citations.

## Revision history

| Version | Date       | Author | Change           |
| ------- | ---------- | ------ | ---------------- |
| 0.1     | YYYY-MM-DD | CTO    | Initial drafting |
