# 0023 — AwsKmsAdapter for production PHI envelope encryption

- **Status:** Accepted
- **Date:** 2026-05-25
- **Deciders:** Platform team
- **Tags:** `security`, `crypto`, `hipaa`, `soc2`

## Context

ADR 0005 ("envelope encryption per PHI field") committed us to per-field
AES-256-GCM with a fresh DEK per encrypt call, wrapped under a per-tenant
KEK. The `KmsAdapter` interface in `packages/crypto/src/kms-adapter.ts`
is the seam between the package and whatever key store actually holds
the KEK material.

Until now we had exactly one concrete adapter: `LocalKmsAdapter`. It
derives KEKs deterministically from a single process-wide seed using
HKDF-SHA-256 and is intended only for development and the test suite.
The bootstrap layer (`apps/web/src/server/bootstrap.ts`,
`apps/worker/src/main.ts`) hard-fails with a clear error when
`NODE_ENV=production` because shipping `LocalKmsAdapter` to production
would put PHI under a process-derived key with no hardware custody —
the threat model HIPAA's Security Rule and SOC 2 CC6.1 explicitly
require us to defeat.

A production binding has been deferred until now because:

1. We needed Phase 1–4 to actually exercise the encryption layer (every
   PHI field already round-trips through the adapter), so the
   interface boundary was validated under realistic workload before
   committing to a concrete provider.
2. AWS KMS now supports `GENERATE_VERIFY_MAC` keys with `HMAC_256`
   spec (since 2022), which gives us a deterministic blind-index
   primitive without standing up our own HMAC key custody.

The production binding is the single biggest unblocker on the
SOC 2 Type 1 / HIPAA-ready engineering readiness path.

## Decision

Add `AwsKmsAdapter` to `@pharmax/crypto`, implementing the existing
`KmsAdapter` interface against AWS KMS. The bootstrap layer wires it
in production; `LocalKmsAdapter` remains the dev/test path.

The adapter binds **two** AWS KMS keys, not one:

- **Data key** (`AWS_KMS_DATA_KEY_ID`): a symmetric `ENCRYPT_DECRYPT`
  customer-managed key. Used by `generateDataKey` (calls KMS
  `GenerateDataKey` with `KeySpec=AES_256`) and `unwrapDataKey`
  (calls KMS `Decrypt`).
- **Search key** (`AWS_KMS_SEARCH_KEY_ID`): a `GENERATE_VERIFY_MAC`
  key with `KeySpec=HMAC_256`. Used by `deriveSearchKey` (calls KMS
  `GenerateMac` with `MacAlgorithm=HMAC_SHA_256`). Results are
  memoized in process memory keyed by `(tenantId, purpose)` because
  blind-index search is a hot path.

Two keys, because AWS KMS forbids mixing key usages on a single key.

Every `GenerateDataKey` and `Decrypt` call passes
`EncryptionContext = { tenantId }`. AWS KMS treats the context as
additional authenticated data on the wrap: a wrapped DEK produced
under tenant A literally cannot be decrypted when the caller passes
tenant B's id. This is cryptographic enforcement on top of the
application-layer tenancy gate — defence in depth for cross-tenant
PHI access attempts. Field-level AAD (record binding from `aad.ts`)
remains in place and is enforced independently.

Boot-time validation: the bootstrap layer calls `kms.validate()`
once before declaring boot complete. `validate()` pings KMS with
`DescribeKey` on both keys, asserting `Enabled=true`, `KeyUsage`
matches the expected value, and (for the search key) `KeySpec=HMAC_256`.
Failure aborts boot — an IAM misconfig (most common: ECS task role
missing `kms:DescribeKey`) surfaces immediately, not as a cascading
per-request failure 30 minutes after deploy.

The persistent `kid` format is `aws:kek:<keyIdLabel>:<tenantId>:v1`.
The `aws:` prefix mechanically distinguishes production-encrypted
envelopes from dev-encrypted ones; the version slot is reserved
for explicit application-level KEK epoch rotation. Day-to-day we
ride AWS KMS's automatic annual key-material rotation (enabled in
the Terraform module) which is transparent to `Decrypt` callers.

The SDK wrapper (`createAwsKmsClient`) is kept in a separate file
(`packages/crypto/src/aws-kms-client.ts`) so the adapter itself does
not statically import `@aws-sdk/client-kms`. Unit tests pass a
hand-rolled fake implementing the minimal `AwsKmsClient` interface.

## Consequences

**What becomes easier:**

- Production can finally boot. The
  `Refusing to boot ... with LocalKmsAdapter` guard now has a path
  through it.
- KEK custody moves to AWS KMS (FIPS 140-2 Level 3 HSM) — auditors
  no longer need to validate our own KEK lifecycle code.
- Cross-tenant PHI exposure now has a cryptographic floor: even if a
  bug bypasses the application-level tenancy gate, the `EncryptionContext`
  binding makes the wrapped DEK unusable in the wrong tenant context.
