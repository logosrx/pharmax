# 0011 — Separation of Duties enforced at the command bus via declarative rules

- **Status:** Accepted
- **Date:** pre-2026-05
- **Deciders:** Platform team
- **Tags:** security, rbac, workflow

## Context

Pharmacy workflow safety requires that certain pairs of actions cannot
be performed by the same human on the same order: the pharmacist who
**approved PV1** cannot also approve final verification (two-pharmacist
sign-off); the technician who **typed** cannot approve PV1; the
technician who **completed the fill** cannot approve final.

These are regulatory and clinical-safety invariants, not UI
suggestions. Enforcing them in the UI alone is bypassable. Enforcing
them inside individual command handlers yields twelve "almost
correct" implementations. And the constraint cannot be expressed as a
plain RBAC permission, because it is **history-dependent** — "the
actor was the one who emitted event X earlier in this order's
`order_event` stream".

## Decision

Encode Separation of Duties as **declarative rules** in a frozen
registry inside `@pharmax/rbac`, evaluated **inside the command bus**
between policy load and handler execution.

- `SOD_RULES` in `packages/rbac/src/separation-of-duties.ts` is a
  frozen array typed against the `PERMISSIONS` constants (no string
  drift). Each rule:
  `{ ruleId, attempted, forbiddenPriorActs[], scope: "order" }`.
- Canonical rules today:
  - `sod.typing-pv1-same-actor` (PV1_APPROVE forbids prior TYPING_COMPLETE)
  - `sod.pv1-final-same-actor` (FINAL_APPROVE forbids prior PV1_APPROVE)
  - `sod.fill-final-same-actor` (FINAL_APPROVE forbids prior FILL_COMPLETE)
- `requireNoSoDViolation({attempted, resource, actor, priorActs})` is
  a pure predicate that loops `RULES_BY_ATTEMPTED.get(attempted)` and
  throws `AuthorizationError(SOD_VIOLATION)` with metadata
  `{ruleId, attemptedPermission, collidingPriorAct, priorActSequence,
resourceRef, actorUserId, organizationId, correlationId}` on the
  first colliding prior act by the same actor.
- The `defineCommand` factory (ADR 0012) accepts a `sodRules` clause.
  When present, the bus loads `order_event` history with a minimal
  select (`eventType`, `actorUserId`, `sequenceNumber`), projects each
  row through a per-command `translate` (`orderEventTypeToPermission`),
  and feeds `priorActs` to the predicate **before** the handler runs;
  a violation rolls back the tx with zero domain writes.
- **Multi-rule efficiency invariant.** `FINAL_APPROVE` carries two
  rules; the handler declares a SINGLE `sodRules` entry, and the
  registry walk fans out across both rules in one history read. A
  test pins this against a "let's add another sodRules clause"
  regression that would double the history load.
- **Asymmetry.** SoD applies to sign-offs (`APPROVE`), not to opens
  (`START`) or rejections (`REJECT`). A typist may start their own
  PV1 review to read it; a pharmacist may self-reject a final
  verification because catching their own error is healthier than
  forcing a workaround. Each `Start*` and `Reject*` command has a
  dedicated test pinning `findMany` is never called.

## Consequences

**Easier:**

- The SoD invariant cannot be bypassed by curl, by a script, or by
  a forgotten UI guard — the command bus enforces it for every
  caller.
- New SoD rules ship as registry data + a single command-handler
  `sodRules` clause; the enforcement code is unchanged.
- Audit metadata names the violating rule (`ruleId`), which downstream
  dashboards can display verbatim to operators.

**Harder:**

- Rule declaration order in `SOD_RULES` is observable: when two
  rules both fire on the same attempt, the earlier-declared rule
  wins (`sod.pv1-final-same-actor` beats `sod.fill-final-same-actor`
  when both apply). Reordering is a tracked surface-area change.
- The `order_event` history load is a real cost on commands with
  `sodRules`. We accept it; we do not declare `sodRules` on commands
  that have no matching registry rule (the "no-SoD" tests prevent
  silent regressions).

**Ongoing obligations:**

- The `translate` function for each command must map every relevant
  `eventType` to its corresponding permission; unmapped events are
  silently skipped (defense against future informational events,
  asserted by tests).
- System-emitted events (`actorUserId: null`) must always be skipped
  by the loader — a system actor cannot violate SoD.

## Alternatives Considered

- **UI-only enforcement.** Trivially bypassable; rejected on safety
  grounds.
- **Per-handler imperative checks.** Twelve "almost correct"
  implementations; precisely the failure mode the command bus
  exists to prevent (ADR 0007).
- **Database trigger checking `order_event` history on every
  `verification_record` insert.** Hides the rule from the
  application layer; surfaces violations as generic SQL errors,
  not typed `SOD_VIOLATION`s with full metadata.

## References

- ADR 0007 — Twenty-step command-bus contract (step 12 SoD resolution)
- ADR 0012 — `defineCommand` factory (`sodRules` clause)
- `packages/rbac/src/separation-of-duties.ts` — `SOD_RULES`, predicate
- `packages/orders/src/events.ts` — `ORDER_EVENT_TYPE_TO_PERMISSION` translator
- `packages/verification/src/commands/approve-pv1.test.ts` — 6 SoD tests
- `packages/verification/src/commands/approve-final-verification.test.ts` — multi-rule tests
