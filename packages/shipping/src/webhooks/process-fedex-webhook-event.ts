// Worker entry points for draining `fedex_webhook_event` rows.
//
// Same two-entry-point split as the EasyPost pipeline:
//   1. `processFedExWebhookEvent(externalEventId, deps)` — look up,
//      markProcessing, dispatch, mark outcome. Admin retries + tests.
//   2. `executeFedExWebhookEventDispatch(record, deps)` — the inner
//      dispatch half for the production drain, which has ALREADY
//      claimed the row atomically (attempts bumped by the claim).
//
// Dispatch semantics: one webhook delivery can carry MULTIPLE
// tracking numbers, each with a full scan history. For each entry:
//   - resolve the shipment via the caller-provided resolver
//     (system-context read lives in the worker, not here),
//   - normalize with the SAME `normalizeFedExTrackResult` the
//     polling channel uses (identical externalEventIds → webhook
//     pushes and polls of the same scan deduplicate at the
//     shipment_tracking_event unique constraint),
//   - dispatch `RecordShipmentTrackingEvent` per scan, oldest-first,
//     inside the org's tenancy; duplicate-event conflicts count as
//     success.
//
// An entry whose tracking number matches no shipment is a RETRYABLE
// failure (the shipment row may not have committed yet — same race
// the EasyPost pipeline documents). Entries that resolve are still
// dispatched before the row is marked FAILED for the unresolved
// remainder; re-dispatch on retry is safe because every event is
// idempotent at the constraint layer.

import { executeCommand } from "@pharmax/command-bus";
import { errors, type logger as loggerContract } from "@pharmax/platform-core";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";
import { ulid } from "ulid";

import type { FedExTrackResult } from "../carriers/fedex-client.js";
import {
  normalizeFedExTrackResult,
  pickEstimatedDeliveryAt,
} from "../carriers/fedex-track-normalization.js";
import { RecordShipmentTrackingEvent } from "../commands/record-shipment-tracking-event.js";

import { FedExWebhookEventNotFoundError } from "./errors.js";
import type { FedExWebhookEventRecord, FedExWebhookEventStore } from "./fedex-event-store.js";
import type { ResolvedWebhookTarget } from "./process-easypost-webhook-event.js";

type Logger = loggerContract.Logger;

/**
 * Resolves a FedEx tracking number to the tenant + shipment + actor
 * tuple. Implementations perform the system-context reads themselves
 * (worker layer); return `null` when no shipment matches YET.
 */
export interface FedExWebhookTargetResolver {
  resolve(trackingNumber: string): Promise<ResolvedWebhookTarget | null>;
}

export interface ProcessFedExWebhookEventDeps {
  readonly eventStore: FedExWebhookEventStore;
  readonly targetResolver: FedExWebhookTargetResolver;
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly maxAttempts?: number;
  readonly computeNextAttemptAt?: (attempt: number, now: Date) => Date | null;
}

export type ProcessFedExWebhookEventResult =
  | { readonly status: "succeeded"; readonly record: FedExWebhookEventRecord }
  | { readonly status: "ignored"; readonly record: FedExWebhookEventRecord }
  | {
      readonly status: "failed";
      readonly record: FedExWebhookEventRecord;
      readonly retryScheduledFor: Date | null;
    };

const DEFAULT_MAX_ATTEMPTS = 8;

