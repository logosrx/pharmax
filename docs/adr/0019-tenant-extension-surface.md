# 0019 — Tenant extension surface (three-tier model)

- **Status:** Proposed
- **Date:** 2026-05-25
- **Deciders:** Platform team
- **Tags:** tenancy, extensibility, workflow, security

## Context

Pharmax is multi-tenant by design — one binary, many organizations,
many clinics. Customers do not all want the same workflow:

- A specialty clinic that handles controlled substances wants a
  **second pharmacist signoff** on `ApprovePV1` for CII–CV orders.
- A clinic that finalizes for a downstream pharmacy wants to
  **forbid `ReopenForCorrection`** entirely.
- A clinic with a custom EHR wants to **push every shipped order**
  to that EHR after `order.shipped.v1`.
- A clinic on a faster billing cycle wants to **auto-escalate any
  order > $500** to a custom bucket.

Today the only seam is `FEATURES` (`@pharmax/rbac`) — a frozen
registry of boolean capability flags resolved per-tenant via
`FeatureFlagSource`. Booleans cannot express any of the four
examples above. The only alternative engineers have today is to
branch inside the affected command (`ApprovePV1`, etc.), which
explodes combinatorially as more clinics request more
customizations and dilutes the value of the workflow policy
(ADR 0008): the rule is no longer "what does v1 say" but "what
does v1 say AND what does this clinic's branch say".

We need a **layered**, **scope-bounded**, **security-preserving**
extension surface. The same surface must serve toggles, parameters,
and (eventually) tenant-supplied code without bleeding into the
command-bus contract (ADR 0007) or the workflow policy
contract (ADR 0008).

## Decision

Adopt a **three-tier extension model**, where each tier matches a
specific class of customization. Each tier is a strict superset of
the surface area of the tier below.

### Tier 1 — Feature flags (already exists)

Boolean capability flags resolved per-tenant via `FeatureFlagSource`
(`packages/rbac/src/feature-flags.ts`). Source of truth for "is
this OPTIONAL feature turned on for THIS clinic?".

- **Use when:** an existing optional feature should be on/off
  per-tenant (e.g. `print.package-photos`,
  `intake.telehealth-callbacks`, `shipping.easypost-outbound`).
- **Do not use when:** the customization carries parameters or
  introduces new behavior the platform doesn't already understand.
- **Security:** a feature flag NEVER grants the underlying
  permission — RBAC is the access decision; features are the
  capability decision.

### Tier 2 — Workflow Policy Overlays (new — designed here)

Per-tenant **declarative parameter overrides** layered onto the
base `OrderWorkflowPolicy` (ADR 0008). Source of truth for
"narrow or augment a workflow rule for THIS clinic".

- **Use when:** the customization tightens an existing transition
  (forbid this `(command, fromState)` pair) or adds a structured
  rule the engine can express declaratively (extra attestation
  requirement on a transition).
- **Do not use when:** the customization requires entirely new
  code paths the engine cannot express declaratively.
- **Examples that fit:** "second pharmacist on PV1 for controlled
  substances", "forbid `ReopenForCorrection` for our clinic",
  "require an additional safety attestation on `RELEASE_TO_SHIP`".

The overlay shape (v1):

```ts
export interface AttestationRequirement {
  readonly id: string; // stable id for audit metadata
  readonly minSignatures: number; // >= 1; actor counts as one
  readonly permission: string; // PermissionCode the additional signer must hold
  readonly description?: string;
}

export interface WorkflowPolicyOverlay {
  readonly forbidTransitionsFromStates?: Readonly<
    Partial<Record<OrderWorkflowCommand, ReadonlyArray<OrderState>>>
  >;
  readonly addRequiredAttestations?: Readonly<
    Record<string /* transitionId */, ReadonlyArray<AttestationRequirement>>
  >;
}
```

`mergePolicyWithOverlay(base, overlay) → OrderWorkflowPolicy` is
the single composition point. Pure (no I/O, no clock, no
exceptions outside of one validated throw). Deferred items are
explicitly listed under "Consequences → Deferred".

### Tier 3 — Command Interceptors (designed, deferred)

A plugin surface where a tenant-scoped extension registers a
**pre-handler** that runs **inside the command-bus tx** and may
short-circuit, augment, or annotate the command. Source of truth
for "tenant needs entirely new behavior the engine cannot express".

- **Use when:** the customization is genuinely custom logic
  (e.g. "push to our custom EHR after `order.shipped.v1`",
  "auto-escalate orders > $500 to a custom bucket").
