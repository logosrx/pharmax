# Data Flow

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

This document is the narrative answer to the auditor's question "show me where PHI lives and how it moves through your system, at every stage from ingestion to display, and tell me how each transition is protected." It complements [`encryption-overview.md`](./encryption-overview.md) (the cryptography) by walking the operational path.

This document maps to:

- SOC 2 **CC6.1** (logical access protection at each transition), **CC6.6** (transmission protection), **CC6.7** (restriction of access).
- HIPAA **45 CFR § 164.312(a)(1)** (access control), **§ 164.312(c)(1)** (integrity), **§ 164.312(e)** (transmission security).

## 2. The high-level picture

```
                          ┌─────────────────┐
                          │  Pharmacy       │
                          │  operator       │
                          │  (workstation)  │
                          └────────┬────────┘
                                   │ HTTPS (TLS 1.2+)
                                   │ Clerk session cookie
                                   ▼
                          ┌─────────────────┐
                          │  apps/web       │     ─── reads ──▶ Clerk (authn)
                          │  (Next.js)      │
                          │  PHI in-process │     ◀── webhook ─ Stripe
                          │  during render  │     ◀── webhook ─ EasyPost
                          └────────┬────────┘
                                   │ Prisma over TLS
                                   │ pharmax_app role
                                   │ RLS + tenant GUC
                                   ▼
       ┌────────────────────────────────────────────────────────────┐
       │  PostgreSQL (AWS RDS, Multi-AZ, at-rest AES-256)            │
       │                                                              │
       │  patient.firstNameEnc       (envelope {v, alg, kek, wDek,    │
       │                              iv, ct, tag})  ◀────┐           │
       │  patient.firstNameBi        (HMAC-SHA-256)        │           │
       │  ...                                              │           │
       │  audit_log (hash-chained)                         │           │
       │  command_log, order_event, event_outbox          │           │
       └──────────────────┬────────────────────────────────┼───────────┘
                          │                                │
                          ▼                                │
                  ┌───────────────┐                        │
                  │  apps/worker  │ ── drains outbox ──▶  ┌┴────────────┐
                  │  (Node)       │ ── posts to ─────────▶│  AWS KMS    │
                  │  PHI in proc  │                       │  per-tenant │
                  │  on drain     │                       │  KEKs       │
                  └───────┬───────┘                       └─────────────┘
                          │ HTTPS (TLS 1.2+)
                          │ vendor signature on outbound
                          ▼
              ┌──────────────────────┐
              │  Stripe / EasyPost / │
              │  Resend / observability vendor / etc. │
              └──────────────────────┘
```

PHI is plaintext in only four places along this picture:

1. The operator's screen during the session.
2. `apps/web` process memory during the request.
3. `apps/worker` process memory during outbox handling.
4. The downstream vendor's system, scoped to what the BAA permits.

Everywhere else PHI is either an envelope ciphertext (the RDS storage) or never PHI in the first place (Sentry, log aggregator, every internal channel).

## 3. Ingestion

PHI enters Pharmax via four channels:

### 3.1 Channel A — operator entry

An operator types a new patient or new prescription into the operator console:

1. The form runs in the operator's browser. PHI exists in the React component state on the operator's device for the duration of the session. Browser session replay is **disabled** so this transient state is never captured.
2. The form submits over HTTPS to an API route in `apps/web`. The request body carries the PHI fields in plaintext (this is the in-transit moment — TLS protects the wire).
3. The API route resolves `TenancyContext` via `resolveOperatorTenancyContext()` (ADR 0015), confirming the operator's Clerk session, the operator's Pharmax `User` row, and the `(organizationId, ...)` scope.
4. The route dispatches a command (e.g. `CreatePatient`, `AddPrescription`) through the command bus per ADR 0007.
5. The command handler — inside the transaction — calls `encryptField(value, {tenantId, table, column, recordId})` for each PHI field. The construction is per [`encryption-overview.md`](./encryption-overview.md) §2.2.1.
6. The encrypted envelope is written to the `*Enc Json` column. The blind index is computed by `blindIndex(value, {tenantId, purpose})` and written to the `*Bi String?` column.
7. The audit row, command log row, order event row, and outbox row are written in the same transaction. The audit row's `metadata` is schema-validated and PHI-redacted before insert.
8. The transaction commits. The plaintext PHI exists in process memory until the request handler returns and the garbage collector reclaims it; DEK plaintext is zeroed eagerly.

### 3.2 Channel B — inbound webhook from a third party

