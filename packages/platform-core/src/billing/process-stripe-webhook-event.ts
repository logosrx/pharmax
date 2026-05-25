// Worker entry points for draining `stripe_webhook_event` rows.
//
// Two entry points are provided so the worker can choose its claim
// strategy:
//
//   1. `processStripeWebhookEvent(stripeEventId, deps)` — the original
//      "look it up, mark it PROCESSING, dispatch, mark outcome" pipeline.
//      Used by admin "retry this event" actions and by tests.
//
//   2. `executeStripeWebhookEventDispatch(record, deps)` — the inner
//      "dispatch + mark outcome" half. Used by the production worker
//      drain, which has ALREADY claimed the row atomically (via a single
//      UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED) statement) and
//      therefore must NOT call `markProcessing` again — doing so would
//      double-increment `attempts`.
//
// Both paths share the same backoff / max-attempts policy so retry
// behavior is identical regardless of how the row was claimed.
//
// Domain handlers MUST be idempotent because the worker may retry on
// transient failure (network errors, deadlocks, downstream 5xx).

import type Stripe from "stripe";

import type { Logger } from "../logger/types.js";

import type { StripeWebhookEventDispatcher } from "./dispatcher.js";
import type { StripeWebhookEventRecord, StripeWebhookEventStore } from "./event-store.js";
import { StripeWebhookEventNotFoundError } from "./errors.js";

export interface ProcessStripeWebhookEventDeps {
  readonly eventStore: StripeWebhookEventStore;
  readonly dispatcher: StripeWebhookEventDispatcher;
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly maxAttempts?: number;
  readonly computeNextAttemptAt?: (attempt: number, now: Date) => Date | null;
}

export type ProcessStripeWebhookEventResult =
  | { readonly status: "succeeded"; readonly record: StripeWebhookEventRecord }
  | { readonly status: "ignored"; readonly record: StripeWebhookEventRecord }
  | {
      readonly status: "failed";
      readonly record: StripeWebhookEventRecord;
      readonly retryScheduledFor: Date | null;
    };

const DEFAULT_MAX_ATTEMPTS = 8;

function defaultBackoff(attempt: number, now: Date): Date | null {
  if (attempt >= DEFAULT_MAX_ATTEMPTS) {
    return null;
  }
  // Exponential backoff: 30s, 1m, 2m, 4m, 8m, 16m, 32m, 64m.
  const seconds = 30 * 2 ** (attempt - 1);
  return new Date(now.getTime() + seconds * 1000);
}

function describeError(cause: unknown): string {
  if (cause instanceof Error) {
    // Stack and message only — no payload echoing.
    return `${cause.name}: ${cause.message}`;
  }
  return "Unknown error";
}

export async function processStripeWebhookEvent(
  stripeEventId: string,
  deps: ProcessStripeWebhookEventDeps
): Promise<ProcessStripeWebhookEventResult> {
  const clock = deps.clock ?? (() => new Date());
  const log = deps.logger.child({
    component: "stripe.webhook.worker",
    stripeEventId,
  });

  const existing = await deps.eventStore.findByStripeEventId(stripeEventId);
  if (existing === null) {
    throw new StripeWebhookEventNotFoundError(stripeEventId);
  }

  if (existing.status === "SUCCEEDED") {
    log.debug("stripe.webhook.worker.already_succeeded");
    return { status: "succeeded", record: existing };
  }

  if (existing.status === "IGNORED") {
    log.debug("stripe.webhook.worker.already_ignored");
    return { status: "ignored", record: existing };
  }

  const processing = await deps.eventStore.markProcessing(stripeEventId, clock());
  return executeStripeWebhookEventDispatch(processing, deps);
}

/**
 * Inner half of {@link processStripeWebhookEvent}: dispatch a record
 * that the caller has ALREADY transitioned to PROCESSING (i.e.
 * `attempts` is already incremented and `processingStartedAt` is set).
 *
 * The production worker uses this directly because its atomic claim
 * (a single `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)`)
 * has already done the equivalent of `markProcessing` — calling it
 * again would double-increment `attempts`.
 */
export async function executeStripeWebhookEventDispatch(
  record: StripeWebhookEventRecord,
  deps: ProcessStripeWebhookEventDeps
): Promise<ProcessStripeWebhookEventResult> {
  const clock = deps.clock ?? (() => new Date());
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const computeNextAttemptAt = deps.computeNextAttemptAt ?? defaultBackoff;
  const log = deps.logger.child({
    component: "stripe.webhook.worker",
    stripeEventId: record.stripeEventId,
  });

  const event: Stripe.Event = record.payload;

  try {
    const dispatched = await deps.dispatcher.dispatch(event, {
      logger: log,
      receivedAt: record.receivedAt,
    });

    const completedAt = clock();

    if (!dispatched) {
      // Dispatcher decided this event should not run (unsupported type or
      // no handler registered). Treat as success so the row is not retried.
      log.info("stripe.webhook.worker.dispatched_noop", { eventType: event.type });
      const updated = await deps.eventStore.markSucceeded(record.stripeEventId, completedAt);
      return { status: "succeeded", record: updated };
    }

    log.info("stripe.webhook.worker.dispatched_success", { eventType: event.type });
    const updated = await deps.eventStore.markSucceeded(record.stripeEventId, completedAt);
    return { status: "succeeded", record: updated };
  } catch (cause) {
    const failedAt = clock();
    const attempts = record.attempts;
    const nextAttemptAt = attempts >= maxAttempts ? null : computeNextAttemptAt(attempts, failedAt);

    log.error("stripe.webhook.worker.dispatched_failure", {
      eventType: event.type,
      attempts,
      willRetry: nextAttemptAt !== null,
      // Do NOT include cause object directly; many error types serialize
      // request/response payloads which can leak headers or PHI-adjacent
      // metadata. A constructed string is safe.
      errorMessage: describeError(cause),
    });

    const updated = await deps.eventStore.markFailed({
      stripeEventId: record.stripeEventId,
      failedAt,
      errorMessage: describeError(cause),
      nextAttemptAt,
    });

    return { status: "failed", record: updated, retryScheduledFor: nextAttemptAt };
  }
}
