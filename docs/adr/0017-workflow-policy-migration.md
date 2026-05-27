# 0017 — Workflow policy v1 → v2 migration semantics

- **Status:** Accepted
- **Date:** 2026-05-25
- **Deciders:** Platform team
- **Tags:** workflow, lifecycle, soc2-replay, migration

## Context

ADR 0008 established workflow policies as **versioned data, not
code**: every `Order` carries `workflowPolicyId` + `workflowPolicyVersion`
on every transition, so the entire workflow path of any order is
replayable against the exact policy that produced it.

That decision is the SOC-2 replay anchor — and until ADR 0017 it had
no companion lifecycle. Only one policy version (`order.standard` v1)
existed. The plan did not say what should happen the day v2 ships
while 47 orders are mid-PV1, or what `CreateOrder` should do during
the cutover window when both v1 and v2 exist with `status =
ACTIVE`, or what guarantee prevents a misconfigured release from
producing two `ACTIVE` rows for `(org, code)` at the same time.

Three failure modes were possible without explicit rules:

1. **Replay break.** An in-flight order born under v1 receives a
   transition under v2 because the bus naively re-selects the
   "current" policy on every dispatch. Replay against either version
   no longer matches what actually happened.
2. **Silent two-ACTIVE state.** An operator promotes v2 to `ACTIVE`
   without demoting v1; both rows now claim `ACTIVE` and
   `CreateOrder` non-deterministically picks one.
3. **Forgotten archive.** A SUPERSEDED row is the destination of a
   new `CreateOrder` because nothing in the lookup rejects
   non-ACTIVE statuses on the create path.

## Decision

Adopt the **grandfather rule** with a four-state lifecycle and
layered enforcement at the database + pure-function level.

### Lifecycle

```
DRAFT  →  ACTIVE  →  SUPERSEDED  →  ARCHIVED
              ↑           ↑
              (one ACTIVE per (organizationId, code))
```

- **DRAFT** — authored, not yet activated. Rejected by every
  selector. Visible to admin tooling so operators can review before
  promotion.
- **ACTIVE** — the canonical row. **At most one per
  `(organizationId, code)`**, enforced by partial unique index
  `workflow_policy_active_unique` (`WHERE status = 'ACTIVE'`).
- **SUPERSEDED** — previously ACTIVE, replaced by a newer ACTIVE
  row. **Still loadable for in-flight orders** so the grandfather
  rule holds; rejected for new `CreateOrder` requests.
- **ARCHIVED** — terminal decommission. No in-flight orders
  reference this row. Rejected by every selector. Migration to
  `ARCHIVED` requires a SystemCommand (not implemented here — see
  Deferred below).

### Selection rules

Two distinct selectors, encoded in `@pharmax/workflow`:

| Selector                       | Used by            | Accepts       |
| ------------------------------ | ------------------ | ------------- | ----------- |
| `pickPolicyForCreate`          | `CreateOrder` etc. | `ACTIVE` only |
| `loadPolicy({from: "target"})` | All in-flight cmds | `ACTIVE       | SUPERSEDED` |

The pure function `pickPolicyForCreate` returns `{ok, policy}` or
`{ok: false, code, reason}` with typed error codes
`WORKFLOW_POLICY_NOT_ACTIVE` / `WORKFLOW_POLICY_NOT_FOUND_FOR_CREATE`.
It supports an optional `requestedVersion` so migration scripts and
deterministic tests can pin against a specific row regardless of
the activation flip.

The in-flight selector lives inside `@pharmax/command-bus` because
it reads the **locked target row** inside the bus transaction
(`SELECT ... FOR UPDATE`). The bus's `loadPolicy: { from: "target" }`
branch widens to `ACTIVE | SUPERSEDED`.

### Atomic activation flow

A single transaction performs both the demote and the promote:

```sql
UPDATE workflow_policy
   SET status = 'SUPERSEDED', "retiredAt" = NOW()
 WHERE "organizationId" = :org AND code = 'order.standard'
   AND version = 1 AND status = 'ACTIVE';

UPDATE workflow_policy
   SET status = 'ACTIVE', "publishedAt" = NOW()
 WHERE "organizationId" = :org AND code = 'order.standard'
   AND version = 2 AND status = 'DRAFT';
```

Forgetting the demote and only attempting the promote produces a
**`23505 unique_violation`** from the partial unique index — the
database refuses the misconfiguration rather than allowing a silent
two-ACTIVE state.

The `retiredAt` column is annotated with a stable semantics: set the
first time the row leaves `ACTIVE`; remains pinned through a
subsequent `SUPERSEDED → ARCHIVED` transition.

### What about narrowing transitions?

If v2 narrows `CANCEL_FROM_STATES` (removes a state the v1 policy
allowed cancellation from), in-flight orders **continue under v1**
and can still be cancelled from the removed state. This is the
explicit trade-off of the grandfather rule: replay correctness wins
over uniform rule enforcement. Operators who need retroactive
enforcement use the forced-migration playbook (deferred).

## Deferred

`MigrateInFlightOrderPolicy({ orderId, fromVersion, toVersion,
reason })` SystemCommand — atomically re-stamps an in-flight order's
`workflowPolicyId`/`workflowPolicyVersion` and writes an audit row.
**Designed, not implemented.** Use cases: regulatory requirement
that retroactively narrows transitions; urgent safety patch. Will
ship when first real use case appears.

## Consequences

**Pros**

- Replay correctness preserved by construction (in-flight orders
  never see a policy change mid-workflow).
- Layered enforcement: DB partial unique + pure selector both
  prevent the two-ACTIVE failure mode.
- Activation is one atomic SQL transaction; misconfiguration surfaces
  as a 23505, not a silent corruption.
- Migration scripts and tests can pin versions deterministically via
  `requestedVersion`.

**Cons**

- Operators must remember to demote-then-promote (mitigated by the
  unique-index error if forgotten).
- SUPERSEDED rows live forever (or until ARCHIVE) — small storage
  cost.
- Narrowing transitions in v2 do not retroactively constrain
  in-flight orders — documented trade-off.

## Alternatives Considered

- **"Always use current ACTIVE"** — rejected: destroys the replay
  anchor that ADR 0008 was built on.
- **Snapshot the policy onto the order at create time** — rejected:
  duplicates state; the `workflowPolicyId` FK is already the
  snapshot pointer.
- **Per-tenant feature flag to opt into v2 mid-flight** — rejected:
  hides the activation decision in flag state; the lifecycle column
  is the source of truth.

## References

- ADR 0008 — Workflow as versioned data
- ADR 0007 — Twenty-step command-bus contract (`loadPolicy` step)
- ADR 0019 — Tenant extension surface (Tier 2 overlays compose with
  this lifecycle: a tenant overlay is scoped to a specific
  `workflowPolicyId`, so SUPERSEDED-policy in-flight orders keep the
  overlay that was active when they were born)
- Migration `prisma/migrations/20260608000000_workflow_policy_lifecycle/`
- `packages/workflow/src/policy-lifecycle.ts`
