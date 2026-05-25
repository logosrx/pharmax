# Pharmax Architecture Principles

This document is the durable reference for **how** Pharmax patterns
differ from — and improve on — the upstream telehealth/EHR codebase
(EONPRO) that inspired several of them. Each pattern we adopt gets
five universal upgrades applied; each domain pattern gets specific
enterprise hardening. See `IMPLEMENTATION_PLAN.md` for sequencing
and `.cursor/rules/` for the non-negotiables this document elaborates.

The principles here are **not aspirational**. Every rule below is
expected to ship by Phase 2 and to be enforced by tooling (lint,
schema linter, CI, migration linter, PR template).

---

## A. The five universal multipliers

Every pattern lifted from EONPRO gets these five upgrades applied
uniformly. Codifying them in `.cursor/rules/` and ESLint boundaries
makes them automatic rather than per-PR judgment calls.

| #   | Multiplier                                   | EONPRO baseline                            | Pharmax target                                                                                              |
| --- | -------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| 1   | **Two-layer enforcement** (app + DB)         | App-layer `prisma-with-clinic-filter` only | App-layer Prisma extension **plus** Postgres Row-Level Security policies with session-set tenant GUC        |
| 2   | **Append-only audit with hash chaining**     | Per-row SHA-256 hash                       | Per-row hash **chained** to previous row + daily Merkle root signed by KMS + WORM offload to S3 Object Lock |
| 3   | **Envelope encryption with per-tenant KEK**  | Single DEK from `ENCRYPTION_KEY`/KMS       | Per-record DEK, wrapped by per-tenant KEK in AWS KMS — enables crypto-shred + per-tenant key rotation       |
| 4   | **Workflow policy as versioned data**        | `Order.status: String?` (free-form)        | `workflow_policy` table; every verification/transition row stores `workflow_policy_id + version`            |
| 5   | **Idempotency keyed by request fingerprint** | Key → response                             | `(idempotency_key, caller_id, body_hash)` — collision returns `409 Conflict`, never silent overwrite        |

Apply these five to every pattern below.

---

## B. Per-pattern enterprise upgrade

### B.1 Tenancy isolation

| Aspect                      | EONPRO                                                | Pharmax enterprise                                                                                                                                             |
| --------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resolution                  | URL subdomain → JWT → cookie                          | Session principal carries `{organizationId, siteId, clinicId, teamId, bucketScope, workstationId}`; URL is presentation-only                                   |
| Filter                      | App-layer Prisma proxy                                | App-layer extension **plus** Postgres RLS policies (`USING (organization_id = current_setting('pharmax.organization_id')::uuid)`)                              |
| Bypass                      | `BYPASS_CLINIC_FILTER=true` env, hard-blocked in prod | `withSystemContext()` is per-call only, records reason + actor in `audit_log` every time                                                                       |
| Cross-tenant leak detection | Re-checks result set after query                      | Same **plus** PgAudit logs every query that touched > 1 tenant **plus** chaos test injecting fake clinic GUC weekly                                            |
| Test surface                | Some unit tests                                       | Anti-leak **property test** that runs 100 parallel queries across N orgs and asserts cardinality (already implemented in `@pharmax/tenancy/anti-leak.test.ts`) |

Owner package: `@pharmax/tenancy`. RLS migration lands as part of
Phase 2's first migration.

### B.2 RBAC

| Aspect                  | EONPRO                                             | Pharmax enterprise                                                                                                                                                             |
| ----------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ------ | ---- | --------------------------------------------------------------------------------------------------------------- |
| Catalog                 | Hardcoded `PERMISSIONS` constant                   | Hardcoded **registry** + `permission` table seeded from it; admin UI grants from the table; parity is asserted by `permissions.test.ts`                                        |
| Roles                   | 9 hardcoded roles                                  | Same registry pattern + `role` table seeded from `role_template` constants; per-tenant custom roles allowed                                                                    |
| Overrides               | `User.permissions: Json` with `{granted, revoked}` | Same model **plus** every override row records `granted_by_user_id`, `expires_at`, `reason_code`                                                                               |
| Scoping                 | Flat (clinic-wide)                                 | Permissions scoped to `(organization                                                                                                                                           | site | clinic | team | bucket)`— a user can be`pharmacist`on clinic A but`tech`on clinic B; already implemented in`appliesInContext()` |
| Separation of Duties    | None                                               | Hardcoded SoD rules: same user cannot perform `PV1_APPROVE` and `FINAL_APPROVE` on the same order; enforced by command bus via `@pharmax/rbac` SoD module                      |
| Features (capabilities) | None separately                                    | Parallel `FEATURES` registry for capability flags (`telehealth_callbacks`, `package_photos`, `easypost_outbound`) — distinct from action permissions                           |
| Break-glass             | `emergency: true` flag in audit                    | Time-limited grant (max 4h), force-audit `BREAK_GLASS` event, auto-revoke job, daily report to security@                                                                       |
| Caching                 | None (compute every check)                         | Effective permission set computed per-request, cached in WeakMap keyed on the frozen `TenancyContext` object — already implemented in `resolver.ts`                            |
| Admin UI introspection  | None                                               | `getEffectivePermissionsWithSource()` returns each permission with `source: 'role_default' \| 'override_granted' \| 'override_revoked' \| 'not_available'` for the role editor |

