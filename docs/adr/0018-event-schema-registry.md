# 0018 — Event schema registry

- **Status:** Accepted
- **Date:** 2026-05-25
- **Deciders:** Platform team
- **Tags:** outbox, events, schema-evolution, compatibility

## Context

ADR 0009 made the database `event_outbox` table the source of truth
for cross-process side effects: commands write outbox rows in the
same transaction as the domain mutation; workers drain those rows
post-commit. Event names follow a convention (`order.shipped.v1`,
`billing.invoice.finalized.v1`, etc.) — string literals, JSON
payloads, no schema enforcement.

That convention has carried 100+ event types so far. It does not
scale to:

- **Typed producers.** A command that emits `order.shipped.v1` has
  no way to assert the payload shape at compile time. A typo in a
  field name only fails when a consumer panics in production.
- **Safe versioning.** Adding `order.shipped.v2` with a renamed
  field today is a **coordinated deploy**: every consumer must
  understand both shapes simultaneously, or events queue up unread,
  or a half-deployed consumer crashes on a field it doesn't know.
- **Schema introspection.** Operators investigating an outbox row
  have no canonical place to read "what fields can this event
  carry?". The producer command is the de-facto schema, scattered
  across the domain packages.
- **Audit.** The auditor's question "show me every event your
  platform emits, with its current schema" requires `grep` and
  hope.

## Decision

Adopt a centralized **event schema registry** in a new package
`@pharmax/events`. Every outbox event is declared once via a
`defineEvent` factory that pairs a versioned name with a Zod schema:

```typescript
export const OrderShippedV1 = defineEvent({
  name: "order.shipped.v1",
  description: "An order's shipment has been confirmed as in transit.",
  schema: z.object({
    orderId: z.string().uuid(),
    organizationId: z.string().uuid(),
    shipmentId: z.string().uuid(),
    carrier: z.enum(["EASYPOST", "FEDEX", "UPS"]),
    trackingNumber: z.string(),
    shippedAt: z.string().datetime(),
  }),
});
```

### Surface

`@pharmax/events` exports:

- **`defineEvent(spec)`** — frozen `EventDefinition<TPayload>`
  factory. Validates the `name` against `EVENT_NAME_REGEX`
  (`/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v\d+$/`) at construction.
- **`EVENT_REGISTRY`** — `ReadonlyMap<string, EventDefinition>` keyed
  on full event name. Both `v1` and `v2` entries coexist during
  cutover windows.
- **`getEventDefinition(name)` / `listRegisteredEventNames()`** —
  lookup + enumeration for introspection and tests.
- **`emit(definition | name, payload)`** — typed path validates the
  payload against the schema at the call site; legacy string path
  preserved for incremental migration.
- **`assertEventCompatibility(prev, next, kind)`** with
  `CompatibilityKind ∈ {forward, backward, full}` — fails when next
  adds a required field that prev did not have (breaks backward),
  removes a field prev declared (breaks forward), or either of the
  above (breaks full).
- **`scanRepositoryForEventNames() / buildParityReport()`** — the
  parity guard. Walks the repo for event-name string literals and
  produces a report of names found in code that are not in the
  registry. An explicit `EVENT_REGISTRATION_ALLOWLIST` lets the team
  migrate domains gradually without the test going red.

### Versioning playbook

When a payload needs a breaking change:

1. **Define `OrderShippedV2`** alongside `OrderShippedV1` in the
   registry. Both live in the registry.
2. **Producers cut over** by switching `emit(OrderShippedV1, ...)`
   to `emit(OrderShippedV2, ...)` one call site at a time.
3. **Consumers handle both** until producers are fully on V2.
4. **`assertEventCompatibility(OrderShippedV1, OrderShippedV2,
"backward")`** documents whether V2 is a drop-in replacement
   (additive changes only) or a true breaking change (requires
   coordinated consumer cutover).
5. **Retire V1** by removing producers, then consumers, then the
   registry entry — in that order.

A non-breaking change (adding an optional field) does **not**
require a v2 bump; the V1 schema is updated in place and
`assertEventCompatibility(prev, next, "full")` passes.

### Phased rollout

The initial registry covers **15 high-traffic events** drawn from
the domains most exposed to consumer changes (organization,
patient, order × 7, shipment × 1, billing × 6). The remaining
~85 names live in `EVENT_REGISTRATION_ALLOWLIST` and migrate in
follow-up slices, one domain at a time. The parity guard test
fails any **new** unregistered name (the allowlist is fixed-size).

## Consequences

**Pros**

- Typed producers — schema violations are TS errors or fail at the
  `emit` call site, not at consumer time in production.
- Safe versioning — V1 and V2 coexist; the registry is the
  vendor-neutral switchover point.
- Schema introspection — operators and auditors have one place to
  read "every event Pharmax emits, with its current shape".
- Parity guard — adding a new event name without registering it is
  a test failure, not a runtime surprise.

**Cons**

- Allowlist debt — 85 names need migration; until then the registry
  is incomplete. Mitigated by a fixed allowlist that fails any new
  unregistered name.
- Two emit paths — typed and legacy. Documented as a transitional
  surface; legacy is removed once the allowlist empties.
- Zod runtime cost per emit — measured to be sub-microsecond on the
  schemas at hand; acceptable for transactional commands.

## Alternatives Considered

- **Avro + a separate schema-registry service** (Confluent-style) —
  rejected: operational overhead, doesn't match the in-process
  monolith shape, requires a sidecar.
- **TypeScript types only** — rejected: types vanish at runtime;
  consumers parsing JSON have no way to assert shape; auditors
  cannot read the schema without running the build.
- **CloudEvents envelope** — kept optional as a future wrapper; the
  envelope is orthogonal to the schema registry and can be added
  without disturbing the per-event definition surface.

## References

- ADR 0009 — Outbox via database polling
- ADR 0002 — Modular monolith with event-driven internals
- ADR 0007 — Twenty-step command-bus contract (`emit` step writes
  the outbox row in the same tx as the domain mutation)
- `packages/events/src/define-event.ts`
- `packages/events/src/compatibility.ts`
- `packages/events/src/parity-guard.ts`