- **Do not use when:** Tier 1 or Tier 2 can express the rule.
- **Sketch:**
  - Interceptors are registered against `(commandName, phase)`
    where `phase ∈ { "before-handler", "after-handler" }`.
  - Interceptors run inside the bus tx so they share RLS scope
    and rollback semantics with the handler.
  - Interceptors that return `{ shortCircuit: true, output }`
    skip the handler; interceptors that throw roll back the tx
    with the typed error.
  - Interceptor code is loaded from a **vetted plugin allowlist**
    (extension binary signed; tenant cannot supply arbitrary code
    until Pharmax adds a sandboxed runtime).

This tier is **deferred** — implementing it in Phase-5 timeframe
without first proving Tier 2 captures the realistic use cases is
over-engineering. The decision tree below is biased toward Tier 2.

### Decision tree

```text
Is the customization a yes/no toggle of an existing feature?
├─ YES → Tier 1 (FeatureFlagSource). Done.
└─ NO  → Does the customization tighten / parameterize an
         existing transition (forbid a transition; add an
         attestation; widen-to-a-subset)?
         ├─ YES → Tier 2 (WorkflowPolicyOverlay). Done.
         └─ NO  → Does the customization introduce entirely new
                  code paths (push to a tenant's custom EHR,
                  apply a tenant-specific routing rule)?
                  ├─ YES → Tier 3 (Command Interceptor) — deferred.
                  │        File a Tier 3 design ticket; do NOT
                  │        branch inside an existing command.
                  └─ NO  → Re-frame the requirement; if you cannot
                          place it in any tier, the change probably
                          belongs in the BASE policy (ADR 0008)
                          or as a new permission (`@pharmax/rbac`).
```

### Security invariants (Tier 2)

1. **Tighten-only.** `mergePolicyWithOverlay` returns a policy
   whose transition set is a **subset** of the base policy's
   transition set. The merge function asserts this as a
   postcondition; any overlay that would widen the base is
   rejected with `ValidationError(OVERLAY_LOOSENS_BASE_POLICY)`.
   In particular: an overlay cannot enable a `(command, fromState)`
   pair the base does not declare, and cannot remove an attestation
   the base requires.
2. **In-tx resolution.** Tier 2 wiring (Phase 5 follow-up) reads
   the active overlay row INSIDE the command-bus tx, so
   per-tenant Postgres RLS protects the read. A misconfigured
   overlay cannot leak across tenants.
3. **Auditable changes.** Overlay mutations go through an
   `UpsertWorkflowPolicyOverlay` admin command (Phase 5 follow-up)
   that writes `command_log`, `audit_log`, and `event_outbox`
   like every other critical mutation (ADR 0007). Overlay rows
   are **content-addressed by version** so the order's stamped
   `(workflowPolicyId, workflowPolicyVersion, overlayVersion)`
   triple is replay-correct (ADR 0008 invariant extends to
   overlays).
4. **Versioned with base.** An overlay is bound to a specific
   `(workflowPolicyId, workflowPolicyVersion)`. When the base
   policy supersedes (per ADR 0017), the overlay must be
   re-validated against the new base; an overlay whose forbid
   list references a transition the new base does not declare
   FAILS the merge and the admin must re-author it before
   activation.
5. **Pure merge.** The merge function is a pure function of
   `(base, overlay)`. No clock, no DB, no entropy. Same inputs →
   same output. Replayable from `command_log`.

### Storage shape sketch (Tier 2 follow-up)

```sql
-- NOT a migration; sketch only. Lands as a follow-up slice.
CREATE TABLE workflow_policy_overlay (
  id                       UUID PRIMARY KEY,
  organization_id          UUID NOT NULL REFERENCES organization(id) ON DELETE RESTRICT,
  clinic_id                UUID     REFERENCES clinic(id)       ON DELETE RESTRICT,  -- NULL = org-wide
  workflow_policy_id       UUID NOT NULL REFERENCES workflow_policy(id) ON DELETE RESTRICT,
  workflow_policy_version  INT  NOT NULL,
  overlay_json             JSONB NOT NULL,                       -- WorkflowPolicyOverlay shape
  status                   workflow_policy_overlay_status NOT NULL,  -- DRAFT | ACTIVE | SUPERSEDED | ARCHIVED
  version                  INT  NOT NULL,
  created_by_user_id       UUID NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Partial unique: at most one ACTIVE row per (org, clinic, workflow_policy_id)
CREATE UNIQUE INDEX workflow_policy_overlay_active_unique
  ON workflow_policy_overlay (organization_id, COALESCE(clinic_id, '00000000-0000-0000-0000-000000000000'::uuid), workflow_policy_id)
  WHERE status = 'ACTIVE';
```

**Resolver order** at command time:

```text
base policy (workflow_policy row, by id+version)
  → org-wide overlay   (clinic_id IS NULL,  ACTIVE)
  → clinic overlay     (clinic_id = order.clinic_id, ACTIVE)
```