Owner package: `@pharmax/rbac`. Permission registry, scoped grant
matching, resolver, and the primary `requirePermission` guard are
already in place. The four enterprise upgrades — SoD, features,
break-glass, source-aware effective view — are the next increment.

### B.3 Audit

| Aspect            | EONPRO                         | Pharmax enterprise                                                                                                                                          |
| ----------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tables            | `AuditLog` + `HIPAAAuditEntry` | `audit_log` (firehose) + `hipaa_audit_entry` (PHI access) + `command_log` (every command) + `order_event` (workflow truth) — split already exists in schema |
| Tamper evidence   | SHA-256 per row                | SHA-256 **chained**: `hash = sha256(prevHash ‖ canonicalRow)`; per-tenant chain state in `audit_chain_state`                                                |
| Retention         | Index-only                     | Daily partition, 7-year retention, monthly Merkle root written to S3 Object Lock with KMS asymmetric signature                                              |
| Write enforcement | Application code               | Postgres role `pharmax_app` has `INSERT` only on audit tables; `UPDATE`/`DELETE` revoked at the role level                                                  |
| PII in audit      | Free-form `metadata Json`      | Schema-validated against a registry; `details` redacted by Pino allowlist before insert                                                                     |
| Query path        | Same table as writes           | Read replica + materialized aggregates for compliance reports                                                                                               |

Owner package: `@pharmax/platform-core/audit` (chain writer) + the
schema split in `prisma/schema/audit.prisma`. Chain writer must
exist before the first PHI write in Phase 2.

### B.4 PHI encryption + search

| Aspect                | EONPRO                                         | Pharmax enterprise                                                                                                                                            |
| --------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key model             | Single DEK from KMS                            | **Envelope encryption**: per-record DEK, KMS-wrapped by per-tenant KEK                                                                                        |
| Algorithm             | AES-256-GCM, random IV per encrypt             | Same **plus** AAD (additional authenticated data) = `{table, column, recordId, tenantId}` so a ciphertext cannot be moved across rows                         |
| Search on encrypted   | Fetch + decrypt + filter in memory (≤500 rows) | **Blind index columns** `_bid` = HMAC-SHA256(normalized value, per-tenant search-key) — exact match in SQL; in-memory decrypt fallback only for fuzzy queries |
| Right-to-be-forgotten | Manual record delete                           | **Crypto-shred**: delete the record's DEK in KMS → ciphertext unreadable forever, no need to rewrite tables                                                   |
| Key rotation          | Re-encrypt all rows                            | Rotate KEK only; DEKs re-wrapped lazily on next read                                                                                                          |
| Search audit          | Not separately logged                          | Every search query writes `hipaa_audit_entry` with hashed search term (so we can prove who searched without storing PHI search terms)                         |

Owner package: `@pharmax/crypto` (new, Phase 1 after `@pharmax/rbac`).
Must be in place **before** the Patient model lands in Phase 2 —
retrofitting envelope encryption after live PHI is a multi-week
project.

### B.5 Webhook handling (inbound and outbound)

