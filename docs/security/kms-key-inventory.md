# KMS Key Inventory

| Field          | Value                                       |
| -------------- | ------------------------------------------- |
| Owner          | [Owner: CTO]                                |
| Approver       | [Approver: CEO]                             |
| Effective date | 2026-05-28                                  |
| Last reviewed  | 2026-05-28                                  |
| Next review    | 2026-08-28 (quarterly)                      |
| Version        | 1.1                                         |
| Distribution   | Internal — All engineering, audit observers |

## 1. Purpose

This document is the single source of truth for **every** customer-managed
KMS key the Pharmax production stack relies on. Auditors, on-call
engineers, and operators read this page to answer:

- What keys exist?
- What does each key protect?
- Who can call it?
- How does it rotate?
- Where is the rotation procedure?
- What breaks if it goes away?

For the architectural decisions behind the inventory (why eight, why this
split, why these key specs) see ADR-0023, ADR-0024, and ADR-0028. For
operational procedures, see [`../RUNBOOK.md`](../RUNBOOK.md). For the
underlying IaC, see
[`infra/terraform/modules/kms/main.tf`](../../infra/terraform/modules/kms/main.tf).

The inventory maps to SOC 2 **CC6.7** (transmission and disposal of
confidential information — keyed via Key Management) and HIPAA
**45 CFR § 164.312(a)(2)(iv)** (encryption / decryption — addressable).

## 2. Scope

In scope:

- Customer-managed CMKs (`aws_kms_key.*`) in the prod and staging AWS
  accounts.
- Aliases (`aws_kms_alias.*`) that the application or operators reference
  by name.

Out of scope (referenced for completeness, NOT enumerated here):

- AWS-managed keys (`aws/s3`, `aws/rds`, etc.). These are not under our
  rotation control; we do not use them for any PHI surface.
- The local development seed (`PHARMAX_LOCAL_KMS_SEED`). This is a
  dev-only credential bound to `LocalKmsAdapter`; production cannot
  resolve it (bootstrap hard-fails — see ADR-0023).

## 3. The eight production keys

The keys exist once per `<environment, region>` tuple. Naming follows
the Terraform `name_prefix` convention: `pharmax-<env>-<region>-`. Example
production us-east-1 aliases shown below.

> All eight keys have `deletion_window_in_days = 30` (the maximum AWS
> KMS allows). This is the standard safety net against operator error;
> never reduce it. See `infra/terraform/modules/kms/main.tf`.

### 3.1 Summary table

