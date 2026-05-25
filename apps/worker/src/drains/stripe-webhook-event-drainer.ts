// Per-tick logic for the Stripe webhook event drainer.
//
// Each tick:
//   1. Atomically claims up to `batchSize` eligible rows. The claim
//      flips status to PROCESSING, increments attempts, and sets a
//      lease (next_attempt_at = NOW + leaseMs) so a crash mid-tick
//      doesn't strand the row past the lease window.
//   2. For each claimed row, calls platform-core's
//      `executeStripeWebhookEventDispatch` directly — NOT the higher-
//      level `processStripeWebhookEvent`, because the claim has
//      already done the markProcessing equivalent. Calling
//      markProcessing twice would double-increment attempts.
//   3. Catches anything that escapes the dispatcher (i.e. infra-level
//      errors mid-mark) and logs without rethrowing — the outer
//      poll-loop wrapper handles the safety net.
//
// Concurrency: handlers are dispatched serially within a tick. Cross-
// process concurrency comes from running multiple worker replicas.
// This keeps a single tick's failure domain small and avoids
// surprising connection-pool pressure on Postgres.

import { billing } from "@pharmax/platform-core";
import type { logger as loggerContract } from "@pharmax/platform-core";

import { claimStripeWebhookEvents } from "./claim-stripe-webhook-events.js";
import type {
  ClaimStripeWebhookEventsOptions,
  StripeWebhookClaimClient,
} from "./claim-stripe-webhook-events.js";
import type { ClaimedStripeWebhookEventRow } from "./row-types.js";

type Logger = loggerContract.Logger;

export interface StripeWebhookDrainerDeps {
  readonly client: StripeWebhookClaimClient;
  readonly eventStore: billing.StripeWebhookEventStore;
  readonly dispatcher: billing.StripeWebhookEventDispatcher;
  // Logger is REQUIRED so the module has no env-dependent imports.
  // The caller (worker main, tests) always knows which logger to inject.
  readonly logger: Logger;
  readonly maxAttempts?: number;
  readonly computeNextAttemptAt?: (attempt: number, now: Date) => Date | null;
}

// Reserved for future tuning (per-tick concurrency, jitter). Today
// the drainer needs nothing beyond the claim options; alias keeps the
// public surface forward-compatible.
export type StripeWebhookDrainerOptions = ClaimStripeWebhookEventsOptions;

export interface StripeWebhookDrainerTickResult {
  readonly claimed: number;
  readonly succeeded: number;
  readonly failed: number;
}

export function createStripeWebhookDrainer(
  deps: StripeWebhookDrainerDeps,
  options: StripeWebhookDrainerOptions
): { tick: () => Promise<StripeWebhookDrainerTickResult> } {
  const log = deps.logger.child({
    component: "stripe-webhook-drainer",
  });

  return {
    async tick(): Promise<StripeWebhookDrainerTickResult> {
      const claimedRows = await claimStripeWebhookEvents(deps.client, options);

      if (claimedRows.length === 0) {
        log.debug("drain.idle");
        return { claimed: 0, succeeded: 0, failed: 0 };
      }

      log.info("drain.claimed", { count: claimedRows.length });

      let succeeded = 0;
      let failed = 0;

      for (const row of claimedRows) {
        const record = toEventStoreRecord(row);
        try {
          const result = await billing.executeStripeWebhookEventDispatch(record, {
            eventStore: deps.eventStore,
            dispatcher: deps.dispatcher,
            logger: log,
            ...(deps.maxAttempts === undefined ? {} : { maxAttempts: deps.maxAttempts }),
            ...(deps.computeNextAttemptAt === undefined
              ? {}
              : { computeNextAttemptAt: deps.computeNextAttemptAt }),
          });
          if (result.status === "succeeded" || result.status === "ignored") {
            succeeded += 1;
          } else {
            failed += 1;
          }
        } catch (cause) {
          // executeStripeWebhookEventDispatch already converts handler
          // errors into markFailed writes; this catches infra failures
          // (e.g., DB connection lost during markSucceeded). The row
          // is left in PROCESSING with the lease — once it expires,
          // another worker will pick it up.
          failed += 1;
          log.error("drain.row.unhandled_error", {
            stripeEventId: row.stripeEventId,
            errorMessage: cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown",
          });
        }
      }

      log.info("drain.tick.complete", {
        claimed: claimedRows.length,
        succeeded,
        failed,
      });

      return { claimed: claimedRows.length, succeeded, failed };
    },
  };
}

// The claim returns rows whose `payload` is `Prisma.JsonValue`. The
// platform-core record type expects `Stripe.Event`. Same cast strategy
// as in `@pharmax/database/billing`.
function toEventStoreRecord(row: ClaimedStripeWebhookEventRow): billing.StripeWebhookEventRecord {
  return Object.freeze({
    id: row.id,
    stripeEventId: row.stripeEventId,
    eventType: row.eventType,
    apiVersion: row.apiVersion,
    livemode: row.livemode,
    payload: row.payload as unknown as billing.StripeWebhookEventRecord["payload"],
    status: row.status,
    attempts: row.attempts,
    lastError: row.lastError,
    receivedAt: row.receivedAt,
    signatureVerifiedAt: row.signatureVerifiedAt,
    processingStartedAt: row.processingStartedAt,
    processedAt: row.processedAt,
    nextAttemptAt: row.nextAttemptAt,
  });
}
