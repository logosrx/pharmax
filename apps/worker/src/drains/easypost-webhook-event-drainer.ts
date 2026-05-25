// Per-tick logic for the EasyPost webhook event drainer.
//
// Mirrors `stripe-webhook-event-drainer.ts` one-for-one. Each tick:
//   1. Atomically claims up to `batchSize` eligible rows. The claim
//      flips status to PROCESSING, increments attempts, and sets a
//      lease (next_attempt_at = NOW + leaseMs) so a crash mid-tick
//      doesn't strand the row past the lease window.
//   2. For each claimed row, calls
//      `executeEasyPostWebhookEventDispatch` directly — NOT the
//      higher-level `processEasyPostWebhookEvent`, because the claim
//      has already done the markProcessing equivalent. Calling
//      markProcessing twice would double-increment attempts.
//   3. Catches anything that escapes the dispatcher and logs without
//      rethrowing — the outer poll-loop wrapper handles the safety
//      net.
//
// Concurrency: handlers are dispatched serially within a tick. Cross-
// process concurrency comes from running multiple worker replicas.

import {
  executeEasyPostWebhookEventDispatch,
  type EasyPostWebhookEventRecord,
  type EasyPostWebhookEventStore,
  type WebhookTargetResolver,
} from "@pharmax/shipping";
import type { logger as loggerContract } from "@pharmax/platform-core";

import {
  claimEasyPostWebhookEvents,
  type ClaimEasyPostWebhookEventsOptions,
  type EasyPostWebhookClaimClient,
} from "./claim-easypost-webhook-events.js";
import type { ClaimedEasyPostWebhookEventRow } from "./row-types.js";

type Logger = loggerContract.Logger;

export interface EasyPostWebhookDrainerDeps {
  readonly client: EasyPostWebhookClaimClient;
  readonly eventStore: EasyPostWebhookEventStore;
  readonly targetResolver: WebhookTargetResolver;
  readonly logger: Logger;
  readonly maxAttempts?: number;
  readonly computeNextAttemptAt?: (attempt: number, now: Date) => Date | null;
}

export type EasyPostWebhookDrainerOptions = ClaimEasyPostWebhookEventsOptions;

export interface EasyPostWebhookDrainerTickResult {
  readonly claimed: number;
  readonly succeeded: number;
  readonly failed: number;
}

export function createEasyPostWebhookDrainer(
  deps: EasyPostWebhookDrainerDeps,
  options: EasyPostWebhookDrainerOptions
): { tick: () => Promise<EasyPostWebhookDrainerTickResult> } {
  const log = deps.logger.child({ component: "easypost-webhook-drainer" });

  return {
    async tick(): Promise<EasyPostWebhookDrainerTickResult> {
      const claimedRows = await claimEasyPostWebhookEvents(deps.client, options);

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
          const result = await executeEasyPostWebhookEventDispatch(record, {
            eventStore: deps.eventStore,
            targetResolver: deps.targetResolver,
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
          // executeEasyPostWebhookEventDispatch already converts
          // handler errors into markFailed writes; this catches infra
          // failures (e.g., DB connection lost during markSucceeded).
          // The row is left in PROCESSING with the lease — once it
          // expires, another worker will pick it up.
          failed += 1;
          log.error("drain.row.unhandled_error", {
            externalEventId: row.externalEventId,
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

function toEventStoreRecord(row: ClaimedEasyPostWebhookEventRow): EasyPostWebhookEventRecord {
  return Object.freeze({
    id: row.id,
    externalEventId: row.externalEventId,
    eventType: row.eventType,
    trackingCode: row.trackingCode,
    carrierStatus: row.carrierStatus,
    payload: row.payload as unknown as EasyPostWebhookEventRecord["payload"],
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