Each layer is composed via `mergePolicyWithOverlay`. The merge is
associative as long as each layer satisfies the tighten-only rule;
the resolver applies layers in **outermost-first** order so the
clinic overlay tightens what the org-wide overlay already tightened.

## Consequences

**Easier:**

- A future clinic that requires "second-pharmacist controlled-
  substance PV1" lands as one row in `workflow_policy_overlay`
  plus a single `addRequiredAttestations` field — no command-
  handler change, no test rebalance across tenants.
- The decision tree gives every engineer a one-question filter
  that prevents "I'll just branch inside `ApprovePV1`" — the
  reviewer points at this ADR.
- Existing telemetry (audit chain, outbox, command log) covers
  overlay-driven decisions for free because the overlay is just
  a parameter to the same command.

**Harder:**

- Three places to look for "why did this transition behave that
  way" — base policy, org overlay, clinic overlay. Audit metadata
  must cite all three; the Phase-5 wiring slice is responsible
  for stamping `(workflowPolicyId, workflowPolicyVersion,
overlayVersion)` on every command_log row that consumed an
  overlay.
- Overlays are versioned data; activating a new base policy
  (per ADR 0017) requires re-validating every active overlay.
- The merge function's tighten-only invariant must be preserved
  through every future field addition. Adding a new field that
  could widen base is a security regression — caught by tests
  but expensive to backout.

**Ongoing obligations:**

- Tier 2 wiring (Phase 5 follow-up) MUST read overlays inside
  the command-bus tx (RLS-protected) and stamp the resolved
  overlay version on `command_log`.
- Every new `WorkflowPolicyOverlay` field must be classified as
  **strictly subtractive** or **strictly additive**, with a unit
  test that demonstrates `mergePolicyWithOverlay` rejects the
  loosening case.
- Tier 3 remains in design freeze until at least three real-world
  customizations cannot be expressed in Tier 2.

**Deferred (out of scope for this slice):**

- The `workflow_policy_overlay` Prisma migration.
- The `UpsertWorkflowPolicyOverlay` admin command.
- Wiring `mergePolicyWithOverlay` into `defineCommand`'s
  `loadPolicy` step.
- Tier 3 command-interceptor runtime.

## Alternatives Considered

- **Fork the domain package per tenant.** Considered:
  per-clinic checkout of `@pharmax/verification` with
  hand-edited handlers. Rejected — unmaintainable at >2
  tenants; security review would have to re-audit every fork
  on every release; replay correctness becomes impossible
  because the same `commandLogId` could resolve to different
  code in different deploys.
- **Inline branches inside commands.** Considered: a `switch
(clinicId)` inside `ApprovePV1`. Rejected — explodes
  combinatorially (n clinics × m commands × k rules); dilutes
  the workflow-policy contract from ADR 0008; surfaces a
  tenant-specific failure as a generic command error rather
  than a typed overlay error.
- **Full plugin runtime now (Tier 3 today).** Considered:
  a sandboxed JS runtime with a tenant-supplied script. Rejected
  — over-engineering for current scale (zero tenants today
  need it); supervising tenant-supplied code is a meaningful
  ongoing cost (sandbox escapes, resource limits, debugging
  remote stack traces); the tighten-only invariant is much
  harder to enforce against arbitrary code than against a
  typed declarative shape.
- **A single boolean-and-map registry.** Considered: extending
  `FEATURES` to carry parameters. Rejected — conflates two
  contracts (capability vs. policy parameter) and breaks the
  SOC-2 audit story for `FEATURES` (a feature flag is NOT an
  audit event; an overlay change IS).

## References

- ADR 0007 — Twenty-step command-bus contract (overlay resolution
  will land between policy load and SoD check)
- ADR 0008 — Workflow as versioned data, not code (overlays do
  not weaken the versioned-data invariant)
- ADR 0011 — Separation of Duties (rules are NOT overlay-able;
  SoD lives in `@pharmax/rbac` registry)
- ADR 0012 — `defineCommand` factory (the `loadPolicy` step is
  where Tier 2 wiring lands)
- ADR 0017 — Workflow policy migration (overlay re-validation
  on base activation)
- Code (Tier 1): `packages/rbac/src/features.ts`,
  `packages/rbac/src/feature-flags.ts`
- Code (Tier 2 seam): `packages/workflow/src/policy-overlay.ts`,
  `packages/workflow/src/policy-overlay.test.ts`
- Code (Tier 2 contract): `packages/workflow/src/policy-v1.ts`
  (`AttestationRequirement`, `OrderWorkflowPolicy.attestationsByTransitionId`)
- Implementation plan: `docs/IMPLEMENTATION_PLAN.md` (Phase 5 —
  follow-up slice for `workflow_policy_overlay` migration +
  bus wiring)
