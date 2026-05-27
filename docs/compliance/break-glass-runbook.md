# Break-Glass Runbook

Operational procedure for opening and closing a `pharmax_system`
Postgres-role session in an incident. Pairs with the Access Control
Policy (`docs/policies/access-control-policy.md`, Lane 3 deliverable)
and the code under `packages/security/src/break-glass/`.

> **Hard rule:** break-glass is a SECURITY EVENT. Every open and close
> is audited. Use it only when normal-tenancy code paths cannot
> resolve the situation — never as a convenience.

## When break-glass is appropriate

Use break-glass when **all** of the following are true:

- Normal tenant-scoped code paths cannot reach the data you need to
  diagnose or repair the issue.
- A change ticket / incident ticket exists with a documented reason.
- A second engineer is available to approve (four-eyes).
- The session can be closed within ≤ 60 minutes (default cap; hard
  ceiling 240 minutes per `BREAK_GLASS_SESSION_MAX_DURATION_MINUTES`).

If any of those is false, escalate to the security officer instead of
opening a session.

## Examples

**Valid:**

- A workflow advanced to a state the bus cannot reverse because the
  underlying domain row has been corrupted by a partial write from a
  previous incident; need to inspect cross-tenant for similar damage.
- The audit chain verifier reports a break — need to read
  `audit_log` rows from a tenant that the running operator doesn't
  belong to.
- A patient's `patient.crypto_shred` was requested mid-incident and
  blocked because the actor's clinic-scope didn't include the
  patient — need to dispatch the command as a privileged actor.

**Not valid:**

- "It's faster to run a raw query than to file a feature ticket."
- "I want to see how many orders org X has."
- "I'm testing in production-staging." — use a staging account.

## Procedure

### 0. Pre-flight (≤ 2 minutes)

- Open an incident or change ticket in the incident-management
  system if one does not already exist. Capture:
  - The problem statement.
  - The tenant(s) affected.
  - Why a tenant-scoped tool is insufficient.
- Identify the second engineer who will approve (must not be you).
- Have the close-criteria written down before opening the session.

### 1. Open the session

Run the open helper (production form lands when the
`break_glass_session` migration ships per
`packages/security/src/break-glass/SCHEMA.md`):

```ts
import { openBreakGlassSession } from "@pharmax/security";

const handle = await openBreakGlassSession({
  client: breakGlassClient,
  idFactory: () => ulid(),
  actionIdFactory: () => ulid(),
  clock: systemClock,
  session: {
    reason: "investigate audit chain break on org-acme",
    requestedByUserId: "<requester user id>",
    approvedByUserId: "<second engineer user id>",
    ticketUrl: "https://tickets/INC-1234",
    maxDurationMinutes: 60,
  },
});
```

Expected:

- A `break_glass_session` row exists with `closedAt = NULL`.
- An audit event `BREAK_GLASS_SESSION_OPENED` written.
- An outbox event `security.break_glass_opened.v1` queued.
- An immediate Slack ping to `#security-events` (Lane 4 deliverable;
  until then, manually notify the channel).

### 2. Perform the work

Every database operation goes through `handle.runAs(...)`. Do NOT use
the regular Prisma client during the session — that would skip the
per-action recording.

```ts
await handle.runAs(
  {
    actionLabel: "diagnose_audit_chain_break",
    parameters: { organizationId: "<org-uuid>" },
  },
  async (tx) => {
    // Any reads/writes against `tx` are under pharmax_system context.
    const head = await tx.$queryRaw`
      SELECT "latestSeq" FROM audit_chain_state
       WHERE "organizationId" = ${orgId}::uuid
    `;
    // ...
  }
);
```

If the action dispatched a domain command, pass the resulting
`command_log.id` as `commandLogId` so the standard observability
tools join cleanly.

### 3. Close the session

As soon as the work is done:

```ts
import { closeBreakGlassSession } from "@pharmax/security";

await closeBreakGlassSession(handle, {
  client: breakGlassClient,
  clock: systemClock,
  resolution:
    "Confirmed chain break at seq=47 on org-acme; cause: rogue migration. Filed SEV1 INC-1234.",
});
```

Expected:

- The `break_glass_session.closedAt` is non-NULL.
- An audit event `BREAK_GLASS_SESSION_CLOSED` written.
- The next nightly security digest reports the session under "Break-
  glass sessions opened in the last 24h" with `actionCount`.

### 4. Within 24 hours

- File a postmortem ticket if the work was a SEV1/SEV2 — even if no
  user-facing outage occurred, the break-glass usage itself is the
  postmortem subject.
- The security officer reviews the recorded actions on the session
  to confirm scope was respected.

## Red flags during a session

If you observe any of these mid-session, STOP and escalate:

- An action that touches a tenant other than the one named in the
  ticket.
- An action that reads PHI you don't need (broad SELECTs).
- Time pressure to extend `maxDurationMinutes` beyond 60. The hard
  ceiling is 240; pushing past 60 requires the security officer's
  explicit approval recorded in the ticket.
- The session has not advanced toward the documented close-criteria
  in the last 15 minutes. The right answer is to close, write up
  what you've learned, and re-open with a refined scope.

## What break-glass is NOT

- It is not a tool for **operational data changes** in normal
  business processes. Those go through commands and admin UI.
- It is not a tool to **bypass RBAC for routine elevation**. That is
  the @pharmax/rbac break-glass GRANT, a different primitive — see
  `packages/rbac/src/break-glass.ts`.
- It is not a tool to **work around feature gaps**. If a tenant-
  scoped feature is missing, file a ticket and ship the feature.

## References

- Code: `packages/security/src/break-glass/break-glass-session.ts`
- Schema: `packages/security/src/break-glass/SCHEMA.md`
- Errors: `packages/security/src/break-glass/errors.ts`
- Policy: `docs/policies/access-control-policy.md` (Lane 3)
- Tenancy primitives: `packages/tenancy/src/session-guc.ts`,
  `packages/tenancy/src/als.ts`
- ADRs: 0004 (multi-tenancy via RLS), 0016 (composition root), 0024
  (Merkle root signing and evidence)
