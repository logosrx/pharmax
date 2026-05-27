# 0009 — Outbox pattern via database polling, not BullMQ

- **Status:** Accepted
- **Date:** pre-2026-05
- **Deciders:** Platform team
- **Tags:** infrastructure, eventing, workers

## Context

The command bus (ADR 0007) writes an `event_outbox` row in the same
transaction as the workflow state change. Downstream consumers
(billing materialization, Stripe push, label generation, notifications,
reporting projections) need to act on those events **reliably and
at-least-once**, with no risk of "the event was sent but the
transaction rolled back" or "the transaction committed but the event
was lost".

The fundamental question is **where the source of truth lives**. If
the outbox table is the source of truth, an external queue (BullMQ,
SQS, NATS) is a cache in front of it — a second component that can
drift, fail, or lose messages, with no correctness benefit. If the
external queue is the source of truth, the transactional atomicity
guarantee of ADR 0007 collapses (committing the tx and enqueuing the
message are two operations across two systems with no two-phase
commit).

At present every Pharmax background task is event-driven projection.
None of them need queue-shaped features like priority lanes,
delayed-until-X scheduling, or fan-out to many independent consumers.

## Decision

Implement the outbox as a **DB-polled drainer**. The `event_outbox`
table **is** the source of truth.

- `apps/worker` runs a polling loop that issues
  `UPDATE event_outbox SET claimedAt = now(), claimedBy = ... WHERE
id IN (SELECT id FROM event_outbox WHERE processedAt IS NULL ...
FOR UPDATE SKIP LOCKED LIMIT N)` to atomically claim a batch with
  a lease, dispatches each row through the registered handler, and
  marks the row processed (or surfaces a failure for retry).
- `stripe_webhook_event` and `easypost_webhook_event` follow the
  same pattern: webhook receivers write the raw event to an inbox
  table inside their signature-verified handler; the worker claims
  and processes.
- Graceful shutdown (SIGINT/SIGTERM) waits for in-flight handlers
  to finish before exiting; uncommitted leases time out and become
  re-claimable.
- **BullMQ is explicitly deferred** until a true queue-driven job
  appears — a label-render that needs priority lanes, a notification
  scheduler with delayed delivery, a fan-out to many independent
  consumers. The day that arrives, the outbox stays as the durable
  source of truth and a queue worker becomes one more consumer of
  it.

## Consequences

**Easier:**

- The atomicity guarantee of ADR 0007 is preserved by construction:
  the outbox row commits or it does not, in the same tx as the
  workflow write.
- Replay is trivial — reset `processedAt` on a row and the next
  drainer tick re-runs the handler.
- Local dev needs no Redis-for-queue (Redis still has its session/
  cache/idempotency roles, but the worker boots without it).
- Visibility is excellent: every outbox row is in the database,
  queryable with SQL, joinable to its originating `command_log` row
  via `correlationId`.

**Harder:**

- Polling latency is real — currently bounded by the drainer's tick
  interval. For human-facing UI ("did the label print yet?"), we
  acknowledge the click optimistically and reconcile via the
  workflow state on the next page render.
- The outbox table grows. We accept this and plan an
  archive/truncate job in Phase 6 hardening.
- True priority queueing is not available. A backlog of
  notifications competes for drainer slots with billing
  materialization. The day that becomes a problem we add BullMQ.

**Ongoing obligations:**

- New outbox events are registered in
  `apps/worker/src/drains/outbox-handlers.ts`.
- A handler that fails leaves the row unprocessed for re-claim;
  poison-pill handling (retry budget, dead-letter routing) is
  Phase 6 work.

## Alternatives Considered

- **BullMQ over Redis.** Excellent queue, wrong source of truth.
  The double-commit (DB + Redis) breaks ADR 0007 atomicity.
- **Postgres `LISTEN`/`NOTIFY`.** Push-based but lossy on connection
  drops; insufficient for at-least-once delivery without an outbox
  table anyway, so we keep the outbox and skip the LISTEN layer.
- **Logical replication / CDC.** Heavy operational tax for the
  current scale; reconsider when read replicas land.

## References

- ADR 0007 — Twenty-step command-bus contract (writes outbox in tx)
- `apps/worker/src/main.ts` — drainer loop, claim SQL
- `apps/worker/src/drains/outbox-handlers.ts` — registered handlers
- `docs/IMPLEMENTATION_PLAN.md` Phase 1 (worker baseline note: "BullMQ deferred")
- `docs/ARCHITECTURE_PRINCIPLES.md` §B.5
