# Backup and Recovery Policy — STUB

> **THIS IS A STUB.** Authoritative version: the recovery section of
> [`../../policies/business-continuity-and-disaster-recovery.md`](../../policies/business-continuity-and-disaster-recovery.md).
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

Define how Pharmax backs up production data, how those backups are
validated, and how restoration is performed and tested.

## 2. Scope

- Production PostgreSQL (RDS).
- S3-stored documents (envelope-encrypted PHI, labels, package
  photos, invoice PDFs).
- KMS key material (managed by AWS KMS; backup is implicit).
- Configuration state (Terraform state, env-var snapshots).

## 3. Policy statements

### 3.1 Database backups

- RDS automated backups enabled with `<TBD by SOC 2 auditor: confirm
retention window — current engineering posture is 35 days>`.
- Multi-AZ enabled for hot failover.
- Point-in-time recovery within the retention window.
- Backup encryption uses AWS-managed KMS keys.

### 3.2 S3 backups

- Versioning enabled on every Pharmax-owned bucket.
- Lifecycle policies define retention per data class (cross-reference
  [`data-classification.md`](./data-classification.md)).
- S3 Object Lock COMPLIANCE mode applies to the audit Merkle-root
  bucket (ADR-0024).

### 3.3 KMS key management

- KMS key material is managed by AWS; per-tenant KEKs are
  AWS-KMS-managed and never exported (ADR-0023).
- Key rotation per ADR-0005 (`rotateKek`) — in-place; audited.

### 3.4 Validation

- Restore-drill cadence: quarterly per
  [`../../operations/restore-drill.md`](../../operations/restore-drill.md).
- Post-restore audit-chain verifier (`scripts/security/verify-audit-chain-all-orgs.ts`)
  must exit 0 for the drill to count.
- Drill log lands at `evidence/dr-drills/<period>/<date>.txt`.

### 3.5 Recovery objectives

| Metric                                        | Target                                                                                              | Notes |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----- |
| RPO (Recovery Point Objective)                | `<TBD by SOC 2 auditor: confirm — current engineering posture is ≤ 5 minutes via RDS PITR>`         |       |
| RTO (Recovery Time Objective)                 | `<TBD by SOC 2 auditor: confirm — current engineering posture is ≤ 4 hours for a regional failure>` |       |
| MTPD (Maximum Tolerable Period of Disruption) | `<TBD by legal counsel: confirm against customer SLAs>`                                             |       |

## 4. Roles and responsibilities

| Role             | Responsibility                                             |
| ---------------- | ---------------------------------------------------------- |
| Engineering Lead | Owns the backup posture; runs the quarterly restore drill. |
| CTO              | Approves the recovery objectives.                          |
| Security Officer | Confirms the post-restore audit-chain integrity.           |

## 5. Enforcement and sanctions

`<TBD by legal counsel: sanctions for missed restore drills,
unauthorized restoration to production from a non-current backup, or
deletion of a backup before its retention window.>`

## 6. Review cadence

Annual, plus quarterly drill cadence.

## 7. References

- ADR-0024 (Merkle root + S3 Object Lock).
- [`../../operations/restore-drill.md`](../../operations/restore-drill.md).
- Terraform `infra/terraform/environments/*/` RDS module.

## 8. Revision history

| Version  | Date    | Author      | Change                  |
| -------- | ------- | ----------- | ----------------------- |
| 0.1-stub | `<TBD>` | Engineering | Initial framework stub. |
