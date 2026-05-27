# Data Classification Policy

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

This policy defines how Pharmax categorizes the data we touch and how each category must be handled at rest, in transit, while in use, and at disposal. It is the spine that the [Acceptable Use Policy](./acceptable-use-policy.md), the [Access Control Policy](./access-control-policy.md), and the [`../security/encryption-overview.md`](../security/encryption-overview.md) all wrap around.

The classification system is intentionally short — four tiers. A more granular taxonomy is more accurate on paper and less useful in practice, because humans cannot remember more than a handful of categories. We choose the smallest number of buckets that lets us answer "what may I do with this thing?" without a lookup.

## 2. Scope

This policy applies to every piece of data that Pharmax stores, processes, or transmits — in production, in staging, in development, in operational tooling, in customer support tickets, in incident channels, in marketing material, in employee 1Password vaults, and on every device used to access Pharmax systems.

The four tiers below are mutually exclusive and collectively exhaustive: every datum we touch is in exactly one of them.

## 3. The four tiers

### 3.1 Public

**Definition.** Information intentionally available to anyone, with no harm to Pharmax, customers, or patients if widely shared.

**Examples.**

- The Pharmax marketing website.
- Published blog posts.
- Open-source code we publish (if any) and the documentation we publish to support it.
- Job postings.
- Press releases.

**Storage requirements.** No special requirements beyond hosting on a Pharmax-controlled platform. Public data may live on personal devices and on third-party platforms (LinkedIn, GitHub public repos, marketing CMS).

**Transmission requirements.** TLS for everything we serve, because the audience deserves it, but the classification itself imposes no transmission restriction.

**Retention.** As long as useful. Published material is durable; old marketing pages should be redirected, not deleted, to preserve inbound links.

**Disposal.** Deletion from the host platform is sufficient. No special destruction process.

### 3.2 Internal

**Definition.** Information not intended for public consumption but with limited harm if leaked. The default tier for everyday work product that does not contain customer data, secrets, or PHI.

**Examples.**

- Engineering documentation (`docs/RUNBOOK.md`, `docs/OBSERVABILITY.md`, `docs/ARCHITECTURE_PRINCIPLES.md`, etc.).
- This policy bundle.
- Internal Slack messages without customer or PHI content.
- Internal meeting notes that don't reference specific customers or patients.
- Generic operational metrics (worker drain rate, deploy frequency) without tenant breakdowns.

**Storage requirements.** Pharmax-managed systems (GitHub private org, Pharmax Notion or similar, Pharmax Slack, internal docs). Personal devices are acceptable but must meet the [Acceptable Use Policy](./acceptable-use-policy.md) §4 device requirements (full-disk encryption, lock screen, OS current).

**Transmission requirements.** TLS for all transit. Internal data sent outside Pharmax (e.g. to a vendor support team) is reviewed first to ensure it isn't actually Confidential or Restricted.

**Retention.** Indefinite while useful. Cleanup happens during the annual review cycle (old runbook sections removed, deprecated docs archived).

**Disposal.** Delete from the host system. No certificate of destruction required.

### 3.3 Confidential

**Definition.** Information whose disclosure would harm Pharmax commercially, expose customer-tenant identity, or expose a non-public security boundary. Includes internal financials, customer lists, vendor contracts, security architecture details beyond what we publish, and most operational data tied to a specific customer.

**Examples.**

- Customer tenant identifiers (`organizationId`, customer name, customer contact email).
- Vendor contracts, pricing terms, BAA copies.
- Source code in private repositories (the Pharmax repo itself is Confidential).
- Production infrastructure-as-code (Terraform under our private repo).
- Internal financial reports.
- The detailed [risk register](../governance/risk-register.md), [HIPAA Security Risk Analysis](../security/hipaa-security-risk-analysis.md), and [control matrix](../security/control-matrix.md) (this bundle is Internal by default and Confidential when exported to a specific reviewer under NDA).
- Incident postmortems with specific tenant references.
- Production logs with tenant identifiers but no PHI.

**Storage requirements.**