| Aspect            | EONPRO                                                                    | Pharmax enterprise                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Inbound auth      | Basic auth, password matched against decrypted clinic field (linear scan) | HMAC-SHA256 signature with timestamp skew window (±5 min); credential lookup by `kid` header (O(1)), not iterating clinics                                                     |
| Idempotency key   | `messageId`                                                               | `(source, messageId, body_hash)`                                                                                                                                               |
| Body size         | `MAX_WEBHOOK_BODY_BYTES` enforced in handler                              | Enforced at the ALB/CloudFront edge with a 413 before the function spins up                                                                                                    |
| Schema            | Inline parsing                                                            | Zod schemas per `(source, event_type, version)`; unknown versions return `426 Upgrade Required`                                                                                |
| Replay safety     | Stored raw payload                                                        | Same **plus** the wire log stores response so a replay returns the exact same body (true at-least-once → exactly-once semantics)                                               |
| Outbound delivery | Not visible in EONPRO                                                     | Outbox table → worker → HTTP POST with HMAC + sequence number; per-receiver circuit breaker; exponential backoff with jitter; dead-letter after N attempts; manual replay tool |
| Versioning        | Endpoint URL `/v1/...`                                                    | Same **plus** `Sunset:` header + `Deprecation:` header when v2 is live; receivers get 90-day notice                                                                            |

Owner: `@pharmax/platform-core/webhooks` (inbound) +
`apps/worker` (outbound dispatcher).

### B.6 Workflow / commands

| Aspect                | EONPRO                                            | Pharmax enterprise                                                                                                                                                                        |
| --------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| State storage         | `Order.status: String?`                           | `Order.state: WorkflowState` enum **plus** `Order.workflow_policy_id`/`version` — every row is replayable against a specific policy version                                               |
| Command shape         | Plain async function (`cancelOrder()`)            | `defineCommand({input, requires, guards, exec, compensate})` factory that codifies the 20-step contract (validate → idempotency → lock → policy load → guards → write → outbox → commit)  |
| Concurrency           | None                                              | Optimistic `version` column on Order + `SELECT … FOR UPDATE` on the lock step                                                                                                             |
| Saga / compensation   | Inline try/catch with multiple Lifefile fallbacks | Saga registered with the command bus: each step has a compensate. `CancelOrder` saga = `[localCancel, voidPlatformFee, voidProviderComp, voidLotReservation, releaseLabel, notifyClinic]` |
| Determinism           | Status set inline in service                      | Workflow rules in a pure state machine `(state, command) → (newState, events[])`; command handler is a thin wrapper. Replay possible from `command_log`                                   |
| Build-time validation | None                                              | TypeScript exhaustive switch over `WorkflowState`; CI step asserts every state appears in the policy graph                                                                                |

Owner: `@pharmax/command-bus` (new, Phase 1 before
`CreateOrganization`) + `@pharmax/workflow` (Phase 2).

### B.7 Integration credentials

| Aspect     | EONPRO                               | Pharmax enterprise                                                                                            |
| ---------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Storage    | 30+ `<service>*` columns on `Clinic` | Separate `integration_credential` table keyed by `(organization_id, integration_kind, name)`                  |
| Encryption | Column-level by app code             | Column-level using the envelope scheme (B.4), AAD = `{table, integration_kind, organization_id}`              |
| Versioning | Single live cred                     | `version` field; rotation stages `next` then promotes after health check                                      |
| Health     | None visible                         | Background job verifies each enabled integration daily; `last_verified_at` + `last_error` exposed in admin UI |
| Permission | Implicit (admin scope)               | Explicit `integration:<kind>:configure` permission, separate from `integration:<kind>:read`                   |

Owner: `@pharmax/integrations` (Phase 4 with EasyPost adapter
landing).

### B.8 Reporting

| Aspect          | EONPRO                   | Pharmax enterprise                                                                                               |
| --------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Source          | Primary DB               | Logical replica or RDS read replica, routed via Prisma datasource alias                                          |
| Materialization | Cron-driven aggregations | Event-driven materialized views refreshed via `pg_cron` or worker; SLA timer events fan out to `mv_sla_breaches` |
| Reproducibility | None                     | Every `report_run` row stores SQL + params + `result_hash` so a re-run can be verified                           |
| Permissions     | Role-only                | Saved-view-level ACL on `saved_report`                                                                           |
| Export          | CSV anywhere             | Export job + S3 presigned URL with PHI redaction policy applied (aggregated vs row-level)                        |

Owner: `@pharmax/reporting` (Phase 5).

---

## C. The four foundational decisions locked in

These are reversible only at high cost. They are committed to the
plan and will land before Phase 2's PHI tables.

1. **Row-Level Security on the database.** Every tenant-scoped table
   gets a Postgres RLS policy keyed on a session GUC. We set the
   GUC in the connection middleware right after we set the
   `AsyncLocalStorage` context. App-layer Prisma extension remains
   as belt-and-braces. _Locks in B.1's two-layer enforcement._