A vendor sends a webhook containing PHI-adjacent data (a shipment update, a payment event with customer reference):

1. The webhook arrives at the API edge over HTTPS.
2. The route handler verifies the vendor signature (Stripe: `stripe-signature` header; EasyPost: HMAC; etc.) and writes the raw event to the inbound-event table (`stripe_webhook_event`, `easypost_webhook_event`) inside a system-context transaction. The raw payload is stored; this is the audit copy.
3. The worker drain claims the event row (`UPDATE ... FOR UPDATE SKIP LOCKED` per `../BILLING.md`).
4. The handler dispatches a command (e.g. `MarkInvoicePaid`, `RecordShipmentEvent`) through the command bus per ADR 0014.
5. Same as Channel A from step 5 onward — encryption, audit, outbox, commit.

Stripe webhooks intentionally do not carry patient PHI by our design (see [`../governance/vendor-inventory.md`](../governance/vendor-inventory.md)). EasyPost webhooks carry recipient addresses, which are PHI by linkage and are handled as such.

### 3.3 Channel C — operator import or paste

Bulk import flows (e.g. a CSV of patients from a customer's existing system) follow Channel A's path with the addition of a per-row dispatch through the command bus. There is no bypass: the import is not "INSERT INTO patient" — it is a loop of `CreatePatient` commands. Each row goes through encryption, audit, and outbox.

### 3.4 Channel D — system identity dispatch

Internal scheduled jobs (e.g. an SLA-breach reconciliation that emits an event) execute in system context per ADR 0004 and ADR 0009. They are not PHI-introducing; they read existing PHI in the course of producing aggregate outputs. The read path is described in §5.

## 4. At rest

### 4.1 Where the PHI ciphertexts live

- **Per-record envelopes** live in the `*Enc Json` columns of PHI-bearing tables. The envelope is `{v, alg, kek, wDek, iv, ct, tag}` per [`encryption-overview.md`](./encryption-overview.md) §2.2.1.
- **Per-record blind indexes** live in the `*Bi String?` columns. Deterministic HMAC; per-tenant per-purpose isolation.
- **Per-tenant KEKs** live in **AWS KMS**, never in Pharmax-owned storage.
- **Audit log rows** live in `audit_log`, hash-chained per tenant per ADR 0006. Audit metadata is PHI-redacted before insert.
- **Command log, order event, event outbox** live in their respective tables, scoped to the tenant via RLS, with PHI never written in plaintext into their `metadata`/`payload` fields.

### 4.2 Where the PHI ciphertexts go for backups

- **RDS automated backups + PITR** retain a continuous-recovery window (typically 35 days). Snapshots are encrypted with AWS KMS at the storage layer.
- **Manual snapshots** are taken weekly and retained for 90 days, also KMS-encrypted.
- **No PHI in CSV exports**, no `pg_dump` against the production primary, no PHI flowing into a developer's local SQLite. The development environment uses synthetic data per [Acceptable Use Policy](../policies/acceptable-use-policy.md) §6.5.

### 4.3 Where the PHI ciphertexts replicate

- **RDS Multi-AZ** maintains a standby in a second AZ in the same region. The standby is encrypted at rest with the same KMS key.
- **Read replicas** for reporting (when introduced per `../ARCHITECTURE_PRINCIPLES.md` §B.8) inherit the at-rest encryption.
- **No cross-region replication of PHI today** — the deferred ADR 0022 covers multi-region tenancy and will revisit this.

## 5. Retrieval and display

### 5.1 The read path

An operator opens a patient record:

1. The operator navigates in the operator console; the browser issues an HTTPS request with the Clerk session cookie.
2. `apps/web` resolves `TenancyContext` (per §3.1 step 3).
3. The route handler reads the patient row via Prisma. The query carries the `(organizationId, ...)` scope; RLS at the database enforces it independently per ADR 0004.
4. The handler decrypts the requested PHI fields via `decryptField(envelope, {tenantId, table, column, recordId})`. The AAD binding ensures the envelope hasn't been moved across rows; an AAD mismatch surfaces as `AuthorizationError(AAD_MISMATCH)`.
5. The decrypted PHI is included in the response, rendered to the operator's browser DOM, and visible on the operator's screen.

### 5.2 The search path

An operator searches for a patient by name + DOB:

1. Operator types the search criteria (lowercased "smith" + DOB "1990-04-15"); browser issues HTTPS request.
2. `apps/web` resolves `TenancyContext`.
3. The search handler computes the blind-index hashes for each criterion: `blindIndex("smith", {tenantId, purpose: "patient.lastName"})` and `blindIndex("1990-04-15", {tenantId, purpose: "patient.dob"})`.
4. The query is `WHERE organizationId = ? AND lastNameBi = ? AND dobBi = ?`. Sub-millisecond on the `(organizationId, lastNameBi)` index, then equality-narrowed.
5. The handler returns a small candidate set. For each candidate, the displayed fields are decrypted per the read path. The caller MUST disambiguate hash collisions via a secondary check; in the standard UI flow, the operator selects the matching patient explicitly.

### 5.3 What is NOT in the read path

- **No PHI in logs.** Per `../OBSERVABILITY.md` §"Layer 1 — structured logs", logger contexts use allowlisted keys; PHI field names are in the Pino `redact` set; an accidental log statement produces `[Redacted]`.
- **No PHI in Sentry.** Per `../OBSERVABILITY.md` §"Layer 2 — Sentry", `beforeSend` allowlists drop anything outside the known-safe key list.
- **No PHI in the response cache.** Server-side response caching is disabled for PHI-rendering routes; the cache layer never sees plaintext PHI.
- **No PHI in browser local storage.** The operator console does not persist PHI client-side beyond the in-memory React component tree.

## 6. Egress

PHI leaves Pharmax-controlled systems only through these channels:

### 6.1 Egress A — to the operator's screen

The operator's screen is the canonical PHI surface. The protections:

- The operator is authenticated (Clerk) and authorized (Pharmax RBAC).
- The operator's account is bound by the [Acceptable Use Policy](../policies/acceptable-use-policy.md) §4 (no screenshots of PHI, no copy/paste outside the console, screen-privacy expectations).
- The session timeout limits the window of exposure on an unattended workstation.

### 6.2 Egress B — to vendors under BAA

PHI flows to certain vendors as part of normal operation:

- **AWS** — PHI lives in RDS, S3, KMS, runs through ECS/Fargate. Vendor BAA covers.
- **EasyPost / FedEx / UPS** — recipient addresses on shipping labels. Vendor BAA (EasyPost) covers; carrier disclosure is downstream.
- **Resend** (or equivalent) — patient-facing notification recipient address and minimal template content. Vendor BAA covers.

Each egress path has a documented vendor row in [`../governance/vendor-inventory.md`](../governance/vendor-inventory.md) and a BAA row in [`../governance/baa-tracker.md`](../governance/baa-tracker.md). The engineering switch for a PHI-flowing integration is **off** until the BAA is executed.

### 6.3 Egress C — to vendors NOT under BAA, by design

Some vendors intentionally do not receive PHI:

- **Stripe** — invoice line items and clinic billing identity, not patient identity. The `Invoice.lineItems[].description` field is required to be PHI-free by code-review convention.
- **Sentry** — only redacted contexts, allowlisted keys. The redaction layer is the defense.
- **Datadog / Honeycomb** — same redaction posture as Sentry.

The not-by-design designation is reaffirmed at the annual review and verified by the BAA-vs-integration cross-check in the quarterly access review.

### 6.4 Egress D — to a covered entity's notification (HIPAA breach)

In a breach event, PHI flows from Pharmax to the covered entity (the pharmacy customer) as part of breach notification per HIPAA 45 CFR § 164.410. The mechanics are documented in [Incident Response Policy](../policies/incident-response-policy.md) §5.

### 6.5 Egress E — to the data subject (right-of-access)

Under HIPAA 45 CFR § 164.524, individuals have a right of access to their own PHI. Pharmax facilitates customer fulfillment of access requests; the egress path is operator-mediated (the customer's pharmacy staff exports the requested record using the operator console). Pharmax does not directly fulfill patient-side requests because the covered entity is the patient's interface.

## 7. Egress NOT permitted

- **No PHI in internal Slack, email, AI prompts, screenshots, or screen recordings.** [Acceptable Use Policy](../policies/acceptable-use-policy.md) §6.1.
- **No PHI to a vendor without an executed BAA**. [BAA tracker](../governance/baa-tracker.md) §"Workflow".
- **No PHI in marketing material, customer-facing security packets, or sales decks.** Synthetic / aggregated data only.
- **No PHI in unencrypted physical media.** Crypto-shred + BAA-return are the disposal paths per [Data Classification Policy](../policies/data-classification.md) §3.4.5.

## 8. Disposal

PHI disposal happens via **crypto-shred**, not row deletion (per [`encryption-overview.md`](./encryption-overview.md) §7 and ADR 0005):

- **Individual right-to-be-forgotten** — `planCryptoShred` nulls the `*Enc` and `*Bi` columns on the affected rows; the row stays for FK integrity; the ciphertexts and blind indexes are gone.
- **Tenant offboarding** — the per-tenant KEK in AWS KMS is scheduled for deletion (minimum 7-day protected window); after the window, every envelope encrypted under that KEK is unreadable.
- **Vendor-side return / destruction** — on vendor decommissioning, the BAA termination clause is exercised; certificate of destruction is filed.

Each disposal action goes through a command handler so the audit row, the outbox event, and the storage write commit atomically.

## 9. Integrity transitions

The integrity counterpart to confidentiality:

- **Every workflow transition** writes to `audit_log` (hash-chained per ADR 0006) inside the command-handler transaction. A break in the chain is detectable post-hoc.
- **Every workflow transition** writes to `command_log` (the command invocation), `order_event` (the workflow truth), and `event_outbox` (the downstream side effect) — also inside the same transaction.
- **The order's `version` column** provides optimistic concurrency; a stale write fails the CAS at commit.
- **The blind index** lets the search path be deterministic without exposing the plaintext; integrity of the search is preserved across KEK rotation.

## 10. The deployed AWS topology

The high-level picture in §2 is the data flow; this section is the
**physical** topology produced by `infra/terraform/`. It is the answer
to "show me how the cryptography lands on real AWS resources."

```
                      Public Internet
                           │
                           │  HTTPS (TLS-1-3-2021-06)
                           ▼
                    ┌─────────────┐
                    │  WAFv2 ACL  │  AWSManagedRulesCommonRuleSet
                    │             │  + KnownBadInputs + AmazonIpReputation
                    │             │  + SQLi + per-IP rate limit
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │  ALB (443)  │  Security group: 0.0.0.0/0 → 443 only
                    └──────┬──────┘  Public subnets in 3 AZs
                           │
                           │ Forward to web target group (port 3000)
                           ▼
        ┌──────────────────────────────────────────────────┐
        │ ECS Fargate cluster — pharmax-prod-ue1-cluster  │
        │                                                  │
        │  ┌──────┐  ┌────────┐  ┌───────────────┐         │
        │  │ web  │  │ worker │  │ print-agent   │         │
        │  └──┬───┘  └───┬────┘  └───────┬───────┘         │
        │     │          │               │                 │
        │     │  Private subnets (NAT egress only)         │
        │     └──────────┼───────────────┘                 │
        └────────────────┼─────────────────────────────────┘
                         │
                         │ Each task assumes its IAM role
                         │ (no static keys, no env-var creds)
                         │
              ┌──────────┴────────────┬────────────────────┐
              │                       │                    │
              ▼                       ▼                    ▼
       ┌───────────┐         ┌─────────────┐      ┌────────────┐
       │ AWS KMS   │         │ Secrets Mgr │      │ S3         │
       │           │         │             │      │            │
       │ • data    │         │ database-url│      │ documents  │
       │   (PHI    │         │ stripe-…    │      │ (versioned │
       │    DEK    │         │ clerk-…     │      │  SSE-KMS)  │
       │    wrap)  │         │ etc.        │      │            │
       │ • search  │         │ All KMS-    │      │ audit-     │
       │   (HMAC)  │         │ encrypted   │      │ archive    │
       │ • asymm-  │         │ with        │      │ (Object    │
       │   sign    │         │ secrets-CMK │      │ Lock       │
       │ • audit-  │         │             │      │ COMPLIANCE │
       │   archive │         │             │      │ 7y, dedi-  │
       │ • rds     │         │             │      │ cated CMK) │
       │ • secrets │         │             │      │            │
       │ • docs    │         │             │      │            │
       │ • logs    │         │             │      │            │
       └───────────┘         └─────────────┘      └────────────┘

                         │
                         ▼
              ┌──────────────────────┐
              │ RDS Postgres 16      │  Multi-AZ, encrypted with rds-CMK
              │                      │  Isolated subnets (NO internet egress)
              │ pharmax_app          │  TLS forced (rds.force_ssl = 1)
              │ schema:              │  Performance Insights with rds-CMK
              │  patient.firstNameEnc│  Backup retention 35 days
              │  patient.firstNameBi │  CloudWatch logs export with logs-CMK
              │  audit_log           │
              │  ...                 │
              └──────────────────────┘
```

### The PHI read path on this topology

When an operator opens a patient record, the read path is precisely:

1. **Browser → ALB.** Operator's HTTPS request lands at the ALB. WAFv2
   inspects, rate-limits, and either passes or blocks. TLS terminates
   here.
2. **ALB → ECS web task.** ALB security group permits port 3000 to the
   ECS task security group (which only accepts ingress from the ALB SG).
   The web task lives in a private subnet — no public IP, no inbound
   internet route.
3. **ECS web task → RDS.** The task's `pharmax-prod-ue1-task-web` IAM
   role assumes itself; the Prisma client connects to RDS over TLS.
   RDS lives in **isolated** subnets — no NAT, no IGW. The
   `pharmax_app` Postgres role has RLS forced; the per-connection GUC
   (`pharmax.organization_id`) carries the tenant scope.
4. **ECS web task → KMS (data key).** The `firstNameEnc` envelope's
   wrapped DEK is unwrapped via `kms:Decrypt` against the `data` CMK
   with `EncryptionContext = { tenantId }`. The IAM grant is scoped
   to that exact CMK ARN; no other key is reachable from this role.
5. **In-process decryption.** The web task uses the unwrapped DEK to
   decrypt the field locally with AES-256-GCM. The DEK plaintext is
   zeroed eagerly. The DEK never crosses a network.
6. **ECS web task → Browser.** The decrypted field is JSON-serialized
   and returned over the same TLS connection.

The KMS unwrap is the cryptographic-floor step: a misrouted request
that lacks the tenant's `EncryptionContext` cannot decrypt — even with
the wrapped DEK and the IAM role — because AWS KMS treats the
EncryptionContext as additional authenticated data on the wrap.

### The PHI write path

The same shape, run backwards: encryption is `kms:GenerateDataKey`
against the data CMK with `EncryptionContext = { tenantId }`. The
returned DEK is used immediately, then zeroed; the wrapped DEK is
serialized into the envelope and INSERT'd into the row.

### Search

`kms:GenerateMac` against the search CMK (HMAC_256) over a normalized
plaintext + per-tenant context produces the blind-index value, which
is then compared against the precomputed `*Bi` column. The IAM grant
is scoped to the search CMK ARN only; the same task role cannot
`kms:GenerateDataKey` against the search key (different `KeyUsage`
class — AWS KMS rejects the call at the API boundary).

### Audit archive write

The worker computes a daily Merkle root, signs it via `kms:Sign`
against the asymmetric signing CMK (no `kms:Verify`, no `kms:Decrypt`),
and writes the signed JSON manifest to the audit-archive bucket. The
bucket has Object Lock COMPLIANCE — the worker IAM role has
`s3:PutObject` + `s3:PutObjectRetention` but no `s3:Delete*`, and even
with stolen credentials Object Lock would refuse a delete.

### The cross-region invariant

Per ADR 0022, **no PHI crosses a regional boundary**. The
`infra/terraform/environments/prod/us-west-2/` stack is a parallel
infrastructure footprint with its own KMS keys; envelopes encrypted
in us-east-1 are unreadable from us-west-2 and vice versa. The
Merkle-root manifest is the only cross-region data carrier, and it is
PHI-free by ADR 0005's design (the audit log records actions and
hashes — never PHI payloads).

## 11. Cross-references

- [`encryption-overview.md`](./encryption-overview.md) — the cryptographic detail.
- [`hipaa-security-risk-analysis.md`](./hipaa-security-risk-analysis.md) — the structured analysis this overview supports.
- [`control-matrix.md`](./control-matrix.md) — the controls that protect each transition.
- [`secrets-management.md`](./secrets-management.md) — the non-PHI secrets posture.
- [`../../infra/terraform/README.md`](../../infra/terraform/README.md) — the IaC that produces the deployed topology in §10.
- [Data Classification Policy](../policies/data-classification.md) — tier handling.
- [Access Control Policy](../policies/access-control-policy.md) — tenancy and RBAC.
- [`../OBSERVABILITY.md`](../OBSERVABILITY.md) — how we see the system without seeing PHI.
- [`../BILLING.md`](../BILLING.md) — Stripe inbound webhook detail.
- ADR 0004, 0005, 0006, 0007, 0010, 0014, 0015, 0022, 0023, 0024.

## Revision history

| Version | Date       | Author | Change           |
| ------- | ---------- | ------ | ---------------- |
| 0.1     | YYYY-MM-DD | CTO    | Initial drafting |