- Pharmax-managed systems only. No personal cloud storage (Dropbox, personal Google Drive, etc.).
- At rest, server-side encryption (AWS S3 SSE-S3 or SSE-KMS, RDS at-rest encryption, EBS encryption). Detail in [`../security/encryption-overview.md`](../security/encryption-overview.md).
- Personal devices: only if encrypted per [Acceptable Use Policy](./acceptable-use-policy.md) §4. Long-term resident storage of Confidential data on a personal device requires a documented business justification.
- AI tools: redact customer identifiers (`organizationId`, customer name) before pasting into a prompt. See [Acceptable Use Policy](./acceptable-use-policy.md) §7.

**Transmission requirements.**

- TLS for everything.
- External transmission (to a vendor, a customer, an auditor) requires an NDA or contract clause that covers confidentiality.
- Email is acceptable for Confidential content to known business addresses; not acceptable to personal addresses.
- No Confidential content in unencrypted physical media.

**Retention.**

- Customer-tied operational data: retained for the period required by the customer's BAA or contract, defaulting to seven years for HIPAA-covered tenants per the audit-records standard the Security Rule applies (45 CFR § 164.530(j) for documentation retention is the floor; we apply it to the operational record by extension).
- Vendor contracts and BAAs: retained for the life of the relationship plus seven years.
- Financial reports: per the company's records-retention schedule.

**Disposal.**

- Server-side data: standard delete operations. We rely on AWS to scrub blocks on object deletion; for higher assurance, see the crypto-shred path in §3.4 for Restricted data.
- Local files: empty trash; on encrypted disks this is sufficient because the entire disk is encrypted.
- Physical media: never permitted for Confidential data without explicit CTO approval and a destruction record.

### 3.4 Restricted — PHI and equivalent

**Definition.** Protected Health Information as defined by HIPAA, plus credentials, secrets, and other material whose disclosure would cause direct, individual harm.

**Examples — PHI proper.**

- Patient name, address, date of birth, phone, email, MRN, SSN-last-4.
- Prescription details: drug, dose, sig, refills, prescriber.
- Order details tied to an identified patient.
- Insurance information.
- Any aggregated dataset where re-identification is feasible (the [HIPAA Security Risk Analysis](../security/hipaa-security-risk-analysis.md) §6 discusses the line we draw).

**Examples — non-PHI Restricted.**

- Pharmax production credentials: AWS access keys, database passwords, KMS-derived material, Stripe live keys, Clerk secret keys, Resend API keys, carrier API keys.
- Encryption keys and key material in any form, including wrapped DEKs and KMS key identifiers tied to a specific tenant.
- Recovery codes for any privileged MFA account.
- Tenant-derived material that would let an attacker re-derive a tenant's blind-index hashes (see ADR 0010 — search keys are derived per-tenant per-purpose).

#### 3.4.1 Storage requirements — Restricted

PHI in the Pharmax database is **envelope-encrypted per field** with per-tenant Key-Encryption-Keys held in AWS KMS, per ADR 0005:

- Plaintext PHI never sits on disk in cleartext form. The Prisma column types are `*Enc Json` for the AEAD envelope and `*Bi String?` for the deterministic blind index used for search (ADR 0010).
- Each PHI write generates a fresh per-record Data Encryption Key (DEK), encrypts the field with AES-256-GCM, wraps the DEK with the per-tenant KEK, and stores the envelope `{v, alg, kek, wDek, iv, ct, tag}`. The AAD binds the ciphertext to `{tenantId, table, column, recordId}` so a ciphertext cannot be moved across rows without surfacing as `AuthorizationError(AAD_MISMATCH)`.
- KEKs are AWS KMS customer-managed keys (CMKs) once `AwsKmsAdapter` lands; until then, the codebase fails closed in `NODE_ENV=production` against the `LocalKmsAdapter`. See [`../security/encryption-overview.md`](../security/encryption-overview.md) and `../RUNBOOK.md` §"Rotating a KMS data key".
- Per-tenant key derivation means a leaked envelope from tenant A cannot decrypt tenant B's data and a leaked tenant blind-index hash cannot be re-used against another tenant's data (ADR 0010).

