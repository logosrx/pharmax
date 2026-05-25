// Worker entry points for draining `easypost_webhook_event` rows.
//
// Two entry points are provided so the worker can choose its claim
// strategy (same pattern as the Stripe pipeline):
//
//   1. `processEasyPostWebhookEvent(externalEventId, deps)` — the
//      "look it up, mark it PROCESSING, dispatch, mark outcome"
//      pipeline. Used by admin "retry this event" actions and tests.
//
//   2. `executeEasyPostWebhookEventDispatch(record, deps)` — the
//      inner "dispatch + mark outcome" half. Used by the production
//      worker drain, which has ALREADY claimed the row atomically
//      (via a single UPDATE … FROM (SELECT … FOR UPDATE SKIP LOCKED)
//      statement) and therefore must NOT call `markProcessing` again
//      — doing so would double-increment `attempts`.
//
// Architectural split:
//   - This module deliberately does NOT call `withSystemContext`.
//     The cross-tenant shipment lookup (system-context read) is the
//     caller's responsibility — see
//     `apps/worker/src/drains/easypost-webhook-event-drainer.ts`,
//     which is the only legitimate "tenant-less → per-tenant
//     command" bridge for this pipeline. Keeping the bridge in the
//     worker layer keeps `@pharmax/shipping` free of the
//     system-context escape hatch.
//   - Once the caller provides `{ organizationId, shipmentId,
//     actorUserId }`, this module enters that org's tenancy context
//     and executes `RecordShipmentTrackingEvent` through the
//     standard command bus (RBAC + idempotency + audit + outbox
//     unchanged).
//   - Both layers of idempotency apply: the bus's per-command key
//     (`source:externalEventId`) and the DB unique constraint on the
//     `shipment_tracking_event` table.
//
// Domain handlers MUST be idempotent because the worker may retry on
// transient failure (DB deadlocks, downstream 5xx).

import { executeCommand } from "@pharmax/command-bus";
import { errors, type logger as loggerContract } from "@pharmax/platform-core";
import { buildTenancyContext, withTenancyContext } from "@pharmax/tenancy";
import { ulid } from "ulid";

import { normalizeEasyPostStatus } from "../carriers/easypost-status.js";
import { RecordShipmentTrackingEvent } from "../commands/record-shipment-tracking-event.js";

import { EasyPostWebhookEventNotFoundError } from "./errors.js";
import type { EasyPostWebhookEventRecord, EasyPostWebhookEventStore } from "./event-store.js";

type Logger = loggerContract.Logger;

export interface ResolvedWebhookTarget {
  readonly shipmentId: string;
  readonly organizationId: string;
  readonly actorUserId: string;
}

/**
 * Resolves an inbound webhook event to the tenant + actor that should
 * execute the domain command. Implementations are expected to perform
 * the system-context Postgres reads themselves; this module never
 * touches RLS bypass.
 *
 * Return `null` for an unknown tracking code — the dispatch then
 * marks the row SUCCEEDED with a log so the carrier stops retrying.
 */
export interface WebhookTargetResolver {
  resolve(payload: EasyPostWebhookEventRecord): Promise<ResolvedWebhookTarget | null>;
}

export interface ProcessEasyPostWebhookEventDeps {
  readonly eventStore: EasyPostWebhookEventStore;
  readonly targetResolver: WebhookTargetResolver;
  readonly logger: Logger;
  readonly clock?: () => Date;
  readonly maxAttempts?: number;
  readonly computeNextAttemptAt?: (attempt: number, now: Date) => Date | null;
}

