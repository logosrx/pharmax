# Encryption Overview

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

This document is the narrative summary of Pharmax's encryption posture — what we encrypt, with what algorithm, who holds the keys, and how the keys are managed. It is the answer to "tell me about your encryption" without making the reader piece it together from the ADRs.

For the architectural detail and the rejected alternatives, see ADR 0005 (envelope encryption), ADR 0006 (hash-chained audit), and ADR 0010 (blind indexes for PHI search). For the operational mechanics, see [`../RUNBOOK.md`](../RUNBOOK.md) §"Rotating a KMS data key" and §"Audit chain integrity check".

This document maps to:

- HIPAA **45 CFR § 164.312(a)(2)(iv)** — encryption and decryption (addressable).
- HIPAA **45 CFR § 164.312(e)(2)(ii)** — encryption in transit (addressable).
- SOC 2 **C1.1, C1.2** — confidentiality criteria.
- SOC 2 **CC6.1, CC6.7** — logical access protection and transmission protection.

## 2. The three states we protect

### 2.1 In transit

Every connection that carries Pharmax data uses **TLS 1.2 or higher**:

- The operator console (`apps/web`) is fronted by AWS-managed TLS termination. The minimum protocol is TLS 1.2; TLS 1.3 is preferred where the client supports it.
- Connections to AWS-managed services (RDS, S3, KMS, Secrets Manager) use AWS-internal TLS over the AWS backbone.
- Outbound connections to Stripe, EasyPost, Clerk, Resend, Sentry, and the observability vendor all use HTTPS with TLS 1.2+.
- Inbound webhooks from Stripe, EasyPost, and carrier portals arrive over HTTPS; the signature verification is the authenticity check (see [Data Classification Policy](../policies/data-classification.md) §3.4.2).
- The print agent (`apps/print-agent`) connects to the Pharmax API over HTTPS and to local Zebra printers over the workstation's local network — the local-network printer leg is the one segment we do not control end-to-end; the operator's workstation network posture is part of the customer's responsibility, documented in the customer-facing security packet.

There is **no acceptable scenario for a plaintext connection** anywhere in the production path. The operator console refuses HTTP; the API surface refuses HTTP; admin dashboards refuse HTTP.

### 2.2 At rest

#### 2.2.1 PHI fields — envelope encryption per field

Per ADR 0005, every PHI field in the Pharmax database is **envelope-encrypted per field** with per-tenant key isolation. The construction:

- Each PHI write generates a **fresh per-record Data Encryption Key (DEK)**.
- The plaintext is encrypted with **AES-256-GCM** using the DEK.
- The DEK is wrapped with the per-tenant **Key Encryption Key (KEK)** (AES-256-GCM, 60-byte wrapped form).
- The result is serialized as a JSON envelope `{v, alg, kek, wDek, iv, ct, tag}` and stored in a Prisma `Json` column whose name ends in `Enc` (e.g. `firstNameEnc`, `dobEnc`, `phoneEnc`).
- The DEK plaintext is zeroed in memory after use.

The **AAD (Additional Authenticated Data)** is the load-bearing security primitive. AAD is a canonical, versioned, NUL-separated, sorted-key encoding (`crypto.v1`) over `{tenantId, table, column, recordId}`. A ciphertext moved between rows — different `recordId`, `column`, `table`, or `tenantId` — fails GCM tag verification and surfaces as `AuthorizationError(AAD_MISMATCH)`. The signal is not "decryption failed" but "someone moved a ciphertext", and the audit response reflects that.

#### 2.2.2 Key Encryption Keys — AWS KMS, per tenant

Per-tenant KEKs live in **AWS KMS** as customer-managed keys (CMKs). Each tenant has its own KEK. The benefits:

- **Per-tenant isolation.** A leaked envelope from tenant A cannot decrypt tenant B's data. AAD binding plus per-tenant KEK is the construction.
- **Crypto-shred for tenant offboarding.** Scheduling deletion of a tenant's KEK in AWS KMS (minimum 7-day delay; AWS protected window) renders every envelope encrypted under that key unreadable. The rows remain for FK integrity; the ciphertexts are functionally destroyed. See `../RUNBOOK.md` §"Rotating a KMS data key".
- **Rotation.** AWS KMS supports automatic annual rotation of CMKs. For manual rotation (incident response), a new key is created, the old aliased to `*-deprecated`, the tenant's pointer is updated. New envelopes use the new KEK; old envelopes still decrypt against the old key. KEK rotation does **not** require re-encrypting data.

Until `AwsKmsAdapter` lands (tracked in `../IMPLEMENTATION_PLAN.md` Phase 4), production **fails closed** against the `LocalKmsAdapter`: a production boot that finds the local adapter wired throws `InternalError(CRYPTO_NOT_CONFIGURED)` and refuses to serve traffic. The local adapter exists for dev / test and is intentionally fatal in `NODE_ENV=production`.

