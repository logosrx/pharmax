// Per-tick logic for the event outbox drainer.
//
// Each tick:
//   1. Atomically claims and leases up to `batchSize` eligible rows.
//   2. For each row: routes to a handler from the registry, or treats
//      the row as a no-op success when no handler is registered.
//   3. On success: marks DISPATCHED and clears nextAttemptAt/lastError.
//      On handler error: marks FAILED with exponential backoff up to
//      `maxAttempts`, after which the row is marked DEAD (terminal).
//
// "No handler registered" is logged at WARN to surface mis-wired
// commands during dev, but is treated as success so the outbox doesn't
// accumulate. When a handler is registered later, future events of
// that type will be routed correctly. Past DISPATCHED rows are not
// re-dispatched; that is the responsibility of an admin-driven
// re-publish flow which is out of scope for Phase 1.

import type { PrismaClient, EventOutbox, OutboxStatus } from "@pharmax/database";
import type { logger as loggerContract } from "@pharmax/platform-core";

import { claimOutboxEvents } from "./claim-outbox-events.js";
import type { ClaimOutboxEventsOptions, OutboxClaimClient } from "./claim-outbox-events.js";
import { outboxHandlers as defaultHandlers } from "./outbox-handlers.js";
import type { OutboxHandlerMap } from "./outbox-handlers.js";
import type { ClaimedOutboxEventRow } from "./row-types.js";

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
}

export type OutboxDrainerOptions = ClaimOutboxEventsOptions;

export interface OutboxDrainerTickResult {
  readonly claimed: number;
  readonly dispatched: number;
  readonly failed: number;
  readonly dead: number;
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

  return {
    async tick(): Promise<OutboxDrainerTickResult> {
      const claimedRows = await claimOutboxEvents(deps.client, options);

      if (claimedRows.length === 0) {
        log.debug("drain.idle");
        return { claimed: 0, dispatched: 0, failed: 0, dead: 0 };
      }

      log.info("drain.claimed", { count: claimedRows.length });

      let dispatched = 0;
      let failed = 0;
      let dead = 0;

      for (const row of claimedRows) {
        const handler = handlers[row.eventType];
        const rowLog = log.child({
          outboxId: row.id,
          eventType: row.eventType,
          aggregateType: row.aggregateType,
          aggregateId: row.aggregateId,
          attempts: row.attempts,
        });

        try {
          if (handler === undefined) {
            rowLog.warn("drain.row.no_handler_registered");
          } else {
            await handler(row, { logger: rowLog, receivedAt: row.createdAt });
          }

          await markDispatched(deps.client, row.id, clock());
          dispatched += 1;
          rowLog.info("drain.row.dispatched");
        } catch (cause) {
          const failedAt = clock();
          const nextAttemptAt =
            row.attempts >= maxAttempts ? null : computeNextAttemptAt(row.attempts, failedAt);
          const terminal = nextAttemptAt === null;

          await markFailed(deps.client, {
            id: row.id,
            status: terminal ? "DEAD" : "FAILED",
            lastError: describeError(cause),
            nextAttemptAt,
          });

          if (terminal) {
            dead += 1;
            rowLog.error("drain.row.dead", {
              errorMessage: describeError(cause),
            });
          } else {
            failed += 1;
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
      });

      return { claimed: claimedRows.length, dispatched, failed, dead };
    },
  };
}

async function markDispatched(
  client: Pick<PrismaClient, "eventOutbox">,
  id: string,
  dispatchedAt: Date
): Promise<EventOutbox> {
  return client.eventOutbox.update({
    where: { id },
    data: {
      status: "DISPATCHED",
      dispatchedAt,
      lastError: null,
      nextAttemptAt: null,
    },
  });
}

interface MarkFailedInput {
  readonly id: string;
  readonly status: Extract<OutboxStatus, "FAILED" | "DEAD">;
  readonly lastError: string;
  readonly nextAttemptAt: Date | null;
}

async function markFailed(
  client: Pick<PrismaClient, "eventOutbox">,
  input: MarkFailedInput
): Promise<EventOutbox> {
  return client.eventOutbox.update({
    where: { id: input.id },
    data: {
      status: input.status,
      lastError: input.lastError,
      nextAttemptAt: input.nextAttemptAt,
    },
  });
}

// Re-exported for tests so they can provide a typed claimed-row fixture.
export type { ClaimedOutboxEventRow };
