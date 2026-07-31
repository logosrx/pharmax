# Break-Glass Schema

> **Status: LANDED.** The tables below exist in `prisma/schema.prisma`
> (`BreakGlassSession` / `BreakGlassAction`) via the migration
> `prisma/migrations/20260731000000_phase5_break_glass_session/`. The
> `BreakGlassSessionHandle` and `runAs(...)` API in
> [`break-glass-session.ts`](./break-glass-session.ts) remains wired against the
> `BreakGlassClient` port (testable with a fake); the production adapter is
> [`PrismaBreakGlassClient`](./prisma-break-glass-client.ts). This document is
> retained as the design rationale.

## Why a separate session table

The existing time-limited `BreakGlassGrant` in `@pharmax/rbac/break-glass.ts`
covers the case "raise one specific actor's privileges for one specific
permission for ≤4h". That is the right tool for an admin temporarily
granting another operator `pv1.approve` to cover a shift.

What it does NOT cover:

- A platform engineer opening a `pharmax_system` Postgres context to perform
  cross-tenant forensic queries, repair a stuck order under RLS bypass, or
  triage a tenant-isolation incident.
- Recording the EXACT sequence of commands / queries executed while the
  bypass was active.
- Tying every command to the originating change ticket / incident.

This is a different threat model: not "this user can now do action X", but
"this engineer has the keys to everything for the next N minutes — show me
exactly what they did with them."

## Required tables

### `break_glass_session`

Lifecycle row for one bypass session.

| Column               | Type         | Notes                                                                                                |
| -------------------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| `id`                 | uuid (PK)    | ULID encoded as uuid; sortable by open time.                                                         |
| `requestedByUserId`  | uuid         | FK → `user(id)`. The engineer who initiated the bypass.                                              |
| `approvedByUserId`   | uuid?        | FK → `user(id)`. Second engineer (four-eyes). NULL until approval lands.                             |
| `ticketUrl`          | text         | REQUIRED. Link to the incident / change ticket. Stored verbatim.                                     |
| `reason`             | text         | REQUIRED. Free-form summary. PHI-safe (no patient names — enforced by Pino redaction at write time). |
| `openedAt`           | timestamptz  | When the session was opened. Defaults to `now()`.                                                    |
| `closedAt`           | timestamptz? | When the session was finalized. NULL while open.                                                     |
| `resolution`         | text?        | Final summary written at close time. Required when `closedAt` is set.                                |
| `maxDurationMinutes` | int          | Hard cap; sessions auto-close when `openedAt + INTERVAL '... minutes'` lapses. Default: 60.          |
| `createdAt`          | timestamptz  | `now()`. Audit trail.                                                                                |

**RLS:** this table is **not** tenant-scoped (sessions cross all tenants by
definition). Read access is restricted to `pharmax_system` and to a future
`SecurityOfficer` role. Insert/update gated to the application user via a
narrow stored procedure.

**Indexes:**

- `(closedAt) WHERE closedAt IS NULL` — fast lookup of open sessions for the
  nightly digest.
- `(openedAt DESC)` — recent sessions report.

### `break_glass_action`

One row per database operation executed inside the session. The
`BreakGlassSessionHandle.runAs()` method writes one of these per call.

| Column         | Type        | Notes                                                                                       |
| -------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `id`           | uuid (PK)   | ULID encoded as uuid.                                                                       |
| `sessionId`    | uuid        | FK → `break_glass_session(id)`. Cascade delete is **disallowed**; sessions are append-only. |
| `actionLabel`  | text        | Caller-supplied short label (e.g. "lookup_user_by_email", "advance_order_status").          |
| `parameters`   | jsonb       | PHI-redacted parameters. Caller is responsible for redaction.                               |
| `success`      | boolean     | Outcome of the wrapped transaction.                                                         |
| `errorMessage` | text?       | When `success = false`, the error class+message. PHI-safe.                                  |
| `commandLogId` | uuid?       | When the action dispatched a command, the resulting `command_log.id`.                       |
| `startedAt`    | timestamptz |                                                                                             |
| `completedAt`  | timestamptz |                                                                                             |
| `createdAt`    | timestamptz | `now()`.                                                                                    |

**RLS:** same as `break_glass_session`. `INSERT` only — `UPDATE`/`DELETE`
revoked at the role level.

**Indexes:**

- `(sessionId, startedAt)` — replay one session's actions in order.
- `(commandLogId)` — join back to the standard command log for actions
  that went through the bus.

## Audit surface

The audit chain (`audit_log`) and outbox (`event_outbox`) are org-scoped by
construction — every row carries a non-nullable `organizationId` and the
chain is hashed per tenant. A break-glass session crosses ALL tenants by
definition, so it has no home chain to append to. Rather than invent a
synthetic "platform org" (which would weaken the per-tenant chain
semantics), the evidence model is:

- `break_glass_session` / `break_glass_action` are THEMSELVES the
  append-only ledger: `DELETE` is granted to neither application role on
  either table, `UPDATE` is granted only on the session row (for the
  close write), and `break_glass_action` is INSERT-only.
- Every session opened in the last 24 h surfaces in the **nightly
  security digest** (`compose-nightly-security-digest.ts` →
  `BreakGlassSessionProbe`), which is delivered to the operator security
  distribution list and logged as structured SOC 2 evidence.
- Every session opened in the quarter surfaces in the **quarterly
  access-review evidence pack** (`apps/worker/src/compliance/
access-review-job.ts`), which is published to the write-once evidence
  archive.
- Actions that dispatched a command carry `commandLogId`, joining the
  bypass back into the standard per-org `command_log` / `audit_log`
  trail for the tenant it touched.

An immediate Slack/pager ping on session open remains a separate Lane 4
deliverable.

## Migration

Landed as `prisma/migrations/20260731000000_phase5_break_glass_session/`.
Role grants (append-only posture) and the RLS exemption rationale live in
the migration file and `prisma/migrations/rls-exempt.txt`; the Prisma
tenancy extension excludes both models from auto-scoping
(`TENANT_EXCLUDED_MODELS` in `@pharmax/tenancy`).