function defaultBackoff(attempt: number, now: Date): Date | null {
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

function isDuplicateEventError(cause: unknown): boolean {
  const code = (cause as { code?: string } | undefined)?.code;
  return (
    code === "COMMAND_IDEMPOTENCY_PAYLOAD_MISMATCH" || code === "SHIPMENT_TRACKING_DUPLICATE_EVENT"
  );
}

export async function processFedExWebhookEvent(
  externalEventId: string,
  deps: ProcessFedExWebhookEventDeps
): Promise<ProcessFedExWebhookEventResult> {
  const clock = deps.clock ?? (() => new Date());
  const log = deps.logger.child({
    component: "fedex.webhook.worker",
    externalEventId,
  });

  const existing = await deps.eventStore.findByExternalEventId(externalEventId);
  if (existing === null) {
    throw new FedExWebhookEventNotFoundError(externalEventId);
  }

  if (existing.status === "SUCCEEDED") {
    log.debug("fedex.webhook.worker.already_succeeded");
    return { status: "succeeded", record: existing };
  }

  if (existing.status === "IGNORED") {
    log.debug("fedex.webhook.worker.already_ignored");
    return { status: "ignored", record: existing };
  }

  const processing = await deps.eventStore.markProcessing(externalEventId, clock());
  return executeFedExWebhookEventDispatch(processing, deps);
}

export async function executeFedExWebhookEventDispatch(
  record: FedExWebhookEventRecord,
  deps: ProcessFedExWebhookEventDeps
): Promise<ProcessFedExWebhookEventResult> {
  const clock = deps.clock ?? (() => new Date());
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const computeNextAttemptAt = deps.computeNextAttemptAt ?? defaultBackoff;
  const log = deps.logger.child({
    component: "fedex.webhook.worker",
    externalEventId: record.externalEventId,
  });

  try {
    const entries = record.payload.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new errors.ValidationError({
        code: "FEDEX_WEBHOOK_EMPTY_PAYLOAD",
        message: "FedEx webhook stored payload has no track entries.",
      });
    }

    const unresolved: string[] = [];
    let dispatched = 0;

    for (const entry of entries) {
      const trackingNumber = entry.trackingNumber;
      const trackResult = entry.trackResult as FedExTrackResult;

      const target = await deps.targetResolver.resolve(trackingNumber);
      if (target === null) {
        unresolved.push(trackingNumber);
        continue;
      }

      const events = normalizeFedExTrackResult({ trackingNumber, trackResult });
      if (events.length === 0) {
        log.warn("fedex.webhook.worker.no_usable_events", { trackingNumber });
        continue;
      }
      const estimatedDeliveryAt = pickEstimatedDeliveryAt(trackResult);
      const newestEventId = events[events.length - 1]?.externalEventId;

      for (const event of events) {
        const ctx = buildTenancyContext({
          organizationId: target.organizationId,
          actor: { userId: target.actorUserId, correlationId: ulid() },
        });

        try {
          await withTenancyContext(ctx, async () => {
            await executeCommand(
              RecordShipmentTrackingEvent,
              {
                shipmentId: target.shipmentId,
                source: "FEDEX",
                externalEventId: event.externalEventId,
                kind: event.kind,
                carrierStatus: event.carrierStatus,
                ...(event.carrierStatusDetail !== null
                  ? { carrierStatusDetail: event.carrierStatusDetail }
                  : {}),
                occurredAt: event.occurredAt.toISOString(),
                signatureVerifiedAt: record.signatureVerifiedAt.toISOString(),
                ...(event.scanCity !== null ? { scanCity: event.scanCity } : {}),
                ...(event.scanStateOrProvince !== null
                  ? { scanStateOrProvince: event.scanStateOrProvince }
                  : {}),
                ...(event.scanCountry !== null ? { scanCountry: event.scanCountry } : {}),
                ...(estimatedDeliveryAt !== null && event.externalEventId === newestEventId
                  ? { estimatedDeliveryAt: estimatedDeliveryAt.toISOString() }
                  : {}),
                rawPayload: event.rawPayload,
              },
              // Same idempotency-key namespace as the poller — the
              // bus cache short-circuits whichever channel arrives
              // second.
              { idempotencyKey: `fedex-poll:${event.externalEventId}` }
            );
          });
          dispatched += 1;
        } catch (cause) {
          if (isDuplicateEventError(cause)) {
            // The poller (or an earlier webhook delivery) already
            // recorded this scan — terminal success for this event.
            dispatched += 1;
          } else {
            throw cause;
          }
        }
      }
    }

    if (unresolved.length > 0) {
      // Same reasoning as the EasyPost pipeline: an unknown tracking
      // number is usually a race with the purchase transaction, not
      // garbage. Retry; a delivery that never matches goes
      // FAILED-terminal and stays visible for reconciliation.
      // Already-resolved entries were dispatched above and are
      // idempotent on retry.
      throw new errors.NotFoundError({
        code: "FEDEX_WEBHOOK_UNKNOWN_TARGET",
        message: `No shipment matches ${unresolved.length} tracking number(s) in this delivery; retrying in case the shipment row has not landed yet.`,
      });
    }

    const completedAt = clock();
    log.info("fedex.webhook.worker.dispatched_success", {
      entryCount: entries.length,
      eventsDispatched: dispatched,
    });
    const updated = await deps.eventStore.markSucceeded(record.externalEventId, completedAt);
    return { status: "succeeded", record: updated };
  } catch (cause) {
    const failedAt = clock();
    const attempts = record.attempts;
    const nextAttemptAt = attempts >= maxAttempts ? null : computeNextAttemptAt(attempts, failedAt);

    log.error("fedex.webhook.worker.dispatched_failure", {
      attempts,
      willRetry: nextAttemptAt !== null,
      errorMessage: describeError(cause),
    });

    const updated = await deps.eventStore.markFailed({
      externalEventId: record.externalEventId,
      failedAt,
      errorMessage: describeError(cause),
      nextAttemptAt,
    });

    return { status: "failed", record: updated, retryScheduledFor: nextAttemptAt };
  }
}
