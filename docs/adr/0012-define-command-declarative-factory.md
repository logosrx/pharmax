# 0012 — `defineCommand()` declarative factory as the canonical command shape

- **Status:** Accepted
- **Date:** pre-2026-05
- **Deciders:** Platform team
- **Tags:** workflow, dx, contract

## Context

The twenty-step command-bus contract (ADR 0007) is correct and
load-bearing, but writing a command directly against `executeCommand`
requires every author to wire the row lock, resolve and assert the
workflow policy, walk SoD against `order_event` history, bump
`order.version` via an optimistic-concurrency CAS, append `order_event`
rows with monotonic sequence numbers, and register saga compensators
for partial-effect rollback.

Twelve commands written by hand will have twelve "almost correct"
implementations of these steps. The pattern is mechanical; the cost
of getting it wrong (row lock missed, sequence race, version
overwrite) is unacceptable.

## Decision

`@pharmax/command-bus` exports a **declarative `defineCommand`
factory** that compiles a spec into a standard `Command<TInput,
TOutput>` runnable by `executeCommand`. The factory is **sugar over
the orchestrator, not a parallel path** — every command flows through
the same twenty-step contract.

The spec shape: `defineCommand({ name, inputSchema, permission,
lockTarget?, loadPolicy?, sodRules?, bumpVersion?, redactFields?,
requireWorkstation?, exec })`.

Inside the bus tx, after the tenancy GUC fires, the factory runs
in canonical order:

1. **Row lock** (`SELECT … FOR UPDATE` on `lockTarget`), returning
   `{id, organizationId, clinicId, siteId, currentStatus, version,
workflowPolicyId, workflowPolicyVersion}` so handlers receive the
   freshly locked aggregate. Missing row → `ORDER_NOT_FOUND`.
2. **Workflow policy load** by `(code, version)` for create commands
   or by `target.workflowPolicyId` for in-flight commands. Asserts
   `status = "ACTIVE"` and throws `WORKFLOW_POLICY_NOT_FOUND` /
   `WORKFLOW_POLICY_INACTIVE` before the handler runs.
3. **SoD rule resolution** (ADR 0011) — load `order_event` history,
   translate events to permissions, call `requireNoSoDViolation`.
4. **`exec(ctx)`** with `{tx, ctx, input, policy, target, clock,
registerSaga, emit}`; `target`/`policy` are `null` when their
   declarative inputs are omitted.
5. **Optimistic version CAS** via `updateMany({where: {id,
organizationId, version: oldVersion}, data: {version: newVersion}})`;
   zero-row update throws `ORDER_VERSION_MISMATCH`.
6. **`order_event` writeback** with monotonic per-order
   `sequenceNumber` (`findFirst orderBy desc + 1`; the row lock
   serializes, so no advisory lock needed), one row per declared
   `emits[]` entry, stamped with `actorUserId`, `actorWorkstationId`,
   `correlationId`, `commandLogId`.
7. **Saga compensators** registered during `exec` run in LIFO order
   on exception, inside the tx; the original error re-throws to
   roll back.

21 contract tests pin the canonical step ordering, the call-shape
of every step, and parameter-binding (no string interpolation into
the lock SQL).

## Consequences

**Easier:**

- A new in-flight workflow command is ~70 lines of declarative
  spec plus an `exec` body, with one error code per failure class.
  Verification commands ship in one PR each.
- Test surface is consistent: every command's test asserts the same
  step ordering (`lock → policy → SoD → exec → CAS → event → audit
→ outbox`).
- The factory is the **single source of truth** for "the right way
  to write a command". The command-file linter
  (`scripts/check-command-files.ts`) accepts `defineCommand(...)`,
  a typed `Command<...>` object, or a typed `SystemCommand<...>`
  object; anything else fails CI.

**Harder:**

- The factory abstracts step ordering, which is a load-bearing
  safety property. Changes to the factory's step order require an
  ADR amendment (this one) plus the contract-test updates.
- Some commands (e.g. `CryptoShredPatient`, `CapturePackagePhoto`)
  do not fit the factory's order-aggregate shape and stay as direct
  `Command<I, O>` implementations. The linter accepts both shapes;
  reviewers verify that direct commands are justified.

**Ongoing obligations:**

- Spec validation rejects illegal combinations (`sodRules` or
  `loadPolicy` without `lockTarget`, etc.); tests pin these.
- Factory changes land with the same canonical-ordering call-sequence
  assertions every command's test suite already exercises.

## Alternatives Considered

- **Code generation from a YAML/JSON command schema.** Adds a build
  step and a second toolchain; the TypeScript factory gives the same
  declarative shape with full IDE typing.
- **Inheritance-based command base class.** Loses the "spec as data"
  shape; harder to lint, harder to evolve.
- **Direct `executeCommand` calls for every command.** Twelve
  "almost correct" implementations; precisely the failure mode this
  factory exists to prevent.

## References

- ADR 0007 — Twenty-step command-bus contract
- ADR 0011 — Separation of Duties at the command bus
- `packages/command-bus/src/define-command.ts`
- `packages/command-bus/src/define-command.test.ts` — 21 contract tests
- `scripts/check-command-files.ts` — command-file linter
