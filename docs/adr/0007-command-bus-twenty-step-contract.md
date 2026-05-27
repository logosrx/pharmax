# 0007 — Twenty-step command-bus contract for all critical mutations

- **Status:** Accepted
- **Date:** pre-2026-05
- **Deciders:** Platform team
- **Tags:** workflow, security, audit, contract

## Context

A pharmacy workflow command must do many things, in order, every
time, or someone gets hurt. A single transition (`ApprovePV1`,
`CompleteFill`, `ConfirmShipment`, ...) must validate input,
authenticate the actor, authorize against RBAC, enforce workstation
requirements where applicable, honor idempotency, persist a
tamper-evident audit entry, hold a row lock, apply the tenancy
session GUC so RLS (ADR 0004) fires, run the domain handler
atomically with the audit + outbox writes, and surface PHI-free
errors on every failure path.

If every domain package implements these steps itself, we get twelve
"almost correct" implementations. The project rules are unambiguous:
every critical transition writes `command_log`, `order_event`,
`audit_log`, and `event_outbox` atomically; every critical command
requires an idempotency key; every critical workflow transition locks
the order row.

## Decision

`@pharmax/command-bus` defines a single twenty-step orchestrator —
`executeCommand` — that every critical mutation flows through. The
contract is:

```
1. Validate request shape  (Zod against the command's inputSchema)
2. Validate actor identity (from TenancyContext)
3. Validate actor role     (RBAC permission check via @pharmax/rbac)
4. Validate scope          (org / site / clinic / team / bucket)
5. Validate workstation    (if Command.requireWorkstation)
6. Check idempotency       (lookup, replay match or pass-through)
7. Create command_log row  (status RUNNING, pre-tx)
8. Begin $transaction { ────────────────────────────────────────────
9.   applyTenancySessionGuc / applySystemSessionGuc  (FIRST stmt)
10.  (defineCommand: row lock via SELECT … FOR UPDATE)
11.  (defineCommand: load workflow policy by id+version)
12.  (defineCommand: resolve SoD rules vs order_event history)
13.  Run command handler (exec)
14.  (defineCommand: optimistic version CAS via updateMany)
15.  (defineCommand: order_event writeback with monotonic seq)
16.  Write audit_log (delegates to @pharmax/audit chain writer)
17.  Write event_outbox row(s)
18.  Write idempotency_key row
19. } commit
20. Mark command_log SUCCEEDED / FAILED  (post-tx)
```

Two flavors exist: `executeCommand` (tenant; steps 1-20) and
`executeSystemCommand` (bootstrap; no RBAC, no idempotency cache,
in-tx `command_log` keyed on handler-resolved `targetOrganizationId`,
requires `withSystemContext`, calls `applySystemSessionGuc` first).
29 contract tests pin every gate-failure as zero-DB-footprint and
pin the RLS-GUC-before-audit ordering. PHI-free errors are emitted
with canonical codes (`COMMAND_INPUT_INVALID`,
`COMMAND_IDEMPOTENCY_PAYLOAD_MISMATCH`, `COMMAND_WORKSTATION_REQUIRED`,
`COMMAND_SYSTEM_CONTEXT_REQUIRED`, ...).

Per ADR 0012, the `defineCommand` factory is the canonical way to
express a command against this contract; it slots the workflow-
specific steps (row lock, policy load, SoD, version CAS, order_event)
into their canonical position inside steps 9-15.

## Consequences

**Easier:**

- A new command is a declarative spec: input schema, permission,
  optional workstation requirement, redact fields, handler body. The
  bus does the rest.
- Audit chain, outbox, idempotency, and RLS GUC ordering are
  guaranteed by the bus — handler authors cannot forget them.
- An incident reviewer reads `command_log` to find every attempted
  call (including failed RBAC), `audit_log` to find every committed
  effect, and `event_outbox` to find every downstream consequence.

**Harder:**

- Every domain mutation must come back to the bus. A "quick raw
  `prisma.update`" shortcut breaks the audit chain and the tenancy
  guarantees. The command-file linter
  (`scripts/check-command-files.ts`) catches commands written in
  the wrong shape; reviewers catch the rest.
- The bus is a hot path. Every line is reviewed with that in mind.

**Ongoing obligations:**

- Steps 9-15 are pinned by call-sequence assertions; do not reorder
  without updating the contract tests AND the ADR.
- New error codes added to the bus go into the PHI-free, machine-
  parseable canonical set.

## Alternatives Considered

- **CQRS / event sourcing.** Buys replayability we already get from
  `command_log` + `event_outbox`, at the cost of a second source of
  truth.
- **Per-package mini-bus.** Twelve "almost correct" implementations
  of the same twenty-step contract; the failure mode this ADR avoids.
- **Express-style middleware chain.** Step ordering is safety-critical
  (GUC must precede audit, lock must precede policy load). A typed
  orchestrator catches reorders at compile time; middleware does not.

## References

- ADR 0004 — Multi-tenancy via Postgres RLS (step 9 GUC ordering)
- ADR 0006 — Hash-chained audit log (step 16 delegate)
- ADR 0009 — Outbox pattern (step 17 producer half)
- ADR 0012 — `defineCommand` declarative factory
- `packages/command-bus/` — `execute-command.ts`, `define-command.ts`
- `docs/ARCHITECTURE_PRINCIPLES.md` §B.6, §C.3
