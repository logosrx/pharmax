# Data Classification Policy — STUB

> **THIS IS A STUB.** Authoritative version:
> [`../../policies/data-classification.md`](../../policies/data-classification.md).
> Every `<TBD>` marker must be resolved by legal counsel and/or the
> SOC 2 auditor.

| Field          | Value                |
| -------------- | -------------------- |
| Owner          | Compliance Officer   |
| Approver       | CEO                  |
| Effective date | `<TBD>`              |
| Last reviewed  | `<TBD>`              |
| Next review    | `<TBD>`              |
| Version        | 0.1-stub             |
| Distribution   | Internal — All staff |

## 1. Purpose

Define the data classifications Pharmax operates against, the
handling rules per classification, the retention windows, and the
disposal procedures.

## 2. Scope

All Pharmax-handled data, including PHI processed on behalf of
clinic tenants under BAA.

## 3. Policy statements

### 3.1 Classification tiers

| Tier             | Examples                                                                                                 | Handling minimum                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Public           | Marketing pages, public terms of service.                                                                | No restriction.                                                                                                            |
| Internal         | Engineering documentation, non-customer roadmaps, internal Slack content.                                | Workforce-only access; do not distribute externally without approval.                                                      |
| Confidential     | Customer (clinic) business identity, invoice line items, vendor contracts.                               | RLS-enforced where applicable; least-privilege access; logged retrieval.                                                   |
| Restricted (PHI) | Patient names, DOB, sex at birth, SSN-last-4, phone, email, address, MRN, prescription sig, lab results. | Envelope encryption per field (ADR-0005); blind indexes for search (ADR-0010); BAA in place with every external recipient. |

`<TBD by legal counsel: confirm the tier names and the minimum handling
rules align with HIPAA, applicable state law, and customer
contractual commitments.>`

### 3.2 PHI handling

- PHI is encrypted at the field level with AAD binding (ADR-0005).
- PHI search uses blind indexes; no broad decrypted search.
- PHI in transit requires TLS 1.2+.
- PHI in logs is prohibited; the logger redaction allowlist is the
  enforcement mechanism.
- PHI in test fixtures, examples, screenshots, or prompts is
  prohibited; synthetic data only.

### 3.3 Document storage

- Documents are stored through the `@pharmax/documents` port
  (ADR-0021), which requires a classification input.
- PHI documents land in a HIPAA-eligible bucket with short
  signed-URL TTL.
- Non-PHI documents land in the appropriate bucket for their tier.

### 3.4 Retention

`<TBD by legal counsel: explicit retention windows per tier,
cross-referenced against HIPAA §164.530(j) (6 years for required
documentation), state requirements, and customer contractual
commitments. The current engineering posture is that audit-log
retention is perpetual, application-log retention is 90 days
(redacted), and PHI data retention is bounded by the clinic
contract and the right-to-be-forgotten process.>`

### 3.5 Disposal

- PHI disposal uses crypto-shred (KEK rotation + key deletion per
  tenant), implemented in `@pharmax/crypto` (ADR-0005).
- Patient-record shred is column-nullable for the PHI columns added
  in migration `20260603000000_phase2_patient_phi_columns_nullable_for_shred`.
- A shred request lands at `evidence/shred-requests/<year>/<id>/`.

### 3.6 Minimum necessary

Per HIPAA §164.502(b), PHI collection is limited to what is
necessary for the workflow. Schema additions of PHI columns require
Security Officer + Compliance Officer co-review.

## 4. Roles and responsibilities

| Role               | Responsibility                                                              |
| ------------------ | --------------------------------------------------------------------------- |
| Compliance Officer | Owns the classification policy; runs the annual data-classification review. |
| Security Officer   | Owns the PHI handling controls; signs the annual review.                    |
| Engineering        | Implements the controls; participates in the schema review.                 |
| All workforce      | Adheres to handling rules; reports any suspected mishandling.               |

## 5. Enforcement and sanctions

`<TBD by legal counsel: sanctions for PHI mishandling, including the
escalation to immediate termination and potential civil/criminal
referral for willful violation.>`

## 6. Review cadence

Annual, per the [`data-classification-review`](../playbooks/data-classification-review.md)
playbook, plus on any new data-bearing column, new document type, or
new vendor PHI scope.

## 7. References

- ADR-0005 (envelope encryption).
- ADR-0010 (blind indexes).
- ADR-0021 (document storage port).
- `packages/database/src/phi/blind-index-purposes.ts`.
- [`../../security/encryption-overview.md`](../../security/encryption-overview.md).

## 8. Revision history

| Version  | Date    | Author      | Change                  |
| -------- | ------- | ----------- | ----------------------- |
| 0.1-stub | `<TBD>` | Engineering | Initial framework stub. |