export type ProcessEasyPostWebhookEventResult =
  | { readonly status: "succeeded"; readonly record: EasyPostWebhookEventRecord }
  | { readonly status: "ignored"; readonly record: EasyPostWebhookEventRecord }
  | {
      readonly status: "failed";
      readonly record: EasyPostWebhookEventRecord;
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

export async function processEasyPostWebhookEvent(
  externalEventId: string,
  deps: ProcessEasyPostWebhookEventDeps
): Promise<ProcessEasyPostWebhookEventResult> {
  const clock = deps.clock ?? (() => new Date());
  const log = deps.logger.child({
    component: "easypost.webhook.worker",
    externalEventId,
  });

  const existing = await deps.eventStore.findByExternalEventId(externalEventId);
  if (existing === null) {
    throw new EasyPostWebhookEventNotFoundError(externalEventId);
  }

  if (existing.status === "SUCCEEDED") {
    log.debug("easypost.webhook.worker.already_succeeded");
    return { status: "succeeded", record: existing };
  }

  if (existing.status === "IGNORED") {
    log.debug("easypost.webhook.worker.already_ignored");
    return { status: "ignored", record: existing };
  }

  const processing = await deps.eventStore.markProcessing(externalEventId, clock());
  return executeEasyPostWebhookEventDispatch(processing, deps);
}

export async function executeEasyPostWebhookEventDispatch(
  record: EasyPostWebhookEventRecord,
  deps: ProcessEasyPostWebhookEventDeps
): Promise<ProcessEasyPostWebhookEventResult> {
  const clock = deps.clock ?? (() => new Date());
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const computeNextAttemptAt = deps.computeNextAttemptAt ?? defaultBackoff;
  const log = deps.logger.child({
    component: "easypost.webhook.worker",
    externalEventId: record.externalEventId,
  });

  try {
    const trackingCode = record.payload.result.tracking_code;
    if (typeof trackingCode !== "string" || trackingCode.length === 0) {
      throw new errors.ValidationError({
        code: "EASYPOST_WEBHOOK_MISSING_TRACKING_CODE",
        message: "EasyPost webhook payload is missing result.tracking_code.",
      });
    }

    // The resolver is expected to do its own system-context read (the
    // tracking number is the only bridge from tenant-less webhook to
    // a tenant-scoped shipment row). Returning null means "unknown
    // shipment" — we ACK with SUCCEEDED so the carrier stops retrying.
    const target = await deps.targetResolver.resolve(record);
    if (target === null) {
      log.warn("easypost.webhook.worker.unknown_target", { trackingCode });
      const completedAt = clock();
      const updated = await deps.eventStore.markSucceeded(record.externalEventId, completedAt);
      return { status: "succeeded", record: updated };
    }

    // Enter the org's tenancy and execute the command. The bus runs
    // the full 20-step contract (idempotency, audit, outbox).
    const ctx = buildTenancyContext({
      organizationId: target.organizationId,
      actor: {
        userId: target.actorUserId,
        correlationId: ulid(),
      },
    });

    const normalizedKind = normalizeEasyPostStatus(record.payload.result.status);

    await withTenancyContext(ctx, async () => {
      await executeCommand(
        RecordShipmentTrackingEvent,
        {
          shipmentId: target.shipmentId,
          source: "EASYPOST",
          externalEventId: record.externalEventId,
          kind: normalizedKind,
          carrierStatus: record.payload.result.status,
          ...(typeof record.payload.result.status_detail === "string"
            ? { carrierStatusDetail: record.payload.result.status_detail }
            : {}),
          occurredAt: new Date(record.payload.result.updated_at).toISOString(),
          signatureVerifiedAt: record.signatureVerifiedAt.toISOString(),
          rawPayload: record.payload as unknown as Record<string, unknown>,
        },
        { idempotencyKey: `easypost:${record.externalEventId}` }
      );
    });

    const completedAt = clock();
    log.info("easypost.webhook.worker.dispatched_success", {
      organizationId: target.organizationId,
      shipmentId: target.shipmentId,
      kind: normalizedKind,
    });
    const updated = await deps.eventStore.markSucceeded(record.externalEventId, completedAt);
    return { status: "succeeded", record: updated };
  } catch (cause) {
    const failedAt = clock();
    const attempts = record.attempts;
    const nextAttemptAt = attempts >= maxAttempts ? null : computeNextAttemptAt(attempts, failedAt);

    log.error("easypost.webhook.worker.dispatched_failure", {
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
