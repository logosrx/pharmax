# @pharmax/workflow

Pure, dependency-light state machine for the standard prescription
order. Consumed by the command bus (`@pharmax/command-bus`) and by
UI affordance / static-analysis tooling that needs to ask "what
commands are reachable from state X under policy P?" without a
database or a transaction.

## What lives here

| Module                 | Surface                                                                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `states.ts`            | `ALL_ORDER_STATES`, `ORDER_PRIMARY_STATES`, `ORDER_EXCEPTION_STATES`, `ORDER_TERMINAL_STATES`, `isTerminalState`, etc.                                                                       |
| `commands.ts`          | `ORDER_WORKFLOW_COMMANDS` — the closed vocabulary of every command that may drive a transition.                                                                                              |
| `errors.ts`            | Stable workflow-error codes (`WORKFLOW_INVALID_TRANSITION`, `WORKFLOW_STATE_TERMINAL`, …). The engine returns these in `{ ok: false, code }`; the bus maps them to `PharmaxError` instances. |
| `policy-v1.ts`         | `ORDER_STANDARD_V1` — the v1 transition table for `code: "order.standard"`. One row per `(command, fromState)` pair so audit metadata can cite a stable `transitionId`.                      |
| `policy-overlay.ts`    | Overlay merge logic (ADR-0019). Lets tenants layer additional attestation requirements on top of a base policy without forking the transition table.                                         |
| `policy-lifecycle.ts`  | `pickPolicyForCreate` + the lifecycle status registry. The pure half of the policy-versioning contract documented in ADR-0017.                                                               |
| `engine.ts`            | `applyTransition`, `canTransition`, `getReachableCommands`. Total functions over `(state, command)` — no exceptions, no I/O, no clock.                                                       |
| `status-bucket-map.ts` | `BUCKET_CODE_FOR_STATUS` + `BUCKET_CODE_FOR_EXCEPTION_STATE` — where commands route the order after a transition.                                                                            |

## Policy versioning lifecycle (ADR-0017)

Workflow policies are versioned per `(organizationId, code)`. Every
`Order` row stamps `workflowPolicyId` + `workflowPolicyVersion` at
`CreateOrder` time; every structured workflow record
(`verification_record`, `order_hold`, `order_cancellation`,
`order_correction_reopen`) carries the same stamp. The pair is the
**replay-correctness anchor** — historical audit chains can be
re-evaluated against the exact policy that governed each
transition.

The `WorkflowPolicyStatus` enum has four values:

```
DRAFT      → ACTIVE → SUPERSEDED → ARCHIVED
```

| Status       | `loadPolicy: { code, version }` (CREATE) | `loadPolicy: { from: "target" }` (IN-FLIGHT) |
| ------------ | ---------------------------------------- | -------------------------------------------- |
| `DRAFT`      | rejected (`WORKFLOW_POLICY_INACTIVE`)    | rejected (`WORKFLOW_POLICY_INACTIVE`)        |
| `ACTIVE`     | accepted                                 | accepted                                     |
| `SUPERSEDED` | rejected (`WORKFLOW_POLICY_INACTIVE`)    | **accepted** (grandfather rule)              |
| `ARCHIVED`   | rejected (`WORKFLOW_POLICY_INACTIVE`)    | rejected (`WORKFLOW_POLICY_INACTIVE`)        |

**Grandfather rule (the default).** In-flight orders complete
under their born policy even after newer ACTIVE policies exist.
An order created under v1 stays under v1; ApprovePV1 on that
order loads v1 (now SUPERSEDED) and evaluates the transition
against v1's table, even if v2 has narrowed the transition.

**Activation invariant.** At most one ACTIVE row per
`(organizationId, code)`. Enforced at the database with a partial
unique index `workflow_policy_active_unique`. Activating v2 is a
demote-then-promote pair the operator runs in one transaction;
forgetting the demote surfaces a 23505 unique violation. Prisma's
schema language cannot express partial unique indexes — the
constraint lives in the migration SQL (`20260608000000_workflow_policy_lifecycle`)
and is mirrored at the application layer by `pickPolicyForCreate`.

**SUPERSEDED is not a deletion.** SUPERSEDED rows are first-class
citizens: readable for in-flight commands, joinable from reports
and forensic queries, immutable for the audit chain. Postgres'
partial unique lets us keep them indefinitely without breaking
the one-ACTIVE invariant.

**ARCHIVED is the explicit "no more reads" assertion.** An
operator moves a row from SUPERSEDED to ARCHIVED only after
confirming no in-flight order references it. If a command lands
referencing an ARCHIVED policy, the archival was premature — the
command fails loudly rather than silently advancing state on an
unsupported policy.

### Selecting a policy for create commands

```ts
import { pickPolicyForCreate, type WorkflowPolicyCandidate } from "@pharmax/workflow";

const candidates: WorkflowPolicyCandidate[] = await prisma.workflowPolicy.findMany({
  where: { organizationId, code: "order.standard" },
  select: { id: true, code: true, version: true, status: true },
});

const result = pickPolicyForCreate({ candidates, code: "order.standard" });
if (!result.ok) {
  // result.code === "WORKFLOW_POLICY_NOT_ACTIVE" | "WORKFLOW_POLICY_NOT_FOUND_FOR_CREATE"
  // Bus / handler maps to PharmaxError.
}
// result.policy.id is the stamp for the new order row.
```

Pinning a specific version (for tests or migration scripts):

```ts
const result = pickPolicyForCreate({
  candidates,
  code: "order.standard",
  requestedVersion: 2,
});
// `result.ok === true` only if v2 is ACTIVE. SUPERSEDED v2 →
// WORKFLOW_POLICY_NOT_ACTIVE; missing v2 → WORKFLOW_POLICY_NOT_FOUND_FOR_CREATE.
```

The function is pure (`(candidates, code, requestedVersion?) →
result`); reusable from unit tests, migration scripts, and any
caller that needs to ask "which version would a new order be
stamped with right now?" without instantiating the command bus.

### In-flight policy resolution (bus-owned)

`@pharmax/command-bus`'s `defineCommand` factory reads the locked
order's `workflowPolicyId` and looks the row up by id when
`loadPolicy: { from: "target" }` is declared. The accepted
statuses widen to `ACTIVE | SUPERSEDED` (mirrored as the
`IN_FLIGHT_READABLE_STATUSES` constant in `policy-lifecycle.ts`).
DRAFT and ARCHIVED are rejected with `WORKFLOW_POLICY_INACTIVE`.

### Forced migration (designed, not implemented)

Some events justify re-stamping an in-flight order onto a different
policy version (regulatory narrowing, urgent safety patches). ADR-
0017 specifies a `MigrateInFlightOrderPolicy` SystemCommand for
this case; the implementation lands when the first real use case
appears. The grandfather rule is the default for everything else.

## Reading order

1. ADR-0017 (`docs/adr/0017-workflow-policy-migration.md`) — the
   contract this package's `policy-lifecycle.ts` implements.
2. ADR-0019 (`policy-overlay.ts`) — overlay-on-top-of-base policy
   model for per-tenant attestations.
3. `policy-v1.ts` — the v1 transition table itself.
4. `engine.ts` — how a policy is evaluated.