2. **Envelope encryption with per-tenant KEK from day one.** Even in
   local dev, `encryptPHI(value, {tenantId, table, column, recordId})`
   produces a per-record DEK and wraps it. AAD is mandatory. Local
   dev uses a `LocalKmsAdapter` that emulates KMS.
   _Locks in B.4 — retrofitting after Patient is live is a
   multi-week project._

3. **`defineCommand()` factory before the first workflow command.**
   `CreateOrganization` (the next item in Phase 1) ships **through**
   `@pharmax/command-bus`, not as a plain function. Every subsequent
   command uses the same factory. We never have a "we'll harden it
   later" command. _Locks in B.6 + the 20-step contract from
   `.cursor/rules/01-workflow-safety.mdc`._

4. **Hash-chained audit before the first PHI write.** `audit_log`
   and `hipaa_audit_entry` get a `prev_hash` column and a sequence
   number per tenant. A `audit_chain_state` table per tenant tracks
   the latest hash. Inserts happen inside a `SERIALIZABLE`
   transaction or with an advisory lock per tenant. _Locks in B.3 —
   easy now, hard once we have millions of audit rows to backfill._

---

## D. Mechanisms that make the improvements automatic

Enterprise-grade sticks only when enforced by tooling, not memory.

- **ESLint boundary rules.** `@pharmax/inventory` cannot import from
  `@pharmax/billing`; `apps/web` cannot import `@prisma/client`
  directly (must go through `@pharmax/database`);
  `withSystemContext` import is allowed only in
  `packages/{tenancy,workers}/...`.

- **Schema linter on `prisma/schema/*.prisma`.** Forbid `String?`
  where an enum or FK exists. Require an index on every FK. Require
  `@@map` snake_case. Require `organizationId` on every model not in
  a documented allowlist.

- **Command linter.** Every new file under `packages/*/commands/*.ts`
  must export a `defineCommand` call. A CI step parses the AST and
  fails the build otherwise.

- **Migration linter.** Every new migration must include either an
  `RLS policy` block or an entry in `migrations/rls-exempt.txt` with
  a justification.

- **PR template checkboxes.** PHI access? Command bus? Audit chain?
  RLS? Idempotency key? Review cannot proceed without explicit
  answers.

- **`docs/control-matrix.md`** (lands with Phase 5 compliance work)
  cross-referencing each non-negotiable rule from
  `.cursor/rules/01-workflow-safety.mdc` to the package, file, and
  test that enforces it.

---

## E. What we deliberately do NOT copy from EONPRO

These EONPRO patterns are explicitly out of scope for Pharmax.
Recording them here so future contributors don't reintroduce them.

| EONPRO anti-pattern                                                      | Why it bites                                                  | Pharmax alternative                                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `@ts-nocheck` in production code because schema lagged code              | No type safety on the hot path                                | Schema-first: migration lands **before** code                                       |
| Direct `prisma.order.update({status: 'cancelled'})` in services          | Bypasses command-bus / row lock / idempotency / outbox        | All status changes through `@pharmax/command-bus`                                   |
| 200+ ad-hoc markdown audit reports at repo root                          | Snapshot debt instead of source-of-truth control matrix       | Single living `docs/` set + per-PR review                                           |
| Subdomain-as-tenant resolution as the only path                          | Brittle on local dev; doesn't compose with bucket/workstation | Resolve org/site/clinic/team/bucket from session + workstation cert, not URL        |
| Deprecated global `globalForClinicContext` still present                 | Race condition vector in serverless                           | `@pharmax/tenancy` is AsyncLocalStorage-only from day one                           |
| `domains/` folder mixed with `lib/` and `services/`                      | No single rule for where new code goes                        | `packages/<bounded-context>` with explicit `package.json` and ESLint boundary check |
| `Order.status: String?` free-form                                        | Drift; no exhaustive switch                                   | `WorkflowState` enum referenced from `workflow_policy`                              |
| No SLA interval recorder — only timestamps                               | Can't answer "WAIT vs ACTIVE time on PV1"                     | `@pharmax/sla` writes discrete `OrderStageInterval` rows                            |
| Microservices roadmap ("extract auth service, extract patient service…") | Premature for ~20 engineers; breaks tx boundaries             | `.cursor/rules/00-project-overview.mdc` explicitly forbids premature microservices  |
| Mix of `Number IDs` and `cuid` IDs                                       | Inconsistent                                                  | ULID monotonic IDs everywhere (`@pharmax/platform-core/ids`)                        |
| Webhook handler logic inline in `route.ts`                               | Hard to test, retry, replay                                   | `route.ts` → command bus → worker drains outbox                                     |
