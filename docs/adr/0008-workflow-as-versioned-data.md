# 0008 — Workflow as versioned data, not code

- **Status:** Accepted
- **Date:** pre-2026-05
- **Deciders:** Platform team
- **Tags:** workflow, replay, policy

## Context

Pharmax encodes a non-trivial workflow: 11 primary states plus 5
exception states, ~25 transitions across typing, PV1, fill, final
verification, and shipping, plus cross-cutting transitions
(`PLACE_HOLD`, `RELEASE_HOLD`, `CANCEL`, `REOPEN_FOR_CORRECTION`).
The workflow will evolve: a clinic may want a third verification gate;
a regulated state may forbid `HOLD` from a specific state.

Encoding transitions in TypeScript `switch` statements has three
critical failure modes: **replay drift** (an order in flight under v1
silently follows v2 rules; verification records cite the wrong policy
version); **test surface** (pure code embedded in a handler is hard
to test without a database, and UI affordance checks need the same
logic without a tx); and **side effects** (a handler-resident switch
invites someone to sneak `await sendEmail()` into a transition guard).

We need a workflow engine that is **pure, replay-correct, and
testable without I/O**.

## Decision

Encode workflow rules as **versioned data** (`WorkflowPolicy` rows in
the database) and consume them through a **pure engine** in
`@pharmax/workflow`.

- `OrderWorkflowPolicy` is a typed data structure (currently
  hard-coded as `ORDER_STANDARD_V1`, future: loaded from the
  `workflow_policy` table) listing every transition as a row keyed by
  `(command, fromState)` so audit metadata can cite a stable
  `transitionId`. Cross-cutting commands (`PLACE_HOLD`, `CANCEL`,
  `RELEASE_HOLD`) are expanded into one transition row per source
  state with allow-list constants (`HOLD_FROM_STATES`,
  `CANCEL_FROM_STATES`) documenting the rule.
- `applyTransition(policy, currentState, command, params)` is a
  **TOTAL function** over `(state, command)` pairs returning
  `{ ok: true, ... } | { ok: false, code, reason }`. No exceptions,
  no I/O, no clock, no ULID, no `Math.random`. Same input → same
  output bytes.
- Engine error codes (`WORKFLOW_INVALID_TRANSITION`,
  `WORKFLOW_PARAM_INVALID`, `WORKFLOW_PARAM_REQUIRED`,
  `WORKFLOW_STATE_TERMINAL`, `WORKFLOW_UNKNOWN_COMMAND`) are mapped
  to `PharmaxError` instances by the command bus, not the engine —
  the engine never imports error classes.
- Every `Order` row carries `workflowPolicyId` + `workflowPolicyVersion`.
  Per ADR 0007 step 11, the `defineCommand` factory loads the policy
  by the locked target's stamped id+version for in-flight commands,
  or by `(code, version)` for create commands. **An order created
  under v1 stays under v1** even if v2 is later activated mid-flight;
  this is the replay-correctness guarantee.
- Every `verification_record` row carries the same
  `(workflowPolicyId, workflowPolicyVersion)` stamp, by CHECK
  constraint, so reading the table tells you "what rule was in force
  when this pharmacist signed".

## Consequences

**Easier:**

- UI affordance checks reuse the engine without a DB. Replay tools
  consume `command_log` rows and apply the stamped policy
  deterministically.
- Adding a new transition is a data change with a contract test, not
  a sprawl of imperative branches.
- A v2 policy can land without a flag day — new orders are stamped
  with v2, old orders ride v1 to completion.

**Harder:**

- The engine is **pure by contract**. No future maintainer may
  reach for the clock or DB inside `applyTransition`. The package
  has no I/O dependencies; PRs that add one fail review.
- Cross-cutting commands (`HOLD`, `CANCEL`) require one transition
  row per source state, which inflates the policy data. We accept
  the verbosity in exchange for stable `transitionId`s in the audit
  trail.

**Ongoing obligations:**

- New transitions land as policy data + contract tests + a command
  that emits the right `transitionId`.
- Future v2 work follows ADR 0017 (workflow policy migration —
  reserved) for the cutover process.

## Alternatives Considered

- **Code-embedded switch statements.** Replay drift problem above.
- **External workflow engine (Temporal, Step Functions).** Adds an
  external runtime and a second source of truth for "what state is
  this order in"; the source of truth must remain Postgres so
  command-bus atomicity (ADR 0007) holds.
- **Database triggers.** Hides the rule from the application layer
  and makes "why did this transition fail?" a forensic exercise.

## References

- ADR 0007 — Twenty-step command-bus contract (loads policy at step 11)
- ADR 0017 (reserved) — Workflow policy migration process
- `packages/workflow/` — `apply-transition.ts`, `policy-v1.ts`
- `docs/ARCHITECTURE_PRINCIPLES.md` §B.2