#### 2.2.3 Database — AWS RDS at-rest encryption

The PostgreSQL data files, snapshots, automated backups, and read replicas are encrypted at rest by AWS RDS with **AES-256** and a KMS-managed key. This is a defense-in-depth layer separate from the envelope encryption above:

- An attacker who somehow obtains a raw RDS backup file gets AES-256 ciphertext at the storage layer.
- Underneath that, the PHI columns are themselves envelopes whose DEKs are wrapped by the per-tenant KEK in KMS.
- Two unwrap operations would be required to read PHI; each requires KMS access.

#### 2.2.4 Object storage — AWS S3 at-rest encryption

S3 buckets that hold Pharmax documents (scans, labels, attachments) use either **SSE-S3** (server-side encryption with AES-256, AWS-managed keys) or **SSE-KMS** (with a customer-managed key) depending on the bucket's sensitivity. Buckets holding patient-attached documents use SSE-KMS with a per-bucket CMK. Versioning is enabled; lifecycle rules retain prior versions for 90 days; cross-region replication is enabled for high-durability objects.

#### 2.2.5 Secrets — AWS Secrets Manager + 1Password

Runtime secrets live in **AWS Secrets Manager**, encrypted at rest with an AWS-managed KMS key. The application retrieves secrets at boot via an IAM-bounded role. Human-use credentials live in **1Password**, which uses end-to-end encryption with a per-account Secret Key + master password as the unwrap inputs. Detail in [`secrets-management.md`](./secrets-management.md).

### 2.3 In use — process memory

PHI exists in process memory during request handling. The defenses against in-memory PHI leakage are:

- **PHI never reaches a log line.** Pino's `redact` allowlist strips known PHI field names before log lines are emitted (`packages/platform-core/src/logger/redaction.ts`). The Sentry `beforeSend` allowlist is the second layer (`apps/web/src/server/observability/sentry-scrubber.ts`).
- **Browser session replay is disabled.** No `replaysSessionSampleRate`, no `replaysOnErrorSampleRate`. A captured frame could expose patient name on screen.
- **DEK plaintext is zeroed after use.** Per ADR 0005, after `decryptField` returns, the in-memory DEK buffer is zeroed.
- **PHI is rendered, then it's gone.** The operator console renders PHI to the DOM during the session; the React component tree carries it for the duration of the view; nothing in the application code caches PHI to disk on the server side.

## 3. Search on encrypted PHI — blind indexes

Direct `WHERE firstName = ?` is impossible by construction — the ciphertext is non-deterministic per write and per record. Per ADR 0010, **blind-index columns** (`*Bi`) sit next to each searchable `*Enc` column:

- The blind index is **HMAC-SHA-256** over a normalized form of the plaintext, keyed by a per-tenant per-purpose **search key**.
- Search keys are derived from the per-tenant KEK via **HKDF-SHA-256** with info `pharmax.search.v1.<tenantId>.<purpose>`. They are decoupled from KEK lifecycle so blind-index columns survive KEK rotation.
- Per-tenant + per-purpose isolation means the same plaintext produces different hashes across tenants and across columns. A leaked hash from tenant A cannot be replayed against tenant B.
- Search is an equality query on `(organizationId, *Bi)` — sub-millisecond, no decrypt fan-out.
- Hash collisions exist and are an intentional design property; the caller MUST disambiguate with a secondary check (DOB + name + MRN, etc.). Trusting a single BI hit is a security bug.

Fuzzy / partial / phonetic search on PHI is **not supported**. The search UX is "type at least three characters of the last name AND the DOB". We will not build broad decrypted PHI search.

## 4. Hash-chained audit log

The audit log is not encrypted — it is **integrity-protected**. Per ADR 0006:

- Every audit row carries a `prev_hash`, an `entry_hash`, and a per-tenant `seq` number.
- `entry_hash = SHA-256(canonical(prevHash, organizationId, seq, action, resourceType, resourceId, actorUserId, scope, metadata, occurredAt))`.
- A privileged actor (rogue DBA, compromised credential with `pharmax_system` access) attempting to rewrite history breaks the chain at some seq value; `verifyAuditChain` surfaces the first break.
- The `pharmax_app` role is `REVOKE`d on `UPDATE` and `DELETE` for audit tables; even routine application credentials cannot mutate audit history.
- Future Merkle-root signing to S3 Object Lock (deferred per the same ADR) closes the loop against even internal-state tampering.

The integrity guarantee is the audit-side complement to the confidentiality guarantee of envelope encryption. Together they answer "the data was protected, and we can prove what happened to it".

