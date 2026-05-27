# 0002 — Modular monolith with event-driven internals

- **Status:** Accepted
- **Date:** pre-2026-05
- **Deciders:** Platform team
- **Tags:** architecture, deployment

## Context

Pharmax is an enterprise pharmacy operating system spanning RX intake,
typing, two pharmacist verification stages, filling, shipping, billing,
reporting, hardware integration (Zebra printers, scanners), and
compliance (HIPAA-aware, SOC 2-ready). A naive read of that surface
area suggests a fleet of microservices — one per domain — with
synchronous HTTP boundaries between them.

The team is small, the workflow is tightly coupled (a fill cannot
ship before a final verification, which cannot start before a fill
completes), and every critical transition needs to write to multiple
tables (`command_log`, `order_event`, `audit_log`, `event_outbox`)
**atomically**. A distributed-transaction story across microservices
would dominate the cost of every workflow command.

At the same time, we still need clean module boundaries so that domains
do not bleed into each other and so that a future extraction (e.g.
splitting the print agent into its own deployable) remains possible
without a rewrite.

## Decision

Build Pharmax as a **modular monolith with event-driven internals**.

Concretely:

- One transactional **PostgreSQL** database (see ADR 0003) is the source
  of truth. Critical state changes happen inside a single Postgres
  transaction, never across services.
- The codebase is a pnpm workspace of **domain packages**
  (`@pharmax/orders`, `@pharmax/verification`, `@pharmax/fill`,
  `@pharmax/shipping`, `@pharmax/billing`, etc.) that own their
  commands, types, and tests. ESLint boundary rules pin who may import
  what (`@prisma/client` is private to `@pharmax/database`;
  `withSystemContext` is restricted to a tight allowlist).
- Two long-running processes: `apps/web` (Next.js, thin API routes)
  and `apps/worker` (background drainer). Both share the same domain
  packages and the same database.
- Side effects are decoupled via an **outbox pattern** (see ADR 0009):
  commands write an `event_outbox` row in the same transaction as the
  state change; the worker polls the outbox and routes events to
  handlers. Producers never call consumers synchronously.
- Premature microservices are explicitly avoided.

## Consequences

**Easier:**

- Atomic critical mutations: a workflow transition writes the order
  state, the structured domain record (e.g. `verification_record`),
  the audit chain entry, and the outbox event in one transaction.
- Local dev is one Docker Compose, one Prisma migration, one Vitest
  suite. New engineers ship a command on day one.
- Refactoring across domains stays cheap; we can move a function
  from `@pharmax/orders` to `@pharmax/verification` in a single PR.

**Harder:**

- The single-Postgres-instance becomes the scaling target. We accept
  this until tenant count, write volume, or PHI residency forces a
  split. Phase 6 plans for read replicas and reporting routing.
- Deploys are one unit; a broken release in any domain can take down
  the whole web tier. We mitigate with strong typecheck/test gates
  and a kill-the-handler escape hatch on the worker.
- Cross-package contracts (command shape, event payload) must be
  enforced by code — the language compiler cannot warn us if a
  consumer reads `payload.foo` while the producer emits `payload.bar`.
  A future event schema registry (reserved ADR 0018) addresses this.

**Ongoing obligations:**

- Maintain ESLint boundary rules as the de facto module wall.
- Treat any "extract to a service" proposal as an ADR-level decision,
  not a refactor.

## Alternatives Considered

- **Microservices per domain.** Buys deployment isolation we do not
  need yet, at the cost of distributed transactions we definitely
  cannot afford. The workflow is the product; we will not split it
  arbitrarily.
- **Serverless functions (Lambda) per command.** Loses the in-process
  transaction story that makes the twenty-step command bus (ADR 0007)
  work. Reintroduces the same coordination problems microservices do.
- **Single-process synchronous monolith (no worker).** Every side
  effect runs in the request path; a slow Stripe call or printer
  retry stalls the operator's click. We need an asynchronous tier.

## References

- ADR 0003 — PostgreSQL + Prisma as the transactional source of truth
- ADR 0007 — Twenty-step command-bus contract
- ADR 0009 — Outbox pattern via database polling
- `docs/IMPLEMENTATION_PLAN.md` Phase 1 (apps/web, apps/worker baseline)
- `eslint.config.js` — boundary rules between domain packages