| #   | Key (Terraform resource)    | Alias                                             | KeyUsage              | KeySpec                                 | Auto-rotation                                         | Owner    | Owning app(s)                                            | Runbook entry                                                                                          |
| --- | --------------------------- | ------------------------------------------------- | --------------------- | --------------------------------------- | ----------------------------------------------------- | -------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | `aws_kms_key.rds`           | `alias/<prefix>-rds`                              | `ENCRYPT_DECRYPT`     | `SYMMETRIC_DEFAULT`                     | Yes (annual)                                          | Platform | RDS (Postgres at rest)                                   | n/a (RDS-managed; rotation visible in CloudTrail)                                                      |
| 2   | `aws_kms_key.documents`     | `alias/<prefix>-documents` (+ `-s3` legacy alias) | `ENCRYPT_DECRYPT`     | `SYMMETRIC_DEFAULT`                     | Yes (annual)                                          | Platform | S3 documents bucket                                      | [RUNBOOK § rotating a KMS data key](../RUNBOOK.md#rotating-a-kms-data-key) (procedure equivalent)      |
| 3   | `aws_kms_key.audit_archive` | `alias/<prefix>-audit-archive`                    | `ENCRYPT_DECRYPT`     | `SYMMETRIC_DEFAULT`                     | Yes (annual)                                          | Platform | S3 audit-archive bucket                                  | [RUNBOOK § Object Lock retention extension](../RUNBOOK.md#object-lock-retention-extension) (companion) |
| 4   | `aws_kms_key.secrets`       | `alias/<prefix>-secrets`                          | `ENCRYPT_DECRYPT`     | `SYMMETRIC_DEFAULT`                     | Yes (annual)                                          | Platform | AWS Secrets Manager                                      | n/a (rotation through Secrets Manager; CMK swap follows §5.1)                                          |
| 5   | `aws_kms_key.data`          | `alias/<prefix>-data` (+ `-app-phi` legacy alias) | `ENCRYPT_DECRYPT`     | `SYMMETRIC_DEFAULT`                     | Yes (annual)                                          | Security | `apps/web`, `apps/worker` (envelope-encryption DEK wrap) | [RUNBOOK § Rotating a KMS data key](../RUNBOOK.md#rotating-a-kms-data-key)                             |
| 6   | `aws_kms_key.search`        | `alias/<prefix>-search`                           | `GENERATE_VERIFY_MAC` | `HMAC_256`                              | Yes (annual)                                          | Security | `apps/web`, `apps/worker` (blind-index HMAC)             | [RUNBOOK § Rotating the KMS search-key (HMAC) key](../RUNBOOK.md#rotating-the-kms-search-key-hmac-key) |
| 7   | `aws_kms_key.asymm_sign`    | `alias/<prefix>-asymm-sign`                       | `SIGN_VERIFY`         | `ECC_NIST_P256` (default; configurable) | **No** (AWS KMS does not auto-rotate asymmetric keys) | Security | `apps/worker` (Merkle root signing)                      | [RUNBOOK § Rotating the Merkle signing key](../RUNBOOK.md#rotating-the-merkle-signing-key)             |
| 8   | `aws_kms_key.logs`          | `alias/<prefix>-logs`                             | `ENCRYPT_DECRYPT`     | `SYMMETRIC_DEFAULT`                     | Yes (annual)                                          | Platform | CloudWatch Logs                                          | n/a (CloudWatch-managed access pattern; CMK swap follows §5.1)                                         |

### 3.2 Per-key detail

Each entry below answers six questions: **what**, **why distinct from siblings**,
**who calls it**, **which env var**, **rotation cadence**, and **blast radius
if compromised**.

#### 3.2.1 RDS storage key (#1)

- **What.** AES-256 CMK supplied to RDS for storage-layer encryption of
  the Postgres data volume and all snapshots.
- **Why distinct.** Storage-layer encryption is a separate threat model
  from field-level envelope encryption. The data CMK (#5) protects PHI
  fields inside Postgres; this key protects the underlying volume so a
  raw EBS snapshot leak is unreadable. **Both** layers apply; neither
  replaces the other.
- **Who calls it.** RDS service principal only. The application never
  touches this key directly.
- **Env var.** None (the RDS instance carries the KMS key id; the
  Terraform module wires it.)
- **Rotation.** Annual auto-rotation. Snapshots inherit the source
  instance's KMS key id; cross-region snapshot copies re-encrypt under
  the destination-region RDS key.
- **Compromise blast radius.** Raw EBS volume access becomes readable.
  PHI in those bytes is still envelope-encrypted at the field level
  (the data CMK protects DEKs); search blind indexes leak metadata
  about value presence but not values.

#### 3.2.2 S3 documents key (#2)

- **What.** SSE-KMS for the documents bucket (PDFs, label PNGs, image
  scans, attachments).
- **Why distinct.** Documents are a different PHI surface from
  structured fields and from audit archives. Compromise of this key
  must not retroactively unlock the audit archive (ADR-0024).
- **Who calls it.** `apps/web` (uploads, presigned-URL signing),
  `apps/worker` (label rendering, ZPL captures).
- **Env var.** None directly (bucket is configured with the alias;
  IAM grants application principals access).
- **Aliases.** Primary: `alias/<prefix>-documents`. Legacy:
  `alias/<prefix>-s3` (kept for backwards compatibility with prior
  bucket/IAM references; safe to remove once no consumer resolves
  the old name — see the inline note in
  `infra/terraform/modules/kms/main.tf` § "Documents bucket SSE-KMS").
- **Rotation.** Annual auto-rotation.
- **Compromise blast radius.** All documents at rest become readable
  to whoever holds the leaked credential plus bucket access. Object-
  level access controls still apply, but the encryption boundary is
  defeated. **NOT** the audit-archive bucket (separate key) — the
  evidence-integrity property of ADR-0024 is preserved.

#### 3.2.3 S3 audit-archive key (#3)

- **What.** SSE-KMS for the audit-archive bucket (signed Merkle root
  manifests). The bucket is Object-Lock-COMPLIANCE.
- **Why distinct.** Manifests are evidence; the integrity property
  is "no operator can rewrite them." Splitting the key from documents
  prevents a documents-side incident from giving anyone a path to the
  evidence.
- **Who calls it.** `apps/worker` (writes daily manifests),
  external verifier scripts (reads manifests; see RUNBOOK § "Verifying
  a Merkle manifest from S3").
- **Env var.** `AUDIT_ARCHIVE_S3_KMS_KEY_ID` (worker).
- **Rotation.** Annual auto-rotation. Object Lock COMPLIANCE prevents
  re-encryption of existing manifests — rotation applies only to new
  writes.
- **Compromise blast radius.** Existing manifests still verify
  (verification uses the public key PEM; this CMK does not sign).
  Future writes happen under a compromised key until the rotation is
  complete. **No evidence tampering risk** because the signed root
  bytes are the integrity bearer, not the SSE-KMS wrapper.

#### 3.2.4 Secrets Manager key (#4)

- **What.** Envelope-encrypts every Secrets Manager secret value.
- **Why distinct.** Secrets Manager rotation has its own lifecycle
  (manual or automated per secret); the CMK is the cryptographic
  anchor.
- **Who calls it.** Secrets Manager service principal during
  GetSecretValue.
- **Env var.** None (Secrets Manager handles the binding).
- **Rotation.** Annual auto-rotation.
- **Compromise blast radius.** All Secrets Manager values become
  readable. SEV0 — propagates to every credential in the stack
  (DB password, third-party API keys, Clerk webhook secret, etc.).
  Mitigation is the standard Secrets Manager versioning + each
  consumer's restart-on-rotation behavior.

#### 3.2.5 PHI envelope data key (#5)

- **What.** The CMK that `AwsKmsAdapter.generateDataKey` /
  `AwsKmsAdapter.unwrapDataKey` call to wrap per-field DEKs. This is
  the key protecting every PHI field in Postgres (per ADR-0005).
- **Why distinct.** The single most security-critical key in the
  stack. Separated from RDS storage (#1) so a compromise of one
  layer does not collapse to compromise of the other.
- **Who calls it.** `apps/web`, `apps/worker`. ECS task roles get
  `kms:GenerateDataKey` + `kms:Decrypt` + `kms:DescribeKey` scoped
  to this key ARN only.
- **Env var.** `AWS_KMS_DATA_KEY_ID` (web + worker).
- **Rotation.** Annual auto-rotation of key material (transparent to
  callers — neither the kid format nor the wrapped envelopes change).
  CMK identity rotation (alias swap to a new CMK) is the manual,
  rare path and goes through
  [RUNBOOK § Rotating a KMS data key](../RUNBOOK.md#rotating-a-kms-data-key).
- **Compromise blast radius.** PHI cleartext exposure if combined
  with access to the encrypted envelopes. SEV0 — page CEO, see
  [`INCIDENT_RESPONSE.md`](../INCIDENT_RESPONSE.md), then begin
  rotation procedure under incident-response oversight.
- **Historical-key chain (manual CMK identity rotation).** The
  adapter pins `KeyId` in `kms.Decrypt` as defense-in-depth against
  pointing at the wrong CMK. During a manual CMK identity rotation
  (alias-swap to a new CMK), historical envelopes were wrapped
  under the OLD CMK and that defense would block their unwrap. The
  adapter accepts an optional `previousDataKeyKeyIds: ReadonlyArray<string>`
  threaded through `AWS_KMS_PREVIOUS_DATA_KEY_IDS` (comma-separated
  ARNs/aliases). On `unwrapDataKey` failure under the current key,
  it walks this chain in declared order, returning the first
  successful decrypt and incrementing
  `pharmax_kms_decrypt_historical_key_hits_total{key_position="<n>"}`
  so operators can drain the chain before revoking IAM grants on
  the old CMK. Steady-state (env unset): one Decrypt round-trip
  per unwrap, zero behavioral change. The runbook entry below
  documents both the steady-state and rotation procedures. Closes
  `kms2`.

#### 3.2.6 Blind-index search key (#6)

- **What.** HMAC-256 CMK used by
  `AwsKmsAdapter.deriveSearchKey` to derive per-tenant, per-purpose
  HMAC keys for blind indexes (ADR-0010).
- **Why distinct.** AWS KMS forbids `KeyUsage=GENERATE_VERIFY_MAC`
  on a key that also does `ENCRYPT_DECRYPT`. Cannot share with #5.
- **Who calls it.** `apps/web`, `apps/worker`. ECS task roles get
  `kms:GenerateMac` + `kms:DescribeKey` scoped to this key ARN only.
- **Env var.** `AWS_KMS_SEARCH_KEY_ID` (web + worker).
- **Rotation.** Annual auto-rotation of key material (transparent
  to callers). CMK identity rotation requires backfilling every
  `*_bid` column —
  [RUNBOOK § Rotating the KMS search-key (HMAC) key](../RUNBOOK.md#rotating-the-kms-search-key-hmac-key)
  describes the multi-hour-to-multi-day procedure. The HMAC CMK
  was originally documented as "non-rotatable" but AWS added
  rotation support for `HMAC_256` keys in April 2023; we ride
  that.
- **Compromise blast radius.** An attacker can compute blind
  indexes offline and probe "does the index for `firstname=X` exist
  in tenant Y?" for arbitrary `(X, Y)` pairs. This does NOT
  decrypt PHI; it enables presence enumeration only. SEV1.

#### 3.2.7 Audit-Merkle signing key (#7)

- **What.** Asymmetric `ECC_NIST_P256` (default) or
  `RSASSA_PSS_SHA_256` CMK used by `KmsAsymmetricSigner` in
  `@pharmax/security` to sign daily per-tenant audit-Merkle roots
  (ADR-0024).
- **Why distinct.** AWS KMS forbids mixing `SIGN_VERIFY` with any
  other usage. The signer's IAM principal gets `kms:Sign` +
  `kms:GetPublicKey` ONLY — never `kms:Decrypt`. This is the
  structural enforcement that a compromised PHI-decrypt path
  cannot forge audit manifests.
- **Who calls it.** `apps/worker` (`createNightlyMerkleRootLoopFromEnv`
  and `pnpm security:sign-merkle --prod`).
- **Env var.** `MERKLE_SIGNER_KMS_KEY_ID` (worker).
- **Rotation.** **NOT** auto-rotated. AWS KMS does not support
  rotation on asymmetric keys. Operator-driven via
  [RUNBOOK § Rotating the Merkle signing key](../RUNBOOK.md#rotating-the-merkle-signing-key).
  Old public key PEMs MUST be preserved indefinitely for historical
  manifest verification.
- **Compromise blast radius.** Attacker can forge "valid" Merkle
  manifests for future periods. Existing manifests stay valid
  (already signed; existing verifications still pass against the
  pinned PEM). SEV0 because evidence-integrity is the load-bearing
  property of the audit archive.

#### 3.2.8 CloudWatch Logs key (#8)

- **What.** Envelope-encrypts every CloudWatch Log Group.
- **Why distinct.** Log streams should not share a key with PHI
  fields — a CloudTrail Decrypt entry on the PHI data key must
  signal real PHI access, not log writes.
- **Who calls it.** CloudWatch Logs service principal, gated by
  `kms:EncryptionContext:aws:logs:arn` matching the log group ARN
  in the resource policy.
- **Env var.** None.
- **Rotation.** Annual auto-rotation.
- **Compromise blast radius.** Application logs become readable.
  Pharmax PHI invariant is "logs never contain PHI" (see
  `02-security-compliance.mdc`), so the realistic exposure is
  application metadata only. SEV2.

## 4. Cross-key invariants

These invariants apply across the inventory; if any one breaks, the
overall posture is degraded regardless of how well any individual key
is managed.

1. **No key has `Principal: *` in its policy.** All grants are
   explicit. The Terraform `key_admin` document grants only
   `arn:aws:iam::<account>:root`; service principals (CloudWatch
   Logs, S3) are added where required with strict `Condition` blocks.
2. **Application-level grants live in IAM, not key policy.** Task
   roles receive `kms:GenerateDataKey` / `kms:Decrypt` /
   `kms:GenerateMac` / `kms:Sign` via `aws_iam_role_policy`
   resources in the `iam` module, scoped to the specific key ARNs
   they need. The key policy stays stable across task-role churn.
3. **`enable_key_rotation = true` on every symmetric/HMAC key.**
   The asymmetric signing key (#7) is the only exception (AWS
   limitation). The CI Terraform plan reviewer rejects PRs that
   disable rotation on a key listed here.
4. **`deletion_window_in_days = 30` on every key.** Maximum allowed
   by AWS KMS. Never reduce.
5. **CMK aliases are stable.** Code and env vars reference aliases,
   never raw key ARNs. This is the mechanism that makes alias-swap
   rotation operator-friendly. During a rotation bake-in window the
   OLD CMK's ARN/alias goes into `AWS_KMS_PREVIOUS_DATA_KEY_IDS` so
   historical envelopes still decrypt — see §3.2.5 for the
   adapter-level behavior, and the RUNBOOK rotation procedure for
   the operator steps.
6. **No cross-account or cross-region key sharing.** Per ADR-0022,
   each region maintains its own keys. The DR region keys are not
   the same keys as the primary region; failover serves new data
   only until the primary region returns.

## 5. Rotation policy

### 5.1 Cadence summary

| Trigger                                    | Cadence       | Procedure                                                                                                                     |
| ------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Automatic key-material rotation (#1–6, #8) | Annual        | None — AWS handles transparently; observe in CloudTrail.                                                                      |
| Manual CMK identity rotation (#1–6, #8)    | On compromise | Per-key runbook entry (see §3.1 table).                                                                                       |
| Asymmetric signing-key rotation (#7)       | On compromise | [RUNBOOK § Rotating the Merkle signing key](../RUNBOOK.md#rotating-the-merkle-signing-key).                                   |
| Rotation-drill rehearsal                   | Quarterly     | [RUNBOOK § Quarterly KMS rotation drill](../RUNBOOK.md#quarterly-kms-rotation-drill).                                         |
| Post-rotation evidence capture             | Per rotation  | Capture CloudTrail `Encrypt` / `Decrypt` events showing the new key in use; attach to the SOC 2 evidence pack for the period. |

### 5.2 What counts as "rotation"

- **Routine rotation** = the AWS-managed annual rotation of the
  underlying key material. No operator action; no code change; no
  CloudTrail rotation event needed for the runbook. The verifier
  script (`pnpm verify:kms`) is the proof that the key still works
  after rotation.
- **Manual rotation** = CMK identity swap (a new CMK provisioned,
  alias moved to it, IAM updated to allow Decrypt on both for the
  transition window). Driven by compromise or by a structural
  policy change that `aws kms put-key-policy` can't express.
- **Application-level rotation** = bumping the `kid` version slot
  in the `aws:kek:<label>:<tenantId>:vN` format. Today the slot is
  pinned at `v1`; bumping requires a code change in
  `AwsKmsAdapter.kidFor()` plus a Prisma migration to mark
  affected rows. Reserved for future use; never an operator-time
  step.

### 5.3 Why we rehearse quarterly

A rotation procedure that has never been executed is not a
procedure — it's a hypothesis. The Quarterly KMS Rotation Drill
(see RUNBOOK) provisions a throwaway CMK in the staging
environment, performs an end-to-end alias swap, runs `pnpm verify:kms`
against the new key, and tears it down. The drill captain documents
the result; the evidence pack feeds SOC 2 CC6.7. Skipping a quarter
is a SOC 2 finding.

## 6. Drift between this inventory and reality

The single source of truth is
[`infra/terraform/modules/kms/main.tf`](../../infra/terraform/modules/kms/main.tf).
If you add, remove, or change a key in Terraform, update this
inventory **in the same PR**. CI enforces this via
[`scripts/check-kms-inventory.ts`](../../scripts/check-kms-inventory.ts)
(`pnpm check:kms-inventory`), which runs in the
[`safety-linters` CI job](../../.github/workflows/ci.yml) on every
PR. The check diffs the §3.1 summary table against the Terraform
module on five axes — resource-name parity, KeyUsage parity, KeySpec
parity (resolving `var.*` references via the variable's `default`),
auto-rotation parity (`enable_key_rotation = true` ↔ "Yes" / "No"),
and alias parity (every `aws_kms_alias.*` in TF must be listed in
the inventory row of the key it targets). Drift fails the PR with a
remediation hint per issue; an unfixed drift is a SOC 2 CC8.1
finding regardless. The check is sandbox-free (reads three local
files) so it requires no AWS credentials.

The nightly Terraform drift-detection job
(see [`infra/terraform/README.md` § drift-detection](../../infra/terraform/README.md))
catches AWS-console changes to KMS. Console drift is itself a
finding; the reconciliation path is to edit Terraform and
`apply`, never to mark the console state as authoritative.

## 7. Open follow-ups

| Id         | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Owner    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| ~~`kms2`~~ | ~~`AwsKmsAdapter.unwrapDataKey` pins `KeyId` in `kms.Decrypt`. After CMK identity rotation (alias-swap), historical envelopes become unreadable.~~ **CLOSED 2026-06-02**: shipped `AwsKmsAdapterOptions.previousDataKeyKeyIds` (frozen array of historical CMK ARNs), wired through the new `AWS_KMS_PREVIOUS_DATA_KEY_IDS` env var on both `apps/web` and `apps/worker`. Behavior: current-key Decrypt first (defense-in-depth pin preserved); on failure, walks the historical chain in declared order; first success returns the DEK and increments `pharmax_kms_decrypt_historical_key_hits_total`. Boot-time `validate()` `DescribeKey`-checks every historical key. 14 new unit tests added (68 total in `aws-kms-adapter.test.ts`). | Security |
| ~~`kms3`~~ | ~~Add a CI check that diffs this inventory against `infra/terraform/modules/kms/main.tf` and fails the PR on drift.~~ **CLOSED 2026-05-28**: shipped as `scripts/check-kms-inventory.ts` + `pnpm check:kms-inventory` (wired into the `safety-linters` CI job and `pnpm verify`); 44 unit tests pin the parser + comparator behaviour. The first run against the real files surfaced and fixed one piece of latent drift (the `documents_legacy_s3` alias).                                                                                                                                                                                                                                                                                | Platform |

## 8. References

- ADR-0005 — envelope encryption per PHI field
- ADR-0010 — blind indexes for PHI search
- ADR-0023 — `AwsKmsAdapter` for production PHI envelope encryption
- ADR-0024 — daily Merkle-root signing and evidence
- ADR-0028 — KMS key inventory + rotation policy (this document is its operational appendix)
- Code: `packages/crypto/src/aws-kms-adapter.ts`,
  `packages/security/src/merkle/kms-signing-client.ts`,
  `scripts/security/verify-kms-keys.ts`
- IaC: `infra/terraform/modules/kms/main.tf`,
  `infra/terraform/modules/iam/main.tf`
- Runbook: [`../RUNBOOK.md`](../RUNBOOK.md) (all KMS sections)
- Code-evidence map: [`../soc2/code-evidence-map.md`](../soc2/code-evidence-map.md) (CC6.7 row)

## 9. Revision history

| Version | Date       | Author        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------- | ---------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1.0     | 2026-05-28 | Platform team | Initial inventory; eight production keys.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 1.1     | 2026-05-28 | Platform team | Closed `kms3`: shipped `scripts/check-kms-inventory.ts` + `pnpm check:kms-inventory` (wired into the `safety-linters` CI job and `pnpm verify`); 44 unit tests. The first end-to-end run surfaced one piece of latent drift — `aws_kms_alias.documents_legacy_s3` (`alias/<prefix>-s3`) was in the Terraform module but undocumented in the inventory; the row for `aws_kms_key.documents` (§3.1 summary table + §3.2.2 per-key detail) was updated to record the legacy alias inline using the same `(+ -<suffix> legacy alias)` convention the `aws_kms_key.data` row already used for `app-phi`. §6 ("Drift between this inventory and reality") was rewritten to describe the now-automated enforcement instead of the "review checklist is the gate" prior posture.                                                                                                                                                                                                                                                                                                             |
| 1.2     | 2026-06-02 | Security team | Closed `kms2` (the last open follow-up in this inventory). Shipped `AwsKmsAdapterOptions.previousDataKeyKeyIds` — a frozen array of historical CMK ARNs/aliases threaded through the new `AWS_KMS_PREVIOUS_DATA_KEY_IDS` env var on both `apps/web` and `apps/worker` so manual CMK identity rotation no longer leaves historical envelopes unreadable during the bake-in window. Behavior: current-key Decrypt first (defense-in-depth `KeyId` pin preserved); on failure, walks the historical chain in declared order; first success returns the DEK and increments `pharmax_kms_decrypt_historical_key_hits_total{key_position="<n>"}`. Boot-time `validate()` now `DescribeKey`-checks every historical key (Enabled + ENCRYPT_DECRYPT + SYMMETRIC_DEFAULT). §3.2.5 was rewritten to remove the "Known caveat" callout and document the new historical-key chain. §4 invariant #5 was updated to point at the new env var. §7 marks `kms2` CLOSED — every tracked follow-up in this inventory is now resolved. 14 new unit tests added (68 total in `aws-kms-adapter.test.ts`). |