## 5. Key inventory and ownership

| Key                                     | Custodian                         | Algorithm              | Where it lives                                        | Rotation cadence                                           |
| --------------------------------------- | --------------------------------- | ---------------------- | ----------------------------------------------------- | ---------------------------------------------------------- |
| Per-tenant KEK (PHI envelope)           | AWS KMS (CMK)                     | AES-256-GCM            | AWS KMS, per tenant                                   | Automatic annual rotation enabled; manual on incident.     |
| Per-record DEK (PHI envelope)           | Application                       | AES-256-GCM            | Memory only — wrapped DEK persisted in column         | Per-write fresh; never persisted in plaintext.             |
| Per-tenant search key (blind index)     | Application via HKDF over the KEK | HMAC-SHA-256 key       | Derived on demand; never persisted in plaintext       | Decoupled from KEK; survives KEK rotation.                 |
| RDS at-rest CMK                         | AWS KMS                           | AES-256                | AWS KMS                                               | Annual.                                                    |
| S3 bucket CMKs (per sensitive bucket)   | AWS KMS                           | AES-256                | AWS KMS                                               | Annual.                                                    |
| Audit log integrity                     | Application                       | SHA-256                | Per-row `entry_hash` + per-tenant `audit_chain_state` | N/A (hash function; not rotated).                          |
| TLS certificates (operator console)     | AWS ACM                           | RSA-2048 / ECDSA P-256 | AWS ACM                                               | Auto-renewed by ACM.                                       |
| Stripe webhook secret                   | Stripe + Pharmax                  | HMAC-SHA-256           | Stripe dashboard + AWS Secrets Manager                | Annual; immediate on suspected compromise.                 |
| Vendor API keys (Clerk, EasyPost, etc.) | Vendor + Pharmax                  | (vendor-specific)      | AWS Secrets Manager                                   | Per [`secrets-management.md`](./secrets-management.md) §3. |

## 6. Cross-cutting properties

- **No deterministic encryption of PHI fields.** Two writes of the same plaintext produce different envelopes, so storage cannot leak "these two rows hold the same value". The deterministic primitive (HMAC blind index) is per-tenant per-purpose and confined to the search column.
- **No customer-supplied keys today.** All KMS keys are AWS CMKs owned by the Pharmax AWS account. Bring-your-own-key for tenants is a procurement-driven future feature, not a current commitment.
- **No HSM-rooted KMS today.** AWS KMS provides FIPS 140-2 Level 2 (the standard service) — sufficient for HIPAA. CloudHSM is a future option for customers who require Level 3, tracked as a vendor-procurement-driven item.
- **No PHI in encryption metadata.** The envelope's `kek` field is a key version identifier, not a plaintext key reference. The audit log's `metadata` is schema-validated against a registry and PHI-redacted before insert.

## 7. Operational implications

- **Every PHI read costs a KMS unwrap.** Local-KMS unwraps are microseconds; AWS KMS unwraps are milliseconds. We accept the cost. The performance budget is built around it.
- **KEK rotation does not require re-encrypting data.** A rotation publishes a new key version; wrapped DEKs that reference the old version continue to unwrap because KMS preserves the prior key material; new envelopes use the new version. KEK rotation is the cheap option.
- **Crypto-shred is irreversible.** Once a tenant's KEK is scheduled for deletion (and the protected window expires), the envelopes encrypted under it are unreadable forever. The shred is the formal mechanism for right-to-be-forgotten and tenant offboarding per [Data Classification Policy](../policies/data-classification.md) §6.
- **Local development uses a `LocalKmsAdapter`** that emulates KMS without contacting AWS. Local data is encrypted with the same envelope construction; the dev's KEK is held in process memory. Production refuses to boot against the local adapter.

## 8. Cross-references

- [`data-flow.md`](./data-flow.md) — where PHI lives at each stage of the request lifecycle.
- [`secrets-management.md`](./secrets-management.md) — non-PHI secrets posture.
- [`control-matrix.md`](./control-matrix.md) — control-to-evidence mapping including the encryption controls.
- [`hipaa-security-risk-analysis.md`](./hipaa-security-risk-analysis.md) — the structured analysis that this overview summarizes.
- [Data Classification Policy](../policies/data-classification.md) — handling rules per data tier.
- ADR 0005 — Envelope encryption per PHI field with AAD binding.
- ADR 0006 — Hash-chained audit log per tenant.
- ADR 0010 — Blind indexes for PHI search.
- HIPAA 45 CFR § 164.312(a)(2)(iv), § 164.312(e)(2)(ii).

## Revision history

| Version | Date       | Author | Change           |
| ------- | ---------- | ------ | ---------------- |
| 0.1     | YYYY-MM-DD | CTO    | Initial drafting |