Other Restricted material:

- Production credentials live in **AWS Secrets Manager** for runtime use, and in **1Password** for human use. They do not live in environment files committed to a repository, in CI variables that survive past a single run, or in personal note-taking apps. Detail in [`../security/secrets-management.md`](../security/secrets-management.md).
- Carrier credentials (EasyPost / FedEx / UPS API keys) live in the per-tenant `carrier_credential` table, envelope-encrypted with the same scheme as PHI (AAD binds the row id, so rebinding silently is forbidden). See `../RUNBOOK.md` §"Rotating a carrier credential".

Personal devices may **never** store Restricted material at rest. The operator console renders PHI on the screen during a session — that is allowed in-process display; saving PHI to local disk is forbidden.

#### 3.4.2 Transmission requirements — Restricted

- TLS 1.2 or higher, always. AWS-internal traffic between our services and managed AWS services (RDS, S3, KMS) uses the AWS internal network with TLS where applicable; the application enforces TLS at the edge.
- Webhook payloads from external systems (Stripe, EasyPost, carrier portals) are validated by signature before processing, per ADR 0014 and the inbound-webhook hardening in `../ARCHITECTURE_PRINCIPLES.md` §B.5.
- PHI is never sent over email or chat. The defense matches the [Acceptable Use Policy](./acceptable-use-policy.md) §6.1 and §7.
- A patient receives a notification via Resend (or equivalent transactional email service); the notification template uses initials and order reference rather than full PHI where possible, and the templates are reviewed for minimum-necessary content.

#### 3.4.3 In use — Restricted

PHI is in process memory during request handling. The defenses are:

- Pino's `redact` allowlist strips known PHI field names before log lines are emitted (see `../OBSERVABILITY.md`).
- Sentry's `beforeSend` allowlist further restricts what reaches the error tracker (`apps/web/src/server/observability/sentry-scrubber.ts`).
- Browser session replay (`replaysSessionSampleRate`) is **disabled** so a frame doesn't accidentally capture an on-screen patient name. Recorded in `../OBSERVABILITY.md` §"Layer 2 — Sentry".
- The patient-search workflow is blind-index-only per ADR 0010; broad decrypted PHI search is forbidden by `.cursor/rules/02-security-compliance.mdc` and by the absence of an API surface that would allow it.

#### 3.4.4 Retention — Restricted

- **PHI:** retained for the period the BAA with the covering customer requires, defaulting to the duration of the customer relationship plus the period required by state pharmacy law (commonly 5–10 years depending on jurisdiction) and HIPAA documentation retention (six years from later of creation date or last effective date per 45 CFR § 164.530(j)). The longer of the applicable obligations applies.
- **Credentials and secrets:** retained for the period the secret is in use plus 90 days after rotation, then destroyed. Rotation cadence is per secret class in [`../security/secrets-management.md`](../security/secrets-management.md).

#### 3.4.5 Disposal — Restricted

PHI is disposed of via **crypto-shredding**, not row deletion (ADR 0005):

- A tenant-offboarding event schedules deletion of the tenant's KEK in AWS KMS (minimum 7-day delay; this is the AWS protected window and we accept it). After the window elapses, the KEK is gone and every envelope encrypted under it is unreadable. The rows remain for foreign-key integrity but the ciphertexts are functionally destroyed.
- An individual right-to-be-forgotten request executes `planCryptoShred` against the patient's rows, which nulls the `*Enc` and `*Bi` columns; the row stays for FK integrity, the ciphertexts and blind indexes are gone. The intent reason vocabulary is frozen: `RIGHT_TO_BE_FORGOTTEN`, `TENANT_OFFBOARD`, `DATA_RETENTION_EXPIRY`, `PATIENT_DECEASED_RECORD_CLOSE`. See `packages/crypto/src/shred.ts`.
- Credentials are disposed of by rotating the issuing system (AWS, Stripe, etc.) and removing the secret from AWS Secrets Manager and 1Password. The previous value is overwritten in place; AWS does not retain prior secret-value versions past the audit period.

## 4. Tagging and labeling

