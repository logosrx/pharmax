// Per-tick logic for the event outbox drainer.
//
// Each tick:
//   1. Atomically claims and leases up to `batchSize` eligible rows.
//   2. For each row: routes to a handler from the registry. A row
//      with NO registered handler is a FAILURE (retry/backoff →
//      DEAD), never a silent success — marking it DISPATCHED would
//      permanently discard the event with no replay path.
//   3. On success: marks DISPATCHED and clears nextAttemptAt/lastError.
//      On handler error: marks FAILED with exponential backoff up to
//      `maxAttempts`, after which the row is marked DEAD (terminal).
//
// Completion writes are fenced on the claim's `attempts` token so a
// handler that outlives its lease cannot overwrite the status of a
// row another worker has since re-claimed (see markDispatched).

import type { PrismaClient, OutboxStatus } from "@pharmax/database";
import type { logger as loggerContract } from "@pharmax/platform-core";
import { getMeter, withSpan } from "@pharmax/telemetry";

import { claimOutboxEvents } from "./claim-outbox-events.js";
import type { ClaimOutboxEventsOptions, OutboxClaimClient } from "./claim-outbox-events.js";
import {
  outboxHandlers as defaultHandlers,
  REQUIRED_HANDLER_EVENT_TYPES,
} from "./outbox-handlers.js";
import type { OutboxHandlerMap, OutboxPostHandlerHook } from "./outbox-handlers.js";
import type { ClaimedOutboxEventRow } from "./row-types.js";

const meter = getMeter("@pharmax/worker.outbox");

const outboxDispatchedCounter = meter.createCounter("pharmax_outbox_dispatched_total", {
  description:
    "Outbox rows handled per tick. Outcome is one of success | fail | dead. event_type is the registered event id.",
});

const outboxDeadCounter = meter.createCounter("pharmax_outbox_dead_total", {
  description: "Outbox rows that exhausted retries and were marked DEAD (terminal).",
});

const outboxClaimLagHistogram = meter.createHistogram("pharmax_outbox_claim_lag_seconds", {
  description: "Wall time between event_outbox.createdAt and the drainer claiming the row.",
  unit: "s",
  advice: { explicitBucketBoundaries: [0.5, 1, 5, 10, 30, 60, 300, 900] },
});

type Logger = loggerContract.Logger;

export interface OutboxDrainerDeps {
  // Used by the claim helper for raw SQL.
  readonly client: OutboxClaimClient & Pick<PrismaClient, "eventOutbox">;
  readonly handlers?: OutboxHandlerMap;
  // Logger is REQUIRED so the module has no env-dependent imports.
  readonly logger: Logger;
  readonly maxAttempts?: number;
  readonly clock?: () => Date;
  readonly computeNextAttemptAt?: (attempt: number, now: Date) => Date | null;
  /**
   * Event types that MUST have a handler; a row of one of these
   * types with no registered handler fails (retry → DEAD) instead
   * of being silently marked DISPATCHED. Defaults to
   * `REQUIRED_HANDLER_EVENT_TYPES`.
   */
  readonly requiredHandlerEventTypes?: ReadonlySet<string>;
  /**
   * Optional hook run for EVERY claimed row AFTER its domain handler
   * (and for rows with no handler), inside the same try: a hook
   * throw routes the row through the FAILED/backoff path exactly
   * like a handler throw. Production wires partner webhook fan-out
   * here (`createWebhookFanOutHook`) — the hook self-filters, so
   * the handler map stays a pure domain registry.
   */
  readonly postHandlerHook?: OutboxPostHandlerHook;
}

export type OutboxDrainerOptions = ClaimOutboxEventsOptions;

export interface OutboxDrainerTickResult {
  readonly claimed: number;
  readonly dispatched: number;
  readonly failed: number;
  readonly dead: number;
  /**
   * Rows whose completion update matched nothing because another
   * worker re-claimed the row after this worker's lease expired
   * (fenced write — see markDispatched/markFailed). The re-claimer
   * owns the row's final status; this worker's outcome is discarded.
   */
  readonly leaseLost: number;
}

const DEFAULT_MAX_ATTEMPTS = 8;

