# 0016 — Composition root for split-friendly apps

- **Status:** Accepted
- **Date:** 2026-05-25
- **Deciders:** Platform team
- **Tags:** architecture, dx, bootstrap, monolith

## Context

Pharmax ships as a two-process modular monolith today: `apps/web`
(Next.js — operator console, public API, webhook ingress) and
`apps/worker` (drains the outbox, polls carriers, reconciles
billing). Both processes wire the same five subsystems at boot:

1. `configureCrypto` (`@pharmax/crypto`) — KMS adapter.
2. `configureRbac` (`@pharmax/rbac`) — permission loader.
3. `configureCommandBus` (`@pharmax/command-bus`) — prisma + clock +
   logger.
4. `configureShipping` (`@pharmax/shipping`) — per-provider adapter
   factories (EasyPost, FedEx, UPS).
5. `configureBilling` (`@pharmax/billing`) — Stripe refund port (or
   `null` when STRIPE_SECRET_KEY is unset).

The **ordering matters** — crypto must be ready before any code path
that touches PHI; RBAC must be wired before the command bus, since
the bus's dispatch step invokes `requirePermission`; the bus must be
wired before shipping/billing, since their commands dispatch through
`executeCommand`. Until ADR 0016 the ordering was implicit, enforced
only by code review, and **duplicated across two entry points**.

Predictable next services on the horizon — splitting `apps/web` into
a public-API service, an operator-console service, and a webhook
receiver (ADR 0022 also depends on this shape for the multi-region
seam) — would have meant copy-pasting the configure-sequence into
each new entry point and praying the ordering survived.

The five new packages on the medium-horizon roadmap
(`@pharmax/notifications`, `@pharmax/documents`,
`@pharmax/events`, and forthcoming Workflow policy lifecycle wiring
from ADR 0017 / overlay wiring from ADR 0019) need a declarative slot
to register their own `configure*` step without modifying every entry
point.

## Decision

Adopt a typed, ordering-aware composition root in a new package
`@pharmax/composition`. Every entry point (`apps/web`, `apps/worker`,
future split services, scripts) boots via `await
buildCompositionRoot({...})` instead of calling each `configure*`
directly.

**Configurator interface** (`{ name, priority, apply }`) wraps each
package's `configure*` call. Built-in priorities are numbered with
gaps so new packages can slot in:

| Priority | Built-in    | Why this order                            |
| -------- | ----------- | ----------------------------------------- |
| 10       | crypto      | Required before any PHI read/write        |
| 20       | rbac        | Required before command-bus dispatch      |
| 30       | command-bus | Required before shipping/billing dispatch |
| 40       | shipping    | Reads decrypted carrier credentials       |
| 50       | billing     | Stripe refund port                        |

`BuildCompositionRootInput.extraConfigurators` lets forthcoming
packages register a `Configurator` without touching the built-in
list — a `documents` step that must run after crypto but before the
bus picks `priority: 15`.

**Boot-time invariants enforced in one place:**

- Production guard — refuses to boot if `NODE_ENV === "production"`
  and `input.kms.constructor.name === "LocalKmsAdapter"`. Promoting
  the dev seed-derived adapter to prod would put PHI under a key
  with no HSM custody.
- Seed sanity — re-asserts `PHARMAX_LOCAL_KMS_SEED >= 32 chars` so a
  misconfig fails loudly regardless of entry point. The composition
  root **cannot** detect that web and worker were started with
  _different_ seeds (the processes don't talk pre-traffic); this
  remains an operational rule (single source of truth in the secrets
  manager).
- Duplicate-name detection — two configurators with the same `name`
  is a boot error.
- Idempotency cache — repeated `buildCompositionRoot` calls return
  the same frozen root, matching the existing `let booted = false`
  guard pattern (necessary for Next.js dev HMR).

**Returned `CompositionRoot`** is a frozen object exposing every
wired adapter plus an `appliedConfigurators` manifest. Routes and
drains may take a `CompositionRoot` parameter for explicit dependency
passing; module-level `getXConfiguration()` singletons still work for
the existing call sites.

The raw `configure*` functions are re-exported from
`@pharmax/composition` as a transitional convenience, letting
incremental migration happen file-by-file rather than as a flag day.

## Consequences

**Pros**

- Splitting `apps/web` into 3+ services is now mechanical: each new
  service calls `buildCompositionRoot` then runs its own routes.
- Ordering is enforced by numeric priority, asserted by the
  manifest, and testable in isolation.
- New packages register via `extraConfigurators` — no app-level
  edits required.
- Production guard centralizes the LocalKMS rejection so a future
  entry point cannot forget it.

**Cons**

- Small package overhead — five built-in configurator wrappers and a
  types file (~28 KB total).
- The cached root is process-wide module state; tests that need a
  fresh root call `resetCompositionRootForTests()` (mirrors existing
  `resetXForTests` patterns).
- The composition root cannot detect cross-process seed mismatch
  between web and worker — documented as an operational rule.

## Alternatives Considered

- **NestJS-style DI container.** Rejected — too heavy for the
  existing `configure*` pattern; would require rewriting every
  package's boot surface.
- **Keep the duplicated sequence in each app.** Rejected — the
  problem this ADR exists to solve. Doesn't survive the first split.
- **Topological sort over declared dependencies.** Considered but
  rejected for now — numeric priorities are easier to reason about
  with five subsystems; revisit if the configurator count grows past
  ~15 or if dependency edges become non-linear.

## References

- ADR 0002 — Modular monolith with event-driven internals
- ADR 0007 — Twenty-step command-bus contract (ordering downstream)
- ADR 0014 — Stripe ports + adapters (billing configurator inputs)
- ADR 0020 — Notification channel abstraction (future configurator)
- ADR 0021 — Document storage abstraction (future configurator)
- ADR 0022 — Multi-region tenancy seams (depends on this shape for
  per-region entry points)