We do not use cryptographic data-classification tags (no DLP labels on documents, no MIME-extension tagging). The classification is **implicit** in:

- Where the data lives (Pharmax DB → PHI; Pharmax private repo → Confidential; marketing site → Public).
- What table the data is in (any `*Enc` / `*Bi` column → Restricted PHI).
- What channel the data is moving on (operator console → PHI is permissible; Slack → PHI is forbidden).

The implicit-classification model relies on humans following the AUP. The compensating control is that PHI cannot, by construction, leave the database in cleartext: the envelope encryption + the Pino redactor + the Sentry allowlist mean that even an accidental log line is `[Redacted]`, not patient name.

## 5. Search on Restricted data

Search on PHI is a controlled affordance, not a general-purpose query surface. The pattern, per ADR 0010:

- Add a deterministic **blind-index column** (`*Bi`) next to each searchable `*Enc` column.
- The blind index is HMAC-SHA-256 over a normalized form of the plaintext, keyed by a per-tenant per-purpose search key derived from the tenant KEK via HKDF.
- Search at the application layer is an equality query on `(organizationId, *Bi)` — sub-millisecond, no scan, no decrypt fan-out.
- The caller MUST disambiguate hash collisions with a secondary check (DOB + name, name + MRN, etc.). Trusting a single BI hit is a security bug.
- Fuzzy / partial / phonetic search is **not supported**. The search UX is "type at least three characters of the last name AND the DOB."

We will not build a broad decrypted PHI search. The classification policy and the engineering choice align: Restricted data does not get scanned in cleartext.

## 6. Right-to-be-forgotten and tenant offboarding

The disposal mechanism for individual right-to-be-forgotten requests and tenant offboarding is the **crypto-shred** path (§3.4.5). The mechanics:

1. The legal request arrives. The compliance lead validates it (identity verification, the request matches the scope the regulation grants).
2. The request is converted to a `planCryptoShred` call against the affected rows or the tenant's KEK.
3. The shred plan is executed inside a command-handler transaction so the storage write, audit row, and outbox event commit atomically.
4. The audit row records the reason code (frozen vocabulary), the actor, and the affected scope. The outbox notifies downstream systems (e.g. analytics) so they can also drop the data.
5. For a tenant-wide offboarding, the KEK deletion is scheduled in AWS KMS with the minimum 7-day pending window. The deletion is logged in our internal change calendar so we can communicate to the customer when their data is irrecoverable.

The crypto-shred is irreversible. There is no recovery path for a shredded record. The compliance lead is responsible for confirming the request is genuine before the plan is executed.

## 7. Data location and cross-border

Pharmax runs in AWS regions in the United States. PHI does not transit, at rest or in flight, to AWS regions outside the United States. The boundary is enforced by:

- The AWS Organization's Service Control Policies (which deny resource creation in non-US regions).
- The S3 buckets being region-locked to a US region.
- The RDS instances being provisioned in a US region.
- The Cloudfront / ALB front door being configured for US regions only.

A future multi-region posture is captured in ADR 0022 (Proposed); when that lands, the classification policy is amended to reflect the regional split.

## 8. Cross-references

- [Information Security Policy](./information-security-policy.md) — the management-system parent.
- [Acceptable Use Policy](./acceptable-use-policy.md) — what humans may do with each tier.
- [Access Control Policy](./access-control-policy.md) — who may access each tier.
- [`../security/encryption-overview.md`](../security/encryption-overview.md) — encryption posture for Restricted at rest, in transit, in process memory.
- [`../security/secrets-management.md`](../security/secrets-management.md) — credential storage and rotation.
- ADR 0005 — Envelope encryption per PHI field with AAD binding.
- ADR 0010 — Blind indexes for PHI search.
- ADR 0006 — Hash-chained audit log per tenant.
- `.cursor/rules/02-security-compliance.mdc` — engineering invariants for PHI handling.

## Revision history

| Version | Date       | Author | Change           |
| ------- | ---------- | ------ | ---------------- |
| 0.1     | YYYY-MM-DD | CTO    | Initial drafting |
