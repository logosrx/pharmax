// Per-tick logic for the FedEx AIV webhook event drainer.
//
// Mirrors `easypost-webhook-event-drainer.ts` one-for-one: atomic
// claim (PENDING/FAILED → PROCESSING with attempts bump + lease),
// then `executeFedExWebhookEventDispatch` per row — NOT the
// higher-level `processFedExWebhookEvent`, because the claim already
// did the markProcessing equivalent.

import {
  executeFedExWebhookEventDispatch,
  type FedExWebhookEventRecord,
  type FedExWebhookEventStore,
  type FedExWebhookTargetResolver,
} from "@pharmax/shipping";
import type { logger as loggerContract } from "@pharmax/platform-core";

import {
  claimFedExWebhookEvents,
  type ClaimFedExWebhookEventsOptions,
  type FedExWebhookClaimClient,
} from "./claim-fedex-webhook-events.js";
import type { ClaimedFedExWebhookEventRow } from "./row-types.js";

type Logger = loggerContract.Logger;

export interface FedExWebhookDrainerDeps {
  readonly client: FedExWebhookClaimClient;
  readonly eventStore: FedExWebhookEventStore;
  readonly targetResolver: FedExWebhookTargetResolver;
  readonly logger: Logger;
  readonly maxAttempts?: number;
  readonly computeNextAttemptAt?: (attempt: number, now: Date) => Date | null;
}

export type FedExWebhookDrainerOptions = ClaimFedExWebhookEventsOptions;

export interface FedExWebhookDrainerTickResult {
  readonly claimed: number;
  readonly succeeded: number;
  readonly failed: number;
}

export function createFedExWebhookDrainer(
  deps: FedExWebhookDrainerDeps,
  options: FedExWebhookDrainerOptions
): { tick: () => Promise<FedExWebhookDrainerTickResult> } {
  const log = deps.logger.child({ component: "fedex-webhook-drainer" });

  return {
    async tick(): Promise<FedExWebhookDrainerTickResult> {
      const claimedRows = await claimFedExWebhookEvents(deps.client, options);

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
          const result = await executeFedExWebhookEventDispatch(record, {
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
          // The dispatcher converts handler errors into markFailed
          // writes; this catches infra failures (e.g. DB connection
          // lost during markSucceeded). The row stays PROCESSING with
          // its lease — another worker picks it up after expiry.
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

function toEventStoreRecord(row: ClaimedFedExWebhookEventRow): FedExWebhookEventRecord {
  return Object.freeze({
    id: row.id,
    externalEventId: row.externalEventId,
    eventType: row.eventType,
    trackingNumber: row.trackingNumber,
    carrierStatus: row.carrierStatus,
    payload: row.payload as unknown as FedExWebhookEventRecord["payload"],
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
