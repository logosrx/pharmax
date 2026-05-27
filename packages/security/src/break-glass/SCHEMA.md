# Break-Glass Schema

> **This document specifies tables that DO NOT YET EXIST in `prisma/schema.prisma`.**
> The `BreakGlassSessionHandle` and `runAs(...)` API in
> [`break-glass-session.ts`](./break-glass-session.ts) is wired against a
> `BreakGlassClient` port so it can be exercised in tests with a fake.
> Promoting break-glass to production requires landing the migration described below.

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

## Audit + Outbox

`open_break_glass_session` and `close_break_glass_session` write standard
audit chain entries:

- `BREAK_GLASS_SESSION_OPENED` — actorUserId = requester, resourceType =
  `break_glass_session`, resourceId = session id, metadata = `{ ticketUrl,
maxDurationMinutes }` (PHI-safe by construction).
- `BREAK_GLASS_SESSION_CLOSED` — same shape with `{ resolution,
durationSeconds }`.

An `event_outbox` row of type `security.break_glass_opened.v1` queues a
notification fan-out (see `compose-nightly-security-digest.ts` for the
digest pipeline; an immediate Slack ping on session open is a separate
Lane 4 deliverable).

## Migration TODO

The migration name should be:

```
prisma/migrations/<timestamp>_phase5_break_glass_session/migration.sql
```

This package CANNOT land in production until that migration exists and the
RLS / role grants are in place. The interface in `break-glass-session.ts`
is shape-compatible with a future Prisma model, so the swap is mechanical
once the schema lands.