- KEK rotation is now an AWS-side concern (automatic annual rotation
  on customer-managed keys); we keep the explicit-rotation procedure
  in `docs/RUNBOOK.md#rotating-a-kms-data-key` as a break-glass path.

**What becomes harder or more expensive:**

- Two customer-managed keys per environment ($1/key/month) plus per-
  call charges. At our projected volume (~10k field encrypt/decrypt
  per active org per day) this is in low single-digit dollars per org
  per month.
- Boot now requires AWS reachability. A KMS regional outage prevents
  process start, even if the request load could otherwise be served
  by the existing connection pool. Mitigation: AWS KMS has stricter
  availability SLAs than any of our other dependencies, and the
  outage path is the _correct_ path to fail loudly.
- Search-key memoization holds 32-byte buffers in process memory for
  the process lifetime. We accept this as the same threat model
  applies to the DEKs we already hold transiently during encrypt
  calls; process memory disclosure is out of scope for HIPAA at our
  posture level.

**Ongoing obligations:**

- The Terraform KMS module is the single source of truth for KMS
  key configuration. Adding a new environment requires creating both
  keys; the `validate()` boot check enforces this.
- The IAM policy attached to ECS task roles must include
  `kms:GenerateDataKey`, `kms:Decrypt`, `kms:GenerateMac`, and
  `kms:DescribeKey` against both key ARNs. The check-migrations
  linter does not catch IAM misconfig — only the boot-time
  `validate()` does.
- `PHARMAX_LOCAL_KMS_SEED` and AWS KMS env vars are mutually
  exclusive in practice. The bootstrap layer prefers AWS when both
  are set (with a `warn`), which is the right default for an
  engineer deliberately pointing dev at AWS.

**Failure modes and detection:**

- IAM misconfig (most likely) → boot-time `DescribeKey` failure →
  process exits with a clear, key-ARN-labelled error before any
  request is served. Caught by ECS health-check failure → CloudWatch
  alarm on unhealthy-task-count.
- KMS regional outage → boot fails or `generateDataKey` throws on
  every request. AWS SDK retries (3 attempts, adaptive backoff)
  absorb transient blips. The Sentry capture is the alert path.
- A wrapped DEK encoded under the wrong `EncryptionContext` →
  `Decrypt` returns `InvalidCiphertextException` → adapter throws
  `DECRYPT_FAILED`. Surfaced via the existing decrypt-failure audit
  signal in `audit_log`.

## Alternatives Considered

**One CMK per tenant (per organization).** Strong per-tenant key
custody; tenant offboarding is `ScheduleKeyDeletion` (7-day delay).
Rejected for two reasons: (1) cost scales linearly per tenant
($1/month/org); for a B2B platform with 1000+ orgs this is meaningful
overhead; (2) provisioning a key requires a KMS round-trip during
org creation, which complicates the `CreateOrganization` command
without a security benefit our `EncryptionContext`-based binding
doesn't already give us. We may revisit if a tenant explicitly
requires segregated key custody as a contract term — the
`AwsKmsAdapter` can be extended to support per-tenant data keys
without changing the `KmsAdapter` interface.

**One symmetric CMK, HKDF-derived search keys locally.** Saves the
HMAC CMK ($1/month + per-call charge). Rejected because it puts the
search-key root material in process memory longer than necessary,
and because the HMAC CMK gives us a clean "rotate the search key"
operation (just bump the CMK), whereas a locally-derived approach
would require coordinated migration across all blind indexes.

**External KMS providers (HashiCorp Vault, Google Cloud KMS).**
Either would meet the interface contract. Rejected because the rest
of the deployment posture is AWS-native (RDS, ECS, S3, Secrets
Manager) and adding a non-AWS service to the dependency graph for
no incremental security benefit is the wrong trade. The
`KmsAdapter` interface is small enough that adding a third concrete
adapter later is straightforward.

## References

- Code: `packages/crypto/src/aws-kms-adapter.ts`
- Code: `packages/crypto/src/aws-kms-client.ts`
- Code: `packages/crypto/src/kms-adapter.ts` (interface contract)
- Code: `apps/web/src/server/bootstrap.ts` (production wiring)
- Code: `apps/worker/src/main.ts` (production wiring)
- Tests: `packages/crypto/src/aws-kms-adapter.test.ts`
- Companion ADRs: `0005-envelope-encryption-per-phi-field.md`,
  `0010-blind-indexes-for-phi-search.md`,
  `0011-separation-of-duties-at-command-bus.md`
- Terraform: `infra/terraform/modules/kms/` (KMS keys + IAM)
- Runbook: `docs/RUNBOOK.md#rotating-a-kms-data-key`
- External: AWS KMS `GenerateDataKey`, `Decrypt`, `GenerateMac`
  API reference; AWS KMS encryption context documentation
