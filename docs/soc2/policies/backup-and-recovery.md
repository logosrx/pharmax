# Backup and Recovery Policy — STUB

> **THIS IS A STUB.** Authoritative version: the recovery section of
> [`../../policies/business-continuity-and-disaster-recovery.md`](../../policies/business-continuity-and-disaster-recovery.md).
> Every `<TBD>` marker must be resolved by legal counsel and/or the
> SOC 2 auditor.

| Field          | Value                                                              |
| -------------- | ------------------------------------------------------------------ |
| Owner          | Engineering Lead                                                   |
| Approver       | CTO                                                                |
| Effective date | `<TBD by CEO: bundle adoption date (gate: AT-T1)>`                 |
| Last reviewed  | `<TBD by Engineering Lead: first review date (gate: AT-T1)>`       |
| Next review    | `<TBD by Engineering Lead: effective date + 1 year (gate: AT-T1)>` |
| Version        | 0.1-stub                                                           |
| Distribution   | Internal — Engineering + leadership                                |

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

- RDS automated backups are enabled with a **35-day** retention window
  in production and staging, and 7 days in dev. The window is set by
  `rds_backup_retention_days` in
  `infra/terraform/environments/<env>/us-east-1/terraform.tfvars` (line
  33 in production) and reaches the instance as
  `backup_retention_period` at `infra/terraform/modules/rds/main.tf:286`.
  `infra/terraform/variables.tf:167` constrains the value to 1-35, the
  Aurora maximum.
- Multi-AZ is enabled for hot failover: `rds_multi_az = true` at
  `infra/terraform/environments/prod/us-east-1/terraform.tfvars:44`.
- Point-in-time recovery is available across the retention window,
  because RDS enables PITR whenever `backup_retention_period` is greater
  than zero.
- Backups are encrypted: `storage_encrypted = true` at
  `infra/terraform/modules/rds/main.tf:283` with
  `kms_key_id = var.kms_key_arn` at line 284 — a customer-managed CMK
  from `infra/terraform/modules/kms/`, not an AWS-managed key.

### 3.2 S3 backups

- Versioning is enabled on both Pharmax-owned buckets:
  `aws_s3_bucket_versioning` at
  `infra/terraform/modules/s3-documents/main.tf:34` and
  `infra/terraform/modules/s3-audit-archive/main.tf:52`.
- Lifecycle policies define retention per data class (cross-reference
  [`data-classification.md`](./data-classification.md)).
- S3 Object Lock COMPLIANCE mode applies to the audit Merkle-root
  bucket (ADR-0024): `object_lock_enabled = true` at
  `infra/terraform/modules/s3-audit-archive/main.tf:36`, with
  `default_retention { mode = "COMPLIANCE" }` at line 60 and a floor of
  6 years enforced by `infra/terraform/variables.tf:427`. The bucket is
  also `prevent_destroy = true` and its lifecycle rule deliberately
  never expires an object. One gap remains: the bucket policy does not
  yet deny a `PutObject` that supplies a weaker per-object Object Lock
  mode — see `EI-2` in
  [`../evidence-integrity-findings.md`](../evidence-integrity-findings.md).

### 3.3 KMS key management

- KMS key material is managed by AWS; per-tenant KEKs are
  AWS-KMS-managed and never exported (ADR-0023).
- Key rotation in production is AWS KMS automatic annual rotation of key
  material: `enable_key_rotation = true` on each symmetric CMK in
  `infra/terraform/modules/kms/main.tf`. The asymmetric Merkle signing
  key cannot be rotated this way, which that file records at line 291;
  its rotation procedure belongs to ADR-0028.
- `rotateKek` is **not** a production mechanism. It exists only on
  `LocalKmsAdapter` (`packages/crypto/src/local-kms-adapter.ts:105`),
  which is dev-only. Earlier revisions of this policy cited it as the
  production rotation control; that was incorrect.

### 3.4 Validation

- Restore-drill cadence: quarterly per
  [`../../operations/restore-drill.md`](../../operations/restore-drill.md).
- Post-restore audit-chain verifier (`scripts/security/verify-audit-chain-all-orgs.ts`)
  must exit 0 for the drill to count.
- Drill log lands at `evidence/dr-drills/<period>/<date>.txt`.

### 3.5 Recovery objectives

These objectives are TIERED by failure scenario and are owned by the
authoritative
[`business-continuity-and-disaster-recovery.md`](../../policies/business-continuity-and-disaster-recovery.md)
(§3 Recovery objectives, §6 Failover scenarios). This table MUST NOT
restate them in a way that diverges; it mirrors that source so the SOC 2
data room has one set of numbers, not three. The `<TBD>` wrappers are the
auditor/legal confirmation gate, not a second opinion on the values.

| Metric                                  | Target                                                                                                         | Notes                                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| RPO — AZ failover                       | near zero (synchronous standby)                                                                                | BCP/DR §6.1.                                                                                              |
| RPO — in-region disaster (PITR restore) | `<TBD by Engineering Lead: measure at first restore drill (gate: DRILL); posture is ≤ 5 minutes via RDS PITR>` | BCP/DR §3.2. Re-owned from the auditor: nobody can confirm a recovery point that has never been measured. |
| RTO — AZ failover                       | < 15 minutes (automatic Multi-AZ failover)                                                                     | BCP/DR §6.1.                                                                                              |
| RTO — in-region disaster                | `<TBD by Engineering Lead: measure at first restore drill (gate: DRILL); posture is ≤ 4 hours>`                | BCP/DR §3.1. NOT a full-region figure. Re-owned from the auditor for the same reason as the row above.    |
| RTO — full-region failure               | `> 4 hours — OUT OF SCOPE` for the current single-region architecture                                          | BCP/DR §6.2; residual risk in the risk register. Mitigation: ADR-0022 multi-region.                       |
| MTD / MTPD (Maximum Tolerable Downtime) | `<TBD by legal counsel: confirm against customer SLAs (gate: PRE-T1); engineering posture is 24 hours>`        | BCP/DR §3.3. Correctly a contractual question, not an engineering one.                                    |

## 4. Roles and responsibilities

| Role             | Responsibility                                             |
| ---------------- | ---------------------------------------------------------- |
| Engineering Lead | Owns the backup posture; runs the quarterly restore drill. |
| CTO              | Approves the recovery objectives.                          |
| Security Officer | Confirms the post-restore audit-chain integrity.           |

## 5. Enforcement and sanctions

`<TBD by legal counsel: sanctions for missed restore drills,
unauthorized restoration to production from a non-current backup, or
deletion of a backup before its retention window (gate: PRE-T1).>`

## 6. Review cadence

Annual, plus quarterly drill cadence.

## 7. References

- ADR-0024 (Merkle root + S3 Object Lock).
- [`../../operations/restore-drill.md`](../../operations/restore-drill.md).
- Terraform `infra/terraform/environments/*/` RDS module.

## 8. Revision history

| Version  | Date                                        | Author      | Change                                                                                                                             |
| -------- | ------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 0.1-stub | `<TBD by CEO: adoption date (gate: AT-T1)>` | Engineering | Initial framework stub.                                                                                                            |
| 0.2-stub | `<TBD by CEO: adoption date (gate: AT-T1)>` | Engineering | Resolved the backup, versioning, and encryption facts against Terraform. Corrected the key-rotation mechanism. Re-owned RPO / RTO. |