function defaultBackoff(attempt: number, now: Date): Date | null {
  // Exponential backoff: 30s, 1m, 2m, 4m, 8m, 16m, 32m, 64m.
  if (attempt >= DEFAULT_MAX_ATTEMPTS) {
    return null;
  }
  const seconds = 30 * 2 ** (attempt - 1);
  return new Date(now.getTime() + seconds * 1000);
}

function describeError(cause: unknown): string {
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`;
  }
  return "Unknown error";
}

export function createOutboxDrainer(
  deps: OutboxDrainerDeps,
  options: OutboxDrainerOptions
): { tick: () => Promise<OutboxDrainerTickResult> } {
  const log = deps.logger.child({
    component: "outbox-drainer",
  });
  const clock = deps.clock ?? (() => new Date());
  const handlers = deps.handlers ?? defaultHandlers;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const computeNextAttemptAt = deps.computeNextAttemptAt ?? defaultBackoff;
  const requiredHandlerEventTypes = deps.requiredHandlerEventTypes ?? REQUIRED_HANDLER_EVENT_TYPES;

  return {
    async tick(): Promise<OutboxDrainerTickResult> {
      const claimedRows = await claimOutboxEvents(deps.client, options);

      if (claimedRows.length === 0) {
        log.debug("drain.idle");
        return { claimed: 0, dispatched: 0, failed: 0, dead: 0, leaseLost: 0 };
      }

      log.info("drain.claimed", { count: claimedRows.length });

      let dispatched = 0;
      let failed = 0;
      let dead = 0;
      let leaseLost = 0;

      for (const row of claimedRows) {
        const handler = handlers[row.eventType];
        const rowLog = log.child({
          outboxId: row.id,
          eventType: row.eventType,
          aggregateType: row.aggregateType,
          aggregateId: row.aggregateId,
          attempts: row.attempts,
        });
        const eventTypeLabel = { event_type: row.eventType };

        // Record claim lag — wall time the row spent waiting between
        // commit (createdAt) and being picked up by the drainer.
        // High p99 indicates the drainer is backlogged or the claim
        // batch size is too small.
        const claimLagSeconds = Math.max(0, (clock().getTime() - row.createdAt.getTime()) / 1000);
        outboxClaimLagHistogram.record(claimLagSeconds);

        try {
          // Consumer span resuming the producing command's trace via
          // the persisted traceparent (the DB-backed hop has no HTTP
          // request for auto-instrumentation to propagate through).
          // A handler/hook throw is recorded on the span and rethrown
          // into the existing FAILED/backoff path below. Attributes
          // are ids + event types only — never payload contents.
          await withSpan(
            {
              tracerName: "@pharmax/worker.outbox",
              spanName: `outbox.process ${row.eventType}`,
              kind: "consumer",
              parentTraceparent: row.traceparent,
              attributes: {
                "pharmax.outbox_id": row.id,
                "pharmax.event_type": row.eventType,
                "pharmax.aggregate_type": row.aggregateType,
                "pharmax.organization_id": row.organizationId,
                "pharmax.attempts": row.attempts,
              },
            },
            async () => {
              if (handler === undefined) {
                if (requiredHandlerEventTypes.has(row.eventType)) {
                  // This event's side effect is load-bearing. Treating a
                  // missing handler as success would permanently discard
                  // it: rows marked DISPATCHED are never replayed, so
                  // wiring the handler later cannot recover the missed
                  // side effects (this is exactly how emergency-
                  // escalation alerts silently vanished). Route through
                  // the retry/backoff path — the row stays visible
                  // (FAILED, then DEAD with a clear lastError) and an
                  // admin re-publish can replay it once the handler
                  // ships.
                  throw new Error(
                    `No outbox handler registered for REQUIRED event type "${row.eventType}"`
                  );
                }
                // Benign no-op: an event with no consumer yet.
                rowLog.warn("drain.row.no_handler_registered");
              } else {
                await handler(row, { logger: rowLog, receivedAt: row.createdAt });
              }
              if (deps.postHandlerHook !== undefined) {
                await deps.postHandlerHook(row, { logger: rowLog, receivedAt: row.createdAt });
              }
            }
          );

          const fenced = await markDispatched(deps.client, {
            id: row.id,
            attempts: row.attempts,
            dispatchedAt: clock(),
          });
          if (!fenced) {
            leaseLost += 1;
            outboxDispatchedCounter.add(1, { ...eventTypeLabel, outcome: "lease_lost" });
            rowLog.warn("drain.row.lease_lost", {
              detail:
                "handler outlived the claim lease; another worker re-claimed the row and owns its final status",
            });
            continue;
          }
          dispatched += 1;
          outboxDispatchedCounter.add(1, { ...eventTypeLabel, outcome: "success" });
          rowLog.info("drain.row.dispatched");
        } catch (cause) {
          const failedAt = clock();
          const nextAttemptAt =
            row.attempts >= maxAttempts ? null : computeNextAttemptAt(row.attempts, failedAt);
          const terminal = nextAttemptAt === null;

          const fenced = await markFailed(deps.client, {
            id: row.id,
            attempts: row.attempts,
            status: terminal ? "DEAD" : "FAILED",
            lastError: describeError(cause),
            nextAttemptAt,
          });
          if (!fenced) {
            leaseLost += 1;
            outboxDispatchedCounter.add(1, { ...eventTypeLabel, outcome: "lease_lost" });
            rowLog.warn("drain.row.lease_lost", {
              detail:
                "handler outlived the claim lease; another worker re-claimed the row and owns its final status",
            });
            continue;
          }

          if (terminal) {
            dead += 1;
            outboxDeadCounter.add(1, eventTypeLabel);
            outboxDispatchedCounter.add(1, { ...eventTypeLabel, outcome: "dead" });
            rowLog.error("drain.row.dead", {
              errorMessage: describeError(cause),
            });
          } else {
            failed += 1;
            outboxDispatchedCounter.add(1, { ...eventTypeLabel, outcome: "fail" });
            rowLog.warn("drain.row.failed", {
              errorMessage: describeError(cause),
              willRetry: true,
            });
          }
        }
      }

      log.info("drain.tick.complete", {
        claimed: claimedRows.length,
        dispatched,
        failed,
        dead,
        leaseLost,
      });

      return { claimed: claimedRows.length, dispatched, failed, dead, leaseLost };
    },
  };
}

// Completion writes are FENCED on the claim's `attempts` value.
//
// The claim bumps `attempts` atomically, so `attempts` acts as a
// lease token: if this worker's handler outlives the lease and a
// second worker re-claims the row, the second claim bumps
// `attempts` again and THIS worker's completion update matches zero
// rows. Without the fence, whichever worker finished LAST silently
// overwrote the other's status — a slow handler could flip a row
// another worker had already retried (or vice versa), and both
// workers' side effects raced with no record of the duplication.

interface MarkDispatchedInput {
  readonly id: string;
  /** Claim-time attempts value — the fence token. */
  readonly attempts: number;
  readonly dispatchedAt: Date;
}

/** Returns false when the fence missed (row re-claimed by another worker). */
async function markDispatched(
  client: Pick<PrismaClient, "eventOutbox">,
  input: MarkDispatchedInput
): Promise<boolean> {
  const result = await client.eventOutbox.updateMany({
    where: { id: input.id, attempts: input.attempts },
    data: {
      status: "DISPATCHED",
      dispatchedAt: input.dispatchedAt,
      lastError: null,
      nextAttemptAt: null,
    },
  });
  return result.count === 1;
}

interface MarkFailedInput {
  readonly id: string;
  /** Claim-time attempts value — the fence token. */
  readonly attempts: number;
  readonly status: Extract<OutboxStatus, "FAILED" | "DEAD">;
  readonly lastError: string;
  readonly nextAttemptAt: Date | null;
}

/** Returns false when the fence missed (row re-claimed by another worker). */
async function markFailed(
  client: Pick<PrismaClient, "eventOutbox">,
  input: MarkFailedInput
): Promise<boolean> {
  const result = await client.eventOutbox.updateMany({
    where: { id: input.id, attempts: input.attempts },
    data: {
      status: input.status,
      lastError: input.lastError,
      nextAttemptAt: input.nextAttemptAt,
    },
  });
  return result.count === 1;
}

// Re-exported for tests so they can provide a typed claimed-row fixture.
export type { ClaimedOutboxEventRow };
